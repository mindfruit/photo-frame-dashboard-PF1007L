// The Board: a Vestaboard-style split-flap tab. Server side = sources -> cards -> selector -> grid, per screen.
//   config      settings.board_config (JSON): a source pool, type defaults, and one setup per screen/profile
//   sources     ./sources.js (fetch -> cards), refreshed on their own interval, last good cards kept on failure
//   selector    ./select.js (alert > personal > live/scheduled > ambient)
//   grid        ./charset.js (Vestaboard codes + colour markup), cached in board_cache for restarts/offline
// Frames: GET /api/board?screen=<id> after SSE change {topic:'board'}. Admin: #/flipboard (shown to people as “Flipboard”).
import crypto from 'node:crypto';
import { all, get, run, db, getSetting, setSetting } from '../db.js';
import { cache } from '../fetchers.js';
import * as CS from './charset.js';
import { select, newState, TYPES, TYPE_DEFAULTS } from './select.js';
import { KINDS, LINE_FORMATS } from './sources.js';

db.exec(`CREATE TABLE IF NOT EXISTS board_messages (  -- posted notes (admin / POST /api/board/message)
  id INTEGER PRIMARY KEY, text TEXT NOT NULL, screens TEXT NOT NULL DEFAULT 'all',  -- a screen id or 'all'
  sticky INTEGER NOT NULL DEFAULT 0, urgent INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS board_cache (  -- last good grid per screen (shown after a restart until sources answer)
  screen_id TEXT PRIMARY KEY, grid_json TEXT NOT NULL, card_json TEXT, rendered_at INTEGER NOT NULL,
  flip3d INTEGER, polled_at INTEGER);`);

const PALETTE_NAMES = ['standard', 'bright'];
const ACCENT_NAMES = ['', 'red', 'amber', 'soft', 'blue', 'green'];
const ALL_TABS = ['home', 'calendar', 'tasks', 'shopping', 'photos', 'control', 'agents', 'kids']; // what "no tabs picked" shows
export const SCREEN_DEFAULTS = {
  enabled: false, tab_after: '', grid: '22x6', cols: 22, rows: 6, flip: true, flip_cap: 8, palette: 'standard',
  full: true, // Full screen: on the Board tab the menu rail hides (a tap brings it back for a few seconds)
  types: { alert: true, personal: true, live: true, scheduled: true, ambient: true },
  weights: {}, // blank = the card type's default weight (admin › Flipboard › Card types)
  sources: {}
};

let H = { broadcast() {}, requirePin() { throw new Error('not started'); }, HttpError: Error, send() {} };
let http = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(10e3), headers: { 'User-Agent': 'home-dashboard-board/1' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(url).host);
  return r.json();
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const bad = (msg) => { throw new H.HttpError(400, msg); };

// ------------------------------------------------------------------ config
let CFG = null;
export function config() {
  if (CFG) return CFG;
  let c = {};
  try { c = JSON.parse(getSetting('board_config') || '{}') || {}; } catch {}
  c.sources = c.sources || {}; c.types = c.types || {}; c.screens = c.screens || {};
  return (CFG = c);
}
function save(c) { setSetting('board_config', JSON.stringify(c)); CFG = null; }
export function typeDefaults() {
  const t = config().types, out = {};
  for (const k of TYPES) out[k] = Object.assign({}, TYPE_DEFAULTS[k], t[k] || {});
  return out;
}
function screenCfg(id) {
  const s = config().screens[id] || {};
  return Object.assign(clone(SCREEN_DEFAULTS), s, { types: Object.assign({}, SCREEN_DEFAULTS.types, s.types), weights: Object.assign({}, SCREEN_DEFAULTS.weights, s.weights), sources: Object.assign({}, s.sources) });
}
function poolCfg(kind) { return Object.assign({ enabled: KINDS[kind].enabled }, config().sources[kind] || {}); }
const stable = (o) => JSON.stringify(o, Object.keys(o).sort());
// The sources a screen runs, with options = defaults < pool < this screen's overrides.
function screenSources(id) {
  const sc = screenCfg(id), out = [];
  for (const kind of Object.keys(KINDS)) {
    const p = poolCfg(kind), o = sc.sources[kind] || {};
    const on = o.on != null ? !!o.on : !!p.enabled;
    if (!on) continue;
    const opts = Object.assign({}, KINDS[kind].defaultOpts, p.opts || {}, o.opts || {});
    out.push({ kind, opts, hash: kind + ':' + stable(opts) });
  }
  return out;
}
const isProfile = (id) => /^profile:\d+$/.test(id);
function screenRow(id) { return isProfile(id) ? get('SELECT * FROM profiles WHERE id = ?', +id.slice(8)) : get('SELECT * FROM devices WHERE id = ?', id); }
function boardScreens() { return all('SELECT id FROM devices').map((d) => d.id).filter((id) => screenCfg(id).enabled); }

// ------------------------------------------------------------------ source results (shared by screens with the same options)
const store = new Map(); // hash -> { kind, opts, cards, at, error, running, state }
async function refresh(src, now, force) {
  let e = store.get(src.hash);
  if (!e) store.set(src.hash, (e = { kind: src.kind, opts: src.opts, cards: [], at: 0, error: null, running: false, state: {} }));
  const K = KINDS[src.kind];
  if (e.running || (!force && e.at && now - e.at < K.every * 1000)) return;
  e.running = true;
  const td = typeDefaults(), p = poolCfg(src.kind);
  try {
    const cards = await K.fetch({ opts: src.opts, cache, now, http, state: e.state, all, ttl: td.alert.ttl, home: { lat: getSetting('lat'), lon: getSetting('lon') }, key: getSetting('board_key_' + src.kind) });
    e.cards = (cards || []).map((c) => {
      const x = Object.assign({ type: K.type }, c, { source: src.kind });
      if (p.dwell && !c.dwell) x.dwell = +p.dwell;
      if (p.accent != null && p.accent !== '' && !c.accent) x.accent = p.accent;
      if (p.priority && !c.priority) x.priority = +p.priority;
      if (x.type === 'live' && !x.stale_after) x.stale_after = now + td.live.stale * 1000;
      return x;
    });
    e.error = null;
  } catch (err) { e.error = String(err.message || err); } // keep the last good cards
  e.at = now; e.running = false;
}
function postedCards(now) {
  const td = typeDefaults();
  return all('SELECT * FROM board_messages WHERE expires_at IS NULL OR expires_at > ? ORDER BY id', now).map((m) => ({
    type: m.sticky || m.urgent ? 'alert' : 'personal', key: 'post:' + m.id, lines: [m.text], screens: [m.screens], created: m.created_at,
    expires_at: m.expires_at || undefined, urgent: !!m.urgent, priority: m.priority, source: 'post',
    dwell: m.sticky || m.urgent ? td.alert.dwell : td.personal.dwell
  }));
}

// ------------------------------------------------------------------ compose
const states = new Map(), last = new Map(), flip3d = new Map();
function quietNow(id, now) {
  const d = !isProfile(id) && get('SELECT quiet_start, quiet_end FROM devices WHERE id = ?', id);
  const s = (d && d.quiet_start && d.quiet_end) ? d.quiet_start : getSetting('quiet_start'), e = (d && d.quiet_start && d.quiet_end) ? d.quiet_end : getSetting('quiet_end');
  if (!s || !e) return false;
  const n = new Date(now), m = n.getHours() * 60 + n.getMinutes(), a = +s.slice(0, 2) * 60 + +s.slice(3), b = +e.slice(0, 2) * 60 + +e.slice(3);
  return a > b ? (m >= a || m < b) : (m >= a && m < b);
}
function dims(sc) {
  if (sc.grid === 'custom') return { cols: Math.min(40, Math.max(8, +sc.cols || 22)), rows: Math.min(16, Math.max(2, +sc.rows || 6)) };
  return { cols: 22, rows: 6 };
}
export function compose(id, now = Date.now(), quiet) {
  const sc = screenCfg(id);
  if (!sc.enabled) return null;
  const td = typeDefaults(), st = states.get(id) || (states.set(id, newState()), states.get(id));
  const cards = postedCards(now);
  for (const s of screenSources(id)) { const e = store.get(s.hash); if (e) cards.push(...e.cards); }
  const q = quiet != null ? quiet : quietNow(id, now);
  const { card } = select(cards, st, now, { screen: id, types: sc.types, weights: sc.weights, quiet: q, defaults: td });
  const keys = new Set(cards.map((c) => c.key));
  for (const k of Object.keys(st.last)) if (!keys.has(k)) delete st.last[k]; // forget cards that are gone
  const { cols, rows } = dims(sc);
  const grid = card ? CS.layout(card.lines, cols, rows, card.align).grid : CS.layout([], cols, rows).grid;
  const accent = card ? (card.accent != null ? card.accent : td[card.type].accent || '') : '';
  return {
    screen: id, cols, rows, cells: grid, quiet: q,
    card: card ? { type: card.type, key: card.key, source: card.source, accent } : null,
    flip: !!sc.flip, flip_cap: Math.min(64, Math.max(1, +sc.flip_cap || 8)), palette: PALETTE_NAMES.includes(sc.palette) ? sc.palette : 'standard',
    full: sc.full !== false
  };
}
// Recompose every Board screen; returns the ids whose grid changed (those are cached + broadcast).
export function composeAll(now = Date.now()) {
  const changed = [];
  for (const id of boardScreens()) {
    const p = compose(id, now);
    if (!p) continue;
    const sig = JSON.stringify([p.cells, p.card && p.card.key, p.card && p.card.accent, p.flip, p.flip_cap, p.palette, p.full]);
    const prev = last.get(id);
    if (prev && prev.sig === sig) continue;
    p.at = now;
    last.set(id, { sig, payload: p });
    run(`INSERT INTO board_cache (screen_id, grid_json, card_json, rendered_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(screen_id) DO UPDATE SET grid_json = excluded.grid_json, card_json = excluded.card_json, rendered_at = excluded.rendered_at`,
      id, JSON.stringify(p.cells), JSON.stringify(Object.assign({}, p, { cells: undefined })), now);
    changed.push(id);
  }
  return changed;
}
let ticking = false;
export async function tick(now = Date.now(), force = false) {
  if (ticking) return [];
  ticking = true;
  try {
    const seen = new Set(), jobs = [];
    for (const id of boardScreens()) for (const s of screenSources(id)) if (!seen.has(s.hash)) { seen.add(s.hash); jobs.push(refresh(s, now, force)); }
    await Promise.all(jobs);
    for (const h of [...store.keys()]) if (!seen.has(h)) store.delete(h); // options changed / source off
    const changed = composeAll(now);
    if (changed.length) H.broadcast('board');
    return changed;
  } finally { ticking = false; }
}

// Frame payload: the live one, else the cached last good grid (after a restart), else compose now.
function payloadFor(id) {
  const sc = screenCfg(id);
  if (!sc.enabled) return { screen: id, enabled: false };
  let p = last.get(id) && last.get(id).payload;
  if (!p) {
    const c = get('SELECT * FROM board_cache WHERE screen_id = ?', id);
    if (c && c.card_json) { try { p = Object.assign(JSON.parse(c.card_json), { cells: JSON.parse(c.grid_json), cached: true }); } catch {} }
  }
  if (!p) p = compose(id);
  const pals = { [p.palette]: CS.PALETTES[p.palette], night: CS.PALETTES.night, 'night-red': CS.PALETTES['night-red'] };
  return Object.assign({ enabled: true }, p, { palettes: pals, accents: CS.ACCENTS });
}
export function screenInfo(id) { return { enabled: screenCfg(id).enabled }; }

// ------------------------------------------------------------------ tabs (devices.tabs / profiles.tabs)
function placeTab(id, enabled, after) {
  const row = screenRow(id);
  if (!row) return;
  let tabs = null;
  try { tabs = row.tabs ? JSON.parse(row.tabs) : null; } catch {}
  if (!enabled) { if (!tabs || tabs.indexOf('board') < 0) return; tabs = tabs.filter((t) => t !== 'board'); }
  else {
    if (!tabs) { if (!after) return; tabs = ALL_TABS.slice(); } // "everything" already shows the Board last
    tabs = tabs.filter((t) => t !== 'board');
    const i = after ? tabs.indexOf(after) : -1;
    tabs.splice(i < 0 ? tabs.length : i + 1, 0, 'board');
  }
  if (isProfile(id)) run('UPDATE profiles SET tabs = ? WHERE id = ?', JSON.stringify(tabs), +id.slice(8));
  else run('UPDATE devices SET tabs = ? WHERE id = ?', JSON.stringify(tabs), id);
}
// A profile's Board setup goes to the screen it's applied to (called from server/index.js applyProfile).
export function onApplyProfile(deviceId, profileId) {
  const c = config(), p = c.screens['profile:' + profileId];
  if (!p) return;
  c.screens[deviceId] = clone(p);
  save(c);
}

// ------------------------------------------------------------------ validation
function num(v, lo, hi, label) {
  const n = +v;
  if (v === '' || v == null || !Number.isFinite(n) || n < lo || n > hi) bad(label + ' must be a number from ' + lo + ' to ' + hi);
  return n;
}
function checkText(text, where) {
  const r = CS.check(text, 22, 6);
  if (r.errors.length) bad(where + ': ' + r.errors.join('; '));
}
function readOpts(kind, opts) {
  const K = KINDS[kind], out = {};
  for (const f of K.fields) {
    if (!(f.k in opts)) continue;
    let v = opts[f.k];
    if (f.type === 'lines') {
      if (typeof v === 'string') {
        const L = LINE_FORMATS[f.fmt];
        v = v.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return L.parse(l); } catch (e) { return bad(K.label + ': ' + e.message); } });
      }
      if (!Array.isArray(v)) bad(K.label + ': ' + f.label + ' must be a list');
      if (v.length > 50) bad(K.label + ': at most 50 lines');
      v.forEach((it, i) => { const t = it.text || it.message || it.label; if (t != null) checkText(t, K.label + ' line ' + (i + 1)); });
    } else if (f.type === 'number') v = v === '' || v == null ? undefined : num(v, 0, 100000, f.label);
    else if (f.type === 'check') v = !!v;
    else if (f.type === 'select') { if (!f.opts.some((o) => o[0] === v)) bad(f.label + ': unknown choice ' + v); }
    else v = String(v == null ? '' : v).slice(0, 80);
    if (v !== undefined) out[f.k] = v;
  }
  return out;
}
function readScreen(id, b, cur) {
  const s = Object.assign({}, cur);
  if ('enabled' in b) s.enabled = !!b.enabled;
  if ('tab_after' in b) s.tab_after = String(b.tab_after || '').slice(0, 64);
  if ('grid' in b) { if (!['22x6', 'custom'].includes(b.grid)) bad('Grid must be 22x6 or custom'); s.grid = b.grid; }
  if ('cols' in b) s.cols = num(b.cols, 8, 40, 'Columns');
  if ('rows' in b) s.rows = num(b.rows, 2, 16, 'Rows');
  if ('flip' in b) s.flip = !!b.flip;
  if ('full' in b) s.full = !!b.full;
  if ('flip_cap' in b) s.flip_cap = num(b.flip_cap, 1, 64, 'Flips at once');
  if ('palette' in b) { if (!PALETTE_NAMES.includes(b.palette)) bad('Colours must be standard or bright'); s.palette = b.palette; }
  if (b.types) { s.types = Object.assign({}, cur.types); for (const t of TYPES) if (t in b.types) s.types[t] = !!b.types[t]; }
  if (b.weights) {
    s.weights = Object.assign({}, cur.weights);
    for (const t of ['personal', 'live', 'scheduled', 'ambient']) if (t in b.weights) { if (b.weights[t] === '' || b.weights[t] == null) delete s.weights[t]; else s.weights[t] = num(b.weights[t], 0, 100, 'Weight (' + t + ')'); }
  }
  if (b.sources) {
    s.sources = Object.assign({}, cur.sources);
    for (const [k, v] of Object.entries(b.sources)) {
      if (!KINDS[k]) bad('Unknown source ' + k);
      const o = Object.assign({}, s.sources[k]);
      if ('on' in v) { if (v.on == null) delete o.on; else o.on = !!v.on; }
      if ('opts' in v) { if (v.opts == null) delete o.opts; else o.opts = readOpts(k, v.opts); }
      s.sources[k] = o;
    }
  }
  return s;
}

// ------------------------------------------------------------------ admin view
function maskKey(v) { return v ? '…' + String(v).slice(-4) : ''; }
function linesText(kind, opts) {
  const out = {};
  for (const f of KINDS[kind].fields) if (f.type === 'lines') out[f.k] = (opts[f.k] || []).map(LINE_FORMATS[f.fmt].format).join('\n');
  return out;
}
export function adminState(now = Date.now()) {
  const c = config(), td = typeDefaults();
  const status = {};
  for (const e of store.values()) {
    const s = status[e.kind] || (status[e.kind] = { cards: 0, error: null, at: 0 });
    s.cards += e.cards.length; s.error = s.error || e.error; s.at = Math.max(s.at, e.at);
  }
  const caches = Object.fromEntries(all('SELECT * FROM board_cache').map((r) => [r.screen_id, r]));
  const rows = all('SELECT id, name, tabs, last_seen FROM devices ORDER BY last_seen DESC').map((d) => ({ id: d.id, name: d.name || d.id, profile: false, tabs: d.tabs, last_seen: d.last_seen }))
    .concat(all('SELECT id, name, tabs FROM profiles ORDER BY id').map((p) => ({ id: 'profile:' + p.id, name: p.name + ' profile', profile: true, tabs: p.tabs })));
  return {
    kinds: Object.entries(KINDS).map(([k, K]) => ({ kind: k, label: K.label, type: K.type, notes: K.notes, needsKey: !!K.needsKey, every: K.every, fields: K.fields.map((f) => Object.assign({}, f, f.fmt ? { hint: LINE_FORMATS[f.fmt].hint } : {})),
      pool: Object.assign({}, poolCfg(k), { opts: Object.assign({}, K.defaultOpts, poolCfg(k).opts || {}) }), text: linesText(k, Object.assign({}, K.defaultOpts, poolCfg(k).opts || {})),
      key_set: !!getSetting('board_key_' + k), key: maskKey(getSetting('board_key_' + k)), status: status[k] || null })),
    types: td, typeBase: TYPE_DEFAULTS, palettes: PALETTE_NAMES, accents: ACCENT_NAMES,
    token_set: !!getSetting('board_token'), token: maskKey(getSetting('board_token')),
    messages: all('SELECT * FROM board_messages ORDER BY id DESC').map((m) => Object.assign(m, { type: m.sticky || m.urgent ? 'alert' : 'personal', expired: !!(m.expires_at && m.expires_at <= now) })),
    screens: rows.map((r) => {
      const sc = screenCfg(r.id), p = last.get(r.id), cc = caches[r.id];
      let tabs = null; try { tabs = r.tabs ? JSON.parse(r.tabs) : null; } catch {}
      const card = p ? p.payload.card : cc && cc.card_json ? JSON.parse(cc.card_json).card : null;
      return Object.assign(r, {
        cfg: sc, staticText: sc.sources.static && sc.sources.static.opts ? linesText('static', sc.sources.static.opts).items : null,
        inTabs: !tabs || tabs.indexOf('board') > -1, tabList: tabs || ALL_TABS,
        preview: sc.enabled ? CS.gridText(p ? p.payload.cells : cc ? JSON.parse(cc.grid_json) : compose(r.id, now).cells) : '',
        card, flip3d: flip3d.has(r.id) ? flip3d.get(r.id) : cc ? cc.flip3d : null, polled: cc ? cc.polled_at : null
      });
    })
  };
}

// ------------------------------------------------------------------ HTTP
let tokenFails = [];
function auth(req) {
  const h = String(req.headers.authorization || '');
  if (!/^Bearer\s+/i.test(h)) return H.requirePin(req);
  tokenFails = tokenFails.filter((t) => Date.now() - t < 10 * 60e3);
  if (tokenFails.length >= 10) throw new H.HttpError(429, 'Too many wrong tokens, try again in 10 minutes');
  const tok = getSetting('board_token'), got = h.replace(/^Bearer\s+/i, '').trim();
  const ok = tok && got.length === tok.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(tok));
  if (!ok) { tokenFails.push(Date.now()); throw new H.HttpError(401, tok ? 'Wrong board token' : 'No board token is set: use the parent PIN (X-PIN) or set a token in admin › Flipboard'); }
}
export function postMessage(b, now = Date.now()) {
  const text = String(b.text == null ? '' : b.text).trim();
  const screen = b.screen == null || b.screen === '' ? 'all' : String(b.screen);
  if (screen !== 'all' && !get('SELECT 1 FROM devices WHERE id = ?', screen)) bad('No such screen: ' + screen + ' (use a screen id or "all")');
  // check it fits the smallest board it goes to
  const ids = screen === 'all' ? boardScreens() : [screen];
  const d = ids.map((id) => dims(screenCfg(id))).reduce((a, x) => (x.cols * x.rows < a.cols * a.rows ? x : a), { cols: 22, rows: 6 });
  const r = CS.check(text, d.cols, d.rows);
  if (r.errors.length) bad(r.errors.join('; '));
  const td = typeDefaults(), sticky = !!b.sticky, urgent = !!b.urgent;
  let exp = null;
  if (!sticky) {
    const hrs = b.ttl_hours == null || b.ttl_hours === '' ? (urgent ? td.alert.ttl / 3600 : td.personal.ttl / 3600) : num(b.ttl_hours, 0.05, 720, 'ttl_hours');
    exp = now + Math.round(hrs * 3600e3);
  }
  const pr = b.priority == null || b.priority === '' ? 0 : num(b.priority, -10, 10, 'priority');
  const x = run('INSERT INTO board_messages (text, screens, sticky, urgent, priority, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', text, screen, sticky, urgent, pr, exp, now);
  return { id: Number(x.lastInsertRowid), type: sticky || urgent ? 'alert' : 'personal', rows: r.rows, expires_at: exp };
}

// Routes under /api/board. h = { send, requirePin, HttpError, broadcast } from server/index.js.
export async function api(req, res, url, parts, body) {
  const M = req.method, send = H.send;
  const done = (topic, extra) => { if (topic) H.broadcast(topic); tick(Date.now()).catch(() => {}); send(res, 200, Object.assign({ ok: true }, extra)); };
  if (M === 'GET' && !parts[1]) { // the frame (LAN, no PIN)
    const id = String(url.searchParams.get('screen') || '').slice(0, 64);
    if (!id) bad('screen is required');
    const f = url.searchParams.get('flip3d');
    if (f === '0' || f === '1') {
      if (flip3d.get(id) !== +f) run('INSERT INTO board_cache (screen_id, grid_json, rendered_at, flip3d, polled_at) VALUES (?, \'[]\', 0, ?, ?) ON CONFLICT(screen_id) DO UPDATE SET flip3d = excluded.flip3d, polled_at = excluded.polled_at', id, +f, Date.now());
      flip3d.set(id, +f);
    }
    return send(res, 200, payloadFor(id));
  }
  if (parts[1] === 'message') {
    auth(req);
    if (M === 'POST') { const r = postMessage(body); return done('board-config', r); }
    if (M === 'DELETE') {
      const n = parts[2] ? run('DELETE FROM board_messages WHERE id = ?', +parts[2]).changes
        : url.searchParams.get('screen') ? run('DELETE FROM board_messages WHERE screens = ?', url.searchParams.get('screen')).changes : run('DELETE FROM board_messages').changes;
      return done('board-config', { removed: Number(n) });
    }
  }
  H.requirePin(req);
  if (M === 'GET' && parts[1] === 'admin') return send(res, 200, adminState());
  if (M === 'PUT' && parts[1] === 'config') {
    const c = clone(config());
    if (body.sources) for (const [k, v] of Object.entries(body.sources)) {
      if (!KINDS[k]) bad('Unknown source ' + k);
      const o = Object.assign({}, c.sources[k]);
      if ('enabled' in v) o.enabled = !!v.enabled;
      if (v.opts) o.opts = Object.assign({}, o.opts, readOpts(k, v.opts));
      if ('dwell' in v) { if (v.dwell === '' || v.dwell == null) delete o.dwell; else o.dwell = num(v.dwell, 3, 3600, 'Dwell'); }
      if ('accent' in v) { if (!ACCENT_NAMES.includes(v.accent || '')) bad('Unknown accent ' + v.accent); if (v.accent) o.accent = v.accent; else delete o.accent; }
      if ('priority' in v) o.priority = v.priority === '' || v.priority == null ? 0 : num(v.priority, -10, 10, 'Priority');
      c.sources[k] = o;
    }
    if (body.types) for (const [t, v] of Object.entries(body.types)) {
      if (!TYPE_DEFAULTS[t]) bad('Unknown card type ' + t);
      const o = Object.assign({}, c.types[t]);
      for (const [k, val] of Object.entries(v)) {
        if (!(k in TYPE_DEFAULTS[t])) bad('Unknown ' + t + ' setting ' + k);
        if (k === 'accent') { if (!ACCENT_NAMES.includes(val || '')) bad('Unknown accent ' + val); o.accent = val; continue; }
        if (val === '' || val == null) { delete o[k]; continue; }
        o[k] = k === 'floor' ? num(val, 0, 1, t + ' floor') : num(val, 0, 30 * 86400, t + ' ' + k);
      }
      c.types[t] = o;
    }
    const placed = [];
    if (body.screens) for (const [id, v] of Object.entries(body.screens)) {
      if (!screenRow(id)) bad('No such screen: ' + id);
      const prev = c.screens[id] || {};
      c.screens[id] = readScreen(id, v, Object.assign(clone(SCREEN_DEFAULTS), prev));
      if ('enabled' in v || 'tab_after' in v) placed.push([id, c.screens[id].enabled, c.screens[id].tab_after]);
    }
    if (body.token) { if (String(body.token).length < 16) bad('Token must be at least 16 characters'); setSetting('board_token', String(body.token)); }
    if (body.clear_token) setSetting('board_token', null);
    if (body.keys) for (const [k, v] of Object.entries(body.keys)) { if (!KINDS[k] || !KINDS[k].needsKey) bad(k + ' doesn’t take a key'); if (v) setSetting('board_key_' + k, String(v).trim()); }
    if (body.clear_keys) for (const k of [].concat(body.clear_keys)) if (KINDS[k] && KINDS[k].needsKey) setSetting('board_key_' + k, null);
    save(c);
    for (const [id, en, after] of placed) placeTab(id, en, after);
    if (placed.length) H.broadcast('devices');
    return done('board-config');
  }
  if (M === 'POST' && parts[1] === 'copy') {
    const c = clone(config()), from = String(body.from || ''), to = String(body.to || '');
    if (!screenRow(from) || !screenRow(to)) bad('Pick two existing screens');
    const keep = c.screens[to] || {};
    c.screens[to] = Object.assign(clone(Object.assign({}, SCREEN_DEFAULTS, c.screens[from] || {})), { enabled: !!keep.enabled, tab_after: keep.tab_after || '' });
    save(c);
    return done('board-config');
  }
  if (M === 'POST' && parts[1] === 'token') { // make a random token, shown once
    const t = crypto.randomBytes(18).toString('base64url');
    setSetting('board_token', t);
    return done('board-config', { token: t });
  }
  throw new H.HttpError(404, 'Not found');
}

export function start(helpers, opts = {}) {
  H = Object.assign(H, helpers);
  if (opts.http) http = opts.http;
  if (opts.timer === false) return;
  tick(Date.now()).catch((e) => console.error('[board]', e));
  setInterval(() => tick(Date.now()).catch((e) => console.error('[board]', e)), 2000);
}
// for test.js
export const _t = { store, states, last, setHttp: (f) => { http = f; }, reset() { store.clear(); states.clear(); last.clear(); CFG = null; } };

// Home dashboard server: SQLite-backed JSON API, live updates over Server-Sent Events,
// background fetchers (weather / Google calendars / Home Assistant), and the built site.
//   node server/index.js        (PORT defaults to 3030)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { all, get, run, getSetting, setSetting } from './db.js';
import { cache, start, fetchWeather, fetchCalendars, fetchHA, geocode, callHA } from './fetchers.js';
import { buildState, ymd, haItems, isSecure, needsApproval, photoKey, linkKey, photoKeys } from './state.js';
import * as GP from './google-photos.js';
import * as ST from './storage.js';
import os from 'node:os';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, '..', 'dist');
// Photo files live in ST.dir() (env PHOTOS_DIR > admin setting > server/photos); see storage.js.

// ------------------------------------------------------------------ .env (optional)
// CAL_<NAME>=<secret iCal URL> lines are imported into the calendars table once.
const envFile = path.join(HERE, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[2]) continue;
    const [, key, val] = m;
    if (key.startsWith('CAL_') && /^(https?|webcal):\/\//.test(val)) {
      if (!get('SELECT 1 FROM calendars WHERE url = ?', val)) {
        const name = key.slice(4).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        const p = get('SELECT id FROM people WHERE lower(name) = lower(?)', name);
        run('INSERT INTO calendars (name, person_id, url) VALUES (?, ?, ?)', name, p ? p.id : null, val);
        console.log('Imported calendar from .env:', name);
      }
    } else if (!(key in process.env)) process.env[key] = val;
  }
}
const PORT = +process.env.PORT || 3030;

// ------------------------------------------------------------------ live updates (SSE)
const clients = new Set();
// The admin tab that made a write sends X-Client-Id; its id rides along on the event so only that tab treats it as its own.
const reqCtx = new AsyncLocalStorage();
function broadcast(topic) {
  const client = (reqCtx.getStore() || {}).client || '';
  // Photo-move progress ticks go out as their own event: only admin listens, so frames don't reload state for them.
  const msg = 'event: ' + (topic === 'storage-progress' ? 'storage' : 'change') + '\ndata: ' + JSON.stringify({ topic, at: Date.now(), client }) + '\n\n';
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25e3);

// ------------------------------------------------------------------ parent PIN
function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(String(pin), salt, 32).toString('hex');
}
let fails = [];
function pinOk(pin) {
  const stored = getSetting('pin_hash');
  if (!stored || !pin) return false;
  fails = fails.filter((t) => Date.now() - t < 10 * 60e3);
  if (fails.length >= 10) return false; // too many wrong guesses: wait 10 minutes
  const [salt] = stored.split(':');
  const ok = crypto.timingSafeEqual(Buffer.from(hashPin(pin, salt)), Buffer.from(stored));
  if (!ok) fails.push(Date.now());
  return ok;
}
// Kiosk exit PIN (the Android app's two-finger menu). Separate from the parent PIN: the kiosk checks it
// offline, so it gets {salt, pinHash} where pinHash = sha256(salt + ':' + pin), never the PIN itself.
function kioskHash(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.createHash('sha256').update(salt + ':' + String(pin)).digest('hex');
}
function kioskPinValue(v) {
  if (!/^\d{4,8}$/.test(String(v || ''))) throw new HttpError(400, 'Kiosk PIN must be 4–8 digits');
  return kioskHash(String(v));
}
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
function requirePin(req) {
  if (!getSetting('pin_hash')) throw new HttpError(403, 'Set a parent PIN in /admin first');
  if (fails.length >= 10) throw new HttpError(429, 'Too many wrong PINs, try again in 10 minutes');
  if (!pinOk(req.headers['x-pin'])) throw new HttpError(401, 'Parent PIN required');
}

// ------------------------------------------------------------------ helpers
function mask(s) {
  if (!s) return '';
  try { const u = new URL(s); return u.protocol + '//' + u.host + '/…' + s.slice(-6); } catch { return '…' + String(s).slice(-4); }
}
function readBody(req, limit = 15e6) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], over = false;
    // Too big: answer 413 right away and drop the rest (the client gets the reply instead of a reset connection); a sender
    // that keeps going is cut off 2 s later.
    req.on('data', (c) => { size += c.length; if (over) return; if (size > limit) { over = true; chunks = []; reject(new HttpError(413, 'Body too large')); setTimeout(() => req.destroy(), 2000).unref(); } else chunks.push(c); });
    req.on('end', () => {
      if (over) return;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}
function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// Plain CRUD tables: route name -> [table, editable columns, needs PIN?]
// Shopping and dashboard-added events are open so the frame can use them without a PIN.
const TABLES = {
  people: ['people', ['name', 'role', 'color', 'birthday', 'ha_entity', 'sort', 'show_tab', 'widgets', 'approval', 'bedtime', 'wake', 'wake_light', 'wake_color', 'bed_color'], true],
  photos: ['photos', ['date', 'person_id', 'artwork', 'caption', 'place', 'fav'], true],
  calendars: ['calendars', ['name', 'person_id', 'url'], true],
  routines: ['routines', ['name', 'from_h', 'to_h', 'sort'], true],
  chores: ['chores', ['person_id', 'routine_id', 'title', 'emoji', 'stars', 'days', 'active', 'sort'], true],
  rewards: ['rewards', ['title', 'emoji', 'cost', 'active'], true],
  stores: ['stores', ['name', 'cat_order', 'sort'], true],
  usuals: ['usuals', ['name'], true],
  devices: ['devices', ['name', 'tabs', 'default_tab', 'kid_lock', 'quiet_start', 'quiet_end', 'dim', 'profile_id', 'theme', 'night_style'], true],
  profiles: ['profiles', ['name', 'tabs', 'default_tab', 'kid_lock', 'quiet_start', 'quiet_end', 'dim', 'theme', 'night_style'], true],
  notes: ['notes', ['person_id', 'text', 'emoji', 'photo'], true],
  icons: ['icons', ['keyword', 'emoji'], true],
  countdowns: ['countdowns', ['title', 'emoji', 'date', 'person_id'], true],
  shopping: ['shopping', ['name', 'cat', 'qty', 'store_id', 'done', 'note'], false],
  'local-events': ['events', ['title', 'start', 'end', 'all_day', 'people', 'loc', 'notes'], false]
};
function pickCols(cols, body, table) {
  const out = {};
  for (const c of cols) {
    if (!(c in body)) continue;
    let v = body[c];
    if (v === '' && (/_id$/.test(c) || ['approval', 'bedtime', 'wake', 'birthday', 'ha_entity', 'wake_light', 'wake_color', 'bed_color', 'tabs', 'quiet_start', 'quiet_end'].includes(c))) v = null;
    if (Array.isArray(v) || (v && typeof v === 'object')) v = JSON.stringify(v);
    if (table === 'calendars' && c === 'url' && !v) continue; // blank = keep the stored secret
    out[c] = v;
  }
  return out;
}

// Photo sources a screen can pick from, with photo counts (albums removed but whose photos were kept stay listed)
function photoSources() {
  const n = {}, dup = {};
  for (const l of all('SELECT l.photo_id, l.source, l.source_id, EXISTS (SELECT 1 FROM photo_links o WHERE o.photo_id = l.photo_id AND o.id < l.id) AS d FROM photo_links l')) {
    const k = linkKey(l); n[k] = (n[k] || 0) + 1; if (l.d) dup[k] = (dup[k] || 0) + 1;
  }
  const out = [{ key: 'upload', name: 'Uploaded in admin', count: n.upload || 0, dups: dup.upload || 0 }, { key: 'picker', name: 'Picked from Google Photos', count: n.picker || 0, dups: dup.picker || 0 }];
  const seen = new Set();
  for (const a of all('SELECT id, title FROM google_albums ORDER BY id')) { seen.add('album:' + a.id); out.push({ key: 'album:' + a.id, name: 'Album: ' + (a.title || 'Shared album #' + a.id), count: n['album:' + a.id] || 0, dups: dup['album:' + a.id] || 0 }); }
  if (n.kept) out.push({ key: 'kept', name: 'Removed albums (photos kept)', count: n.kept, dups: dup.kept || 0 });
  return out;
}

// Look (see db.js): screen theme + per-source photo frame style. 'auto' = torn paper on the paper theme, plain otherwise.
const THEMES = ['default', 'paper'];
const FRAME_STYLES = ['auto', 'plain', 'polaroid', 'torn'];
const MAT_COLORS = ['#E8603C', '#F4A259', '#F7CF4D', '#6DBE7A', '#6AAFE6', '#AE8FDB', '#F49AC1']; // construction paper (pink: mats only)
function checkTheme(body) {
  if (!('theme' in body)) return;
  if (body.theme == null || body.theme === '') body.theme = 'default';
  if (!THEMES.includes(body.theme)) throw new HttpError(400, 'Look must be Default or Colored paper');
}
const NIGHT_STYLES = ['dim', 'red'];
function checkNight(body) {
  if (!('night_style' in body)) return;
  if (body.night_style == null || body.night_style === '') body.night_style = 'dim';
  if (!NIGHT_STYLES.includes(body.night_style)) throw new HttpError(400, 'Night style must be Dim or Warm red');
}
function matColor(key) { let h = 0; for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return MAT_COLORS[h % MAT_COLORS.length]; }
// Each photo's resolved frame style for a screen theme, from the source it's labelled with (p.src), plus its mat colour and album name.
function framePhotos(photos, theme) {
  const st = Object.fromEntries(all('SELECT source_key, style FROM photo_source_style').map((r) => [r.source_key, r.style]));
  const names = Object.fromEntries(all('SELECT id, title FROM google_albums').map((a) => ['album:' + a.id, a.title || '']));
  return photos.map((p) => {
    const s = st[p.src] || 'auto';
    // style = the source's own setting, so the frame can tell an explicit Plain (no polaroid slides) from Auto
    return Object.assign({}, p, { frame: s === 'auto' ? (theme === 'paper' ? 'torn' : 'plain') : s, style: s, mat: matColor(p.src), album: names[p.src] || '' });
  });
}

// Quiet hours: each end is HH:MM (00-23 / 00-59) or empty, and it's both ends or neither.
// cur = the stored pair, so sending just one field is checked against the other stored half.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
// Browsers/phones may send "21:30:00" or "7:00": normalize to HH:MM before checking.
function normTime(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  return m ? m[1].padStart(2, '0') + ':' + m[2] : String(v == null ? '' : v).trim();
}
function checkQuiet(body, cur) {
  if (!('quiet_start' in body) && !('quiet_end' in body)) return;
  for (const k of ['quiet_start', 'quiet_end']) if (k in body) body[k] = body[k] == null ? '' : normTime(body[k]);
  const val = (k) => (k in body ? body[k] : normTime(cur && cur[k])) || '';
  const s = String(val('quiet_start')).trim(), e = String(val('quiet_end')).trim();
  for (const [x, label] of [[s, 'Quiet from'], [e, 'Quiet until']]) if (x && !HHMM.test(x)) throw new HttpError(400, label + ' must be a time like 21:30 (hours 00–23, minutes 00–59)');
  if (!s !== !e) throw new HttpError(400, 'Quiet hours need both times (or clear both)');
}

// ------------------------------------------------------------------ admin view (secrets masked)
function adminState() {
  return {
    settings: {
      location: getSetting('location'), lat: getSetting('lat'), lon: getSetting('lon'), units: getSetting('units'),
      approval_required: getSetting('approval_required', '0') === '1',
      learning_items: getSetting('learning_items') || '', quiet_start: getSetting('quiet_start') || null, quiet_end: getSetting('quiet_end') || null,
      sounds_muted: getSetting('sounds_muted') === '1', family_goal_title: getSetting('family_goal_title') || '',
      family_goal_emoji: getSetting('family_goal_emoji') || '', family_goal_stars: getSetting('family_goal_stars') || '', ha_url: getSetting('ha_url') || '', ha_token: getSetting('ha_token') ? mask(getSetting('ha_token')) : '', ha_token_set: !!getSetting('ha_token'), kiosk_pin_set: !!getSetting('kiosk_pin_hash')
    },
    people: all('SELECT * FROM people ORDER BY sort, id').map((p) => ({ ...p, stars: get('SELECT COALESCE(SUM(delta),0) AS s FROM stars WHERE person_id = ?', p.id).s })),
    calendars: all('SELECT id, name, person_id, url, last_ok, last_error FROM calendars').map((c) => ({ ...c, url: mask(c.url) })),
    routines: all('SELECT * FROM routines ORDER BY sort'),
    chores: all('SELECT * FROM chores ORDER BY sort, id'),
    pending: all(`SELECT k.id, k.day, k.created_at, c.title, c.emoji, c.stars, COALESCE(k.by_person, c.person_id) AS person_id
      FROM completions k JOIN chores c ON c.id = k.chore_id WHERE k.status = 'pending' ORDER BY k.created_at`),
    rewardRequests: all("SELECT * FROM redemptions WHERE status = 'requested' ORDER BY id"),
    photoTotal: get('SELECT COUNT(*) AS n FROM photos').n, // the photos themselves are paged: GET /api/photos/list
    storage: ST.info(),
    google: GP.googleAdmin(),
    devices: all('SELECT * FROM devices ORDER BY last_seen DESC').map(({ kiosk_pin_hash, ...d }) => ({ ...d, kiosk_pin_set: !!kiosk_pin_hash })),
    photoSources: photoSources(),
    photoOff: all('SELECT * FROM screen_photo_off'),
    profiles: all('SELECT * FROM profiles ORDER BY id'),
    photoStyles: Object.fromEntries(all('SELECT source_key, style FROM photo_source_style').map((r) => [r.source_key, r.style])),
    feelings: all('SELECT * FROM feelings ORDER BY id DESC LIMIT 60'),
    notes: all('SELECT id, person_id, text, emoji, CASE WHEN photo IS NOT NULL AND photo != \'\' THEN 1 ELSE 0 END AS has_photo, created_at, hearted_at FROM notes ORDER BY id DESC LIMIT 50'),
    icons: all('SELECT * FROM icons ORDER BY keyword'),
    haEntities: all('SELECT * FROM ha_entities ORDER BY sort, entity_id'),
    ledger: all('SELECT * FROM stars ORDER BY id DESC LIMIT 50'),
    rewards: all('SELECT * FROM rewards ORDER BY cost'),
    redemptions: all('SELECT * FROM redemptions ORDER BY id DESC LIMIT 50'),
    stores: all('SELECT * FROM stores ORDER BY sort, id'),
    usuals: all('SELECT * FROM usuals ORDER BY id'),
    countdowns: all('SELECT * FROM countdowns ORDER BY date'),
    localEvents: all('SELECT * FROM events ORDER BY start'),
    errors: cache.errors,
    calendarEvents: cache.calendar.length
  };
}

function awardFor(compId) {
  const k = get('SELECT k.*, c.stars, c.person_id AS owner, c.title FROM completions k JOIN chores c ON c.id = k.chore_id WHERE k.id = ?', compId);
  if (!k) throw new HttpError(404, 'Not found');
  return k;
}
function approve(id) {
  const k = awardFor(id);
  if (k.status === 'approved') return;
  run("UPDATE completions SET status = 'approved', decided_at = CURRENT_TIMESTAMP WHERE id = ?", id);
  const earner = k.by_person != null ? k.by_person : k.owner;
  if (earner != null && k.stars) run('INSERT INTO stars (person_id, delta, reason, completion_id) VALUES (?, ?, ?, ?)', earner, k.stars, k.title, id);
}

// Map a dashboard tap to a Home Assistant service call: [domain, service, extra data]
function serviceFor(x, action, value) {
  const d = x.domain;
  if (action === 'level' && d === 'light') return +value > 0 ? ['light', 'turn_on', { brightness_pct: +value }] : ['light', 'turn_off'];
  if (action === 'temp' && d === 'climate') return ['climate', 'set_temperature', { temperature: +value }];
  if (d === 'lock') return action === 'unlock' ? ['lock', 'unlock'] : ['lock', 'lock'];
  if (d === 'cover') return action === 'open' ? ['cover', 'open_cover'] : action === 'close' ? ['cover', 'close_cover'] : ['cover', 'toggle'];
  if (d === 'alarm_control_panel') {
    const svc = { disarm: 'alarm_disarm', arm_home: 'alarm_arm_home', arm_away: 'alarm_arm_away', arm_night: 'alarm_arm_night' }[action];
    return svc ? ['alarm_control_panel', svc, value ? { code: String(value) } : {}] : null;
  }
  if (d === 'scene' || d === 'script') return [d, 'turn_on'];
  if (d === 'button' || d === 'input_button') return [d, 'press'];
  if (d === 'media_player') return ['media_player', 'media_play_pause'];
  if (['light', 'switch', 'fan', 'input_boolean', 'automation', 'siren', 'humidifier'].includes(d)) return ['homeassistant', 'toggle'];
  return null;
}

// ------------------------------------------------------------------ screens / devices
function applyProfile(id, p) {
  run('UPDATE devices SET profile_id = ?, tabs = ?, default_tab = ?, kid_lock = ?, quiet_start = ?, quiet_end = ?, dim = ?, theme = ?, night_style = ? WHERE id = ?',
    p.id, p.tabs, p.default_tab, p.kid_lock, p.quiet_start, p.quiet_end, p.dim, THEMES.includes(p.theme) ? p.theme : 'default', NIGHT_STYLES.includes(p.night_style) ? p.night_style : 'dim', id);
}
const seen = {};
function checkin(id, req, name) {
  id = String(id).slice(0, 64).replace(/[^\w.-]/g, '');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().replace(/^::ffff:/, '');
  if (!get('SELECT 1 FROM devices WHERE id = ?', id)) {
    run('INSERT INTO devices (id, name) VALUES (?, ?)', id, name || id);
    const fam = get("SELECT * FROM profiles WHERE name = 'Family'") || get('SELECT * FROM profiles ORDER BY id LIMIT 1');
    if (fam) applyProfile(id, fam);
    setTimeout(() => broadcast('devices'), 50);
  }
  if (!seen[id] || Date.now() - seen[id] > 60e3) { // don't write on every reload
    seen[id] = Date.now();
    run('UPDATE devices SET last_seen = ?, ip = ?, ua = ? WHERE id = ?', new Date().toISOString(), ip, String(req.headers['user-agent'] || '').slice(0, 200), id);
  }
  const d = get('SELECT * FROM devices WHERE id = ?', id);
  let tabs = null;
  try { tabs = d.tabs ? JSON.parse(d.tabs) : null; } catch {}
  return { id: d.id, name: d.name, tabs, defaultTab: d.default_tab || 'home', kidLock: !!d.kid_lock, quiet: { start: d.quiet_start || '', end: d.quiet_end || '' }, dim: d.dim == null ? 40 : d.dim, theme: THEMES.includes(d.theme) ? d.theme : 'default', nightStyle: NIGHT_STYLES.includes(d.night_style) ? d.night_style : 'dim' };
}

// ------------------------------------------------------------------ routes
async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean).slice(1); // after "api"
  const M = req.method;
  const body = M === 'GET' || M === 'HEAD' ? {} : await readBody(req, M === 'POST' && parts[0] === 'photos' && parts[1] === 'sync' ? 1e6 : 15e6); // sync: ids of the tiles on screen, 1 MB is plenty
  const ok = (topic, extra) => { if (topic) broadcast(topic); send(res, 200, { ok: true, ...extra }); };

  if (M === 'GET' && parts[0] === 'state') {
    const st = buildState();
    const id = url.searchParams.get('device');
    if (id) {
      st.device = checkin(id, req, url.searchParams.get('name'));
      const off = new Set(all('SELECT source_key FROM screen_photo_off WHERE screen_id = ?', st.device.id).map((r) => r.source_key));
      st.photos = st.photos.filter((p) => p.srcs.some((k) => !off.has(k))) // shown if ANY of its sources is on
        .map((p) => (off.has(p.src) ? Object.assign({}, p, { src: p.srcs.filter((k) => !off.has(k))[0] }) : p)); // label with a source this screen shows
    }
    st.photos = framePhotos(st.photos, st.device ? st.device.theme : 'default'); // + each photo's frame style for this screen
    // Photo folder unavailable (unplugged drive): show only the pictures whose files can still be read.
    // (No demo pictures anywhere: the server never contacts an image host; an empty library shows "Add photos in the admin".)
    if (!ST.check()) st.photos = st.photos.filter((p) => fs.existsSync(ST.fileOf(p.seed)));
    return send(res, 200, st);
  }
  // Kiosk app config (LAN, no parent PIN): the exit-PIN hash for this screen, or {pin:null} when none is set.
  if (M === 'GET' && parts[0] === 'kiosk' && parts[1] === 'config') {
    const id = String(url.searchParams.get('device') || '').slice(0, 64);
    const d = id ? get('SELECT kiosk_pin_hash, kiosk_lockout_reset_at FROM devices WHERE id = ?', id) : null;
    const h = (d && d.kiosk_pin_hash) || getSetting('kiosk_pin_hash');
    // lockoutResetAt: newest 'Clear lockout' (global or this screen); the kiosk ends any cooldown when it changes.
    const lockoutResetAt = Math.max(+getSetting('kiosk_lockout_reset_at') || 0, (d && d.kiosk_lockout_reset_at) || 0) || null;
    if (!h) return send(res, 200, { pin: null, lockoutResetAt });
    const [salt, pinHash] = h.split(':');
    return send(res, 200, { pin: true, salt, pinHash, scope: d && d.kiosk_pin_hash ? 'device' : 'global', lockoutResetAt });
  }
  if (M === 'POST' && parts[0] === 'kiosk' && parts[1] === 'clear-lockout') { // global: every kiosk
    requirePin(req);
    setSetting('kiosk_lockout_reset_at', String(Date.now()));
    return ok('settings');
  }
  if (M === 'POST' && parts[0] === 'devices' && parts[2] === 'kiosk-clear-lockout') {
    requirePin(req);
    if (!get('SELECT 1 FROM devices WHERE id = ?', parts[1])) throw new HttpError(404, 'No such screen');
    run('UPDATE devices SET kiosk_lockout_reset_at = ? WHERE id = ?', Date.now(), parts[1]);
    return ok('devices');
  }
  if (M === 'PUT' && parts[0] === 'devices' && parts[2] === 'kiosk-pin') {
    requirePin(req);
    if (!get('SELECT 1 FROM devices WHERE id = ?', parts[1])) throw new HttpError(404, 'No such screen');
    run('UPDATE devices SET kiosk_pin_hash = ? WHERE id = ?', body.clear ? null : kioskPinValue(body.pin), parts[1]);
    return ok('devices');
  }
  if (M === 'PUT' && parts[0] === 'devices' && parts[2] === 'photo-sources') {
    requirePin(req);
    const off = Array.isArray(body.off) ? [...new Set(body.off.map(String).filter((k) => /^(upload|picker|demo|kept|album:\d+)$/.test(k)))] : [];
    run('DELETE FROM screen_photo_off WHERE screen_id = ?', parts[1]);
    for (const k of off) run('INSERT INTO screen_photo_off (screen_id, source_key) VALUES (?, ?)', parts[1], k);
    return ok('photos');
  }
  // Frame style of one photo source (admin Photos › Frame styles): { key, style }; 'auto' removes the override.
  if (M === 'PUT' && parts[0] === 'photo-styles') {
    requirePin(req);
    const key = String(body.key || ''), style = String(body.style || 'auto');
    if (!/^(upload|picker|kept|album:\d+)$/.test(key)) throw new HttpError(400, 'Unknown photo source');
    if (!FRAME_STYLES.includes(style)) throw new HttpError(400, 'Frame style must be Auto, Plain, Polaroid or Torn paper');
    if (style === 'auto') run('DELETE FROM photo_source_style WHERE source_key = ?', key);
    else run('INSERT INTO photo_source_style (source_key, style) VALUES (?, ?) ON CONFLICT(source_key) DO UPDATE SET style = excluded.style', key, style);
    return ok('photos');
  }
  if (M === 'POST' && parts[0] === 'devices' && parts[2] === 'apply-profile') {
    requirePin(req);
    const p = get('SELECT * FROM profiles WHERE id = ?', body.profile_id);
    if (!p) throw new HttpError(404, 'No such profile');
    applyProfile(parts[1], p);
    return ok('devices');
  }
  if (M === 'GET' && parts[0] === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\nevent: hello\ndata: {}\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (M === 'GET' && parts[0] === 'health') return send(res, 200, { ok: true, clients: clients.size, errors: cache.errors });

  // --- PIN
  if (parts[0] === 'auth') {
    if (M === 'GET') return send(res, 200, { pinSet: !!getSetting('pin_hash') });
    if (parts[1] === 'setup') {
      if (getSetting('pin_hash')) throw new HttpError(403, 'PIN already set');
      if (!/^\d{4,8}$/.test(String(body.pin || ''))) throw new HttpError(400, 'PIN must be 4–8 digits');
      setSetting('pin_hash', hashPin(body.pin));
      return ok();
    }
    if (fails.length >= 10) throw new HttpError(429, 'Too many wrong PINs, try again in 10 minutes');
    return pinOk(body.pin) ? ok() : send(res, 401, { error: 'Wrong PIN' });
  }

  // --- kid actions (no PIN): mark a chore done (pending approval) / undo a pending one
  if (parts[0] === 'chores' && parts[2] === 'complete') {
    const chore = get('SELECT * FROM chores WHERE id = ?', parts[1]);
    if (!chore) throw new HttpError(404, 'No such chore');
    const today = ymd(new Date());
    if (M === 'POST') {
      const by = body.by != null && body.by !== 'any' ? +body.by : null;
      run(`INSERT INTO completions (chore_id, day, by_person, status) VALUES (?, ?, ?, 'pending')
        ON CONFLICT(chore_id, day) DO UPDATE SET status = 'pending', by_person = excluded.by_person, decided_at = NULL
        WHERE completions.status = 'rejected'`, chore.id, today, by);
      const k = get('SELECT * FROM completions WHERE chore_id = ? AND day = ?', chore.id, today);
      const earner = by != null ? by : chore.person_id;
      const who = earner != null ? get('SELECT role FROM people WHERE id = ?', earner) : null;
      // approve right away unless approvals are on for this kid (global setting or per-person override)
      if (k.status === 'pending' && (!chore.stars || (who && who.role === 'parent') || !needsApproval(earner))) approve(k.id);
      return ok('chores');
    }
    if (M === 'DELETE') {
      const k = get('SELECT * FROM completions WHERE chore_id = ? AND day = ?', chore.id, today);
      if (!k) return ok();
      if (k.status === 'approved' && chore.stars) requirePin(req);
      run('DELETE FROM stars WHERE completion_id = ?', k.id);
      run('DELETE FROM completions WHERE id = ?', k.id);
      return ok('chores');
    }
  }
  if (M === 'POST' && parts[0] === 'shopping' && parts[1] === 'clear-done') {
    run('DELETE FROM shopping WHERE done = 1');
    return ok('shopping');
  }

  // --- parent-only
  if (M === 'GET' && parts[0] === 'admin') { requirePin(req); return send(res, 200, adminState()); }
  if (M === 'PUT' && parts[0] === 'settings') {
    requirePin(req);
    checkQuiet(body, { quiet_start: getSetting('quiet_start'), quiet_end: getSetting('quiet_end') });
    if (body.location && body.location !== getSetting('location')) {
      const g = await geocode(body.location).catch((e) => { throw new HttpError(400, e.message); });
      setSetting('location', body.location); setSetting('lat', g.lat); setSetting('lon', g.lon);
    }
    if ('approval_required' in body) setSetting('approval_required', body.approval_required ? '1' : '0');
    for (const k of ['quiet_start', 'quiet_end']) if (k in body) setSetting(k, body[k] ? String(body[k]).trim() : null);
    if ('sounds_muted' in body) setSetting('sounds_muted', body.sounds_muted ? '1' : '0');
    if ('learning_items' in body) setSetting('learning_items', String(body.learning_items || ''));
    for (const k of ['family_goal_title', 'family_goal_emoji', 'family_goal_stars']) if (k in body) setSetting(k, body[k] === '' ? null : String(body[k]));
    if (body.units === 'fahrenheit' || body.units === 'celsius') setSetting('units', body.units);
    if ('ha_url' in body) setSetting('ha_url', body.ha_url ? String(body.ha_url).trim() : null);
    if (body.ha_token) setSetting('ha_token', String(body.ha_token).trim());
    if (body.clear_ha_token) setSetting('ha_token', null);
    if (body.kiosk_pin) setSetting('kiosk_pin_hash', kioskPinValue(body.kiosk_pin));
    else if (body.clear_kiosk_pin) setSetting('kiosk_pin_hash', null);
    if (body.new_pin) {
      if (!/^\d{4,8}$/.test(String(body.new_pin))) throw new HttpError(400, 'PIN must be 4–8 digits');
      setSetting('pin_hash', hashPin(body.new_pin));
    }
    await Promise.all([fetchWeather(), fetchHA()]);
    return ok('settings');
  }
  if (M === 'POST' && parts[0] === 'completions') {
    requirePin(req);
    if (parts[1] === 'approve-all') {
      for (const k of all("SELECT id FROM completions WHERE status = 'pending'")) approve(k.id);
    } else if (parts[2] === 'approve') approve(+parts[1]);
    else if (parts[2] === 'reject') run("UPDATE completions SET status = 'rejected', decided_at = CURRENT_TIMESTAMP WHERE id = ?", parts[1]);
    else throw new HttpError(404, 'Unknown action');
    return ok('chores');
  }
  if (M === 'POST' && parts[0] === 'stars') {
    requirePin(req);
    if (!body.person_id || !Number.isInteger(+body.delta)) throw new HttpError(400, 'person_id and delta required');
    run('INSERT INTO stars (person_id, delta, reason) VALUES (?, ?, ?)', body.person_id, +body.delta, body.reason || 'Adjustment');
    return ok('chores');
  }
  if (M === 'POST' && parts[0] === 'redeem') {
    requirePin(req);
    const r = get('SELECT * FROM rewards WHERE id = ?', body.reward_id);
    if (!r) throw new HttpError(404, 'No such reward');
    const bal = get('SELECT COALESCE(SUM(delta),0) AS s FROM stars WHERE person_id = ?', body.person_id).s;
    if (bal < r.cost) throw new HttpError(400, 'Not enough stars (' + bal + ' of ' + r.cost + ')');
    const x = run('INSERT INTO redemptions (reward_id, person_id, title, cost) VALUES (?, ?, ?, ?)', r.id, body.person_id, r.title, r.cost);
    run('INSERT INTO stars (person_id, delta, reason, redemption_id) VALUES (?, ?, ?, ?)', body.person_id, -r.cost, r.emoji + ' ' + r.title, x.lastInsertRowid);
    return ok('chores');
  }
  if (M === 'POST' && parts[0] === 'refresh') {
    requirePin(req);
    await Promise.all([fetchWeather(), fetchCalendars(), fetchHA()]);
    return ok(null, { errors: cache.errors });
  }
  // --- kid widgets (no PIN): feelings check-in, pick a star-jar goal, heart a parent's note
  if (M === 'POST' && parts[0] === 'feelings') {
    const ok5 = ['happy', 'sad', 'mad', 'tired', 'silly'];
    if (!ok5.includes(body.feeling) || !get('SELECT 1 FROM people WHERE id = ?', body.person_id)) throw new HttpError(400, 'Bad feeling');
    run('INSERT INTO feelings (person_id, feeling) VALUES (?, ?)', body.person_id, body.feeling);
    return ok('feelings');
  }
  if (M === 'POST' && parts[0] === 'people' && parts[2] === 'goal') {
    if (body.reward_id && !get('SELECT 1 FROM rewards WHERE id = ?', body.reward_id)) throw new HttpError(404, 'No such reward');
    run('UPDATE people SET goal_reward_id = ? WHERE id = ?', body.reward_id || null, parts[1]);
    return ok('people');
  }
  if (M === 'POST' && parts[0] === 'notes' && parts[2] === 'heart') {
    run('UPDATE notes SET hearted_at = CURRENT_TIMESTAMP WHERE id = ? AND hearted_at IS NULL', parts[1]);
    return ok('notes');
  }

  // --- rewards: a kid asks for one (no PIN); parents approve if approvals are on
  if (M === 'POST' && parts[0] === 'rewards' && parts[2] === 'request') {
    const r = get('SELECT * FROM rewards WHERE id = ? AND active = 1', parts[1]);
    const p = get('SELECT * FROM people WHERE id = ?', body.person_id);
    if (!r || !p) throw new HttpError(404, 'Not found');
    const bal = get('SELECT COALESCE(SUM(delta),0) AS s FROM stars WHERE person_id = ?', p.id).s;
    if (bal < r.cost) throw new HttpError(400, 'Not enough stars yet (' + bal + ' of ' + r.cost + ')');
    if (needsApproval(p.id)) {
      run("INSERT INTO redemptions (reward_id, person_id, title, cost, status) VALUES (?, ?, ?, ?, 'requested')", r.id, p.id, r.title, r.cost);
      return ok('chores', { status: 'requested' });
    }
    const x = run('INSERT INTO redemptions (reward_id, person_id, title, cost) VALUES (?, ?, ?, ?)', r.id, p.id, r.title, r.cost);
    run('INSERT INTO stars (person_id, delta, reason, redemption_id) VALUES (?, ?, ?, ?)', p.id, -r.cost, r.emoji + ' ' + r.title, x.lastInsertRowid);
    return ok('chores', { status: 'approved' });
  }
  if (M === 'POST' && parts[0] === 'redemptions') {
    requirePin(req);
    const x = get("SELECT * FROM redemptions WHERE id = ? AND status = 'requested'", parts[1]);
    if (!x) throw new HttpError(404, 'No such request');
    if (parts[2] === 'approve') {
      const bal = get('SELECT COALESCE(SUM(delta),0) AS s FROM stars WHERE person_id = ?', x.person_id).s;
      if (bal < x.cost) throw new HttpError(400, 'Not enough stars (' + bal + ' of ' + x.cost + ')');
      run("UPDATE redemptions SET status = 'approved' WHERE id = ?", x.id);
      run('INSERT INTO stars (person_id, delta, reason, redemption_id) VALUES (?, ?, ?, ?)', x.person_id, -x.cost, x.title, x.id);
    } else run("UPDATE redemptions SET status = 'denied' WHERE id = ?", x.id);
    return ok('chores');
  }

  // --- Home Assistant: pick entities (PIN) and control them from the frame
  if (parts[0] === 'ha' && parts[1] === 'entities') {
    requirePin(req);
    if (M === 'GET') {
      if (!getSetting('ha_url') || !getSetting('ha_token')) return send(res, 200, { configured: false, entities: [], groups: [], areas: {} });
      await fetchHA();
      if (!cache.ha) return send(res, 200, { configured: true, error: cache.errors.ha || 'Could not reach Home Assistant', entities: [], groups: [], areas: {} });
      const chosen = Object.fromEntries(all('SELECT * FROM ha_entities').map((r) => [r.entity_id, r]));
      const areas = cache.ha.areas || {};
      const entityArea = cache.ha.entityArea || {};
      const entities = Object.entries(cache.ha.states).map(([id, s]) => {
        const ch = chosen[id];
        const haArea = entityArea[id] || null;
        const groupId = ch && ch.group_id ? ch.group_id : (haArea || '_other');
        return {
          id, domain: id.split('.')[0], name: (s.attributes && s.attributes.friendly_name) || id, state: s.state,
          unit: (s.attributes && s.attributes.unit_of_measurement) || '',
          deviceClass: (s.attributes && s.attributes.device_class) || '',
          mode: ch ? ch.mode : 'off', label: ch ? ch.label || '' : '',
          sort: ch && ch.sort != null ? ch.sort : 0,
          haArea, groupId,
          groupOverride: !!(ch && ch.group_id),
          cardId: ch && ch.card_id ? ch.card_id : null,
          cardPrimary: !!(ch && ch.card_primary)
        };
      }).sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
      const enabled = entities.filter((e) => e.mode !== 'off').map((e) => ({
        id: e.id, mode: e.mode, groupId: e.groupId, cardId: e.cardId, cardPrimary: e.cardPrimary, sort: e.sort
      }));
      // Build group list: HA areas + custom overrides + Other if needed
      const gRows = Object.fromEntries(all('SELECT * FROM ha_groups').map((g) => [g.id, g]));
      const used = {};
      for (const e of entities) if (e.mode !== 'off') used[e.groupId] = true;
      for (const id of Object.keys(areas)) used[id] = used[id] || false; // list all HA areas for move-target
      const groupIds = new Set([...Object.keys(areas), ...Object.keys(gRows), ...Object.keys(used).filter((k) => used[k]), '_other']);
      // Always include custom groups from overrides even if empty
      for (const id of Object.keys(gRows)) groupIds.add(id);
      const groups = [...groupIds].map((id) => ({
        id,
        name: (gRows[id] && gRows[id].name) || areas[id] || (id === '_other' ? 'Other' : id.replace(/^c_/, '').replace(/_/g, ' ')),
        sort: gRows[id] && gRows[id].sort != null ? +gRows[id].sort : (id === '_other' ? 9000 : 1000),
        fromHa: !!areas[id],
        renamed: !!(gRows[id] && gRows[id].name),
        custom: String(id).startsWith('c_')
      })).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
      return send(res, 200, { configured: true, entities, groups, areas, enabled });
    }
    if (M === 'PUT' && parts[2]) {
      const id = decodeURIComponent(parts[2]);
      if (!/^[a-z_]+\.[\w-]+$/.test(id)) throw new HttpError(400, 'Bad entity id');
      if (!body.mode || body.mode === 'off') run('DELETE FROM ha_entities WHERE entity_id = ?', id);
      else {
        const mode = body.mode === 'sensor' ? 'sensor' : 'control';
        const prev = get('SELECT * FROM ha_entities WHERE entity_id = ?', id);
        // group_id / card_* only change when the client sends those keys (admin mode/label saves stay put).
        const groupId = !('group_id' in body) ? (prev ? prev.group_id : null)
          : (body.group_id === '' || body.group_id == null ? null : String(body.group_id).slice(0, 64));
        const cardId = !('card_id' in body) ? (prev ? prev.card_id : null)
          : (body.card_id === '' || body.card_id == null ? null : String(body.card_id).slice(0, 64));
        const cardPrimary = !('card_primary' in body) ? (prev && prev.card_primary ? 1 : 0) : (body.card_primary ? 1 : 0);
        run(`INSERT INTO ha_entities (entity_id, mode, label, sort, group_id, card_id, card_primary) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_id) DO UPDATE SET mode = excluded.mode, label = excluded.label,
            sort = COALESCE(excluded.sort, ha_entities.sort),
            group_id = excluded.group_id, card_id = excluded.card_id, card_primary = excluded.card_primary`,
          id, mode, body.label || null, body.sort != null ? +body.sort : (prev ? prev.sort : null),
          groupId, cardId, cardPrimary);
      }
      return ok('home');
    }
  }
  // Rename / reorder area groups (PIN)
  if (parts[0] === 'ha' && parts[1] === 'groups') {
    requirePin(req);
    if (M === 'PUT') {
      const list = Array.isArray(body.groups) ? body.groups : [];
      for (const g of list) {
        const id = String(g.id || '').slice(0, 64);
        if (!id) continue;
        const name = g.name != null && String(g.name).trim() ? String(g.name).trim().slice(0, 80) : null;
        const sort = g.sort != null ? +g.sort : 0;
        run(`INSERT INTO ha_groups (id, name, sort) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET name = excluded.name, sort = excluded.sort`, id, name, sort);
      }
      return ok('home');
    }
    if (M === 'POST') {
      // Create a custom group
      const id = 'c_' + crypto.randomBytes(4).toString('hex');
      const name = String(body.name || 'New group').trim().slice(0, 80) || 'New group';
      const sort = body.sort != null ? +body.sort : 500;
      run('INSERT INTO ha_groups (id, name, sort) VALUES (?, ?, ?)', id, name, sort);
      return ok('home', { id, name, sort });
    }
    if (M === 'DELETE' && parts[2]) {
      const id = decodeURIComponent(parts[2]);
      if (!String(id).startsWith('c_')) throw new HttpError(400, 'Only custom groups can be deleted');
      run('DELETE FROM ha_groups WHERE id = ?', id);
      run("UPDATE ha_entities SET group_id = NULL WHERE group_id = ?", id);
      return ok('home');
    }
  }
  // Compose / clear a multi-sensor card (PIN)
  if (M === 'PUT' && parts[0] === 'ha' && parts[1] === 'card') {
    requirePin(req);
    const memberIds = Array.isArray(body.entities) ? body.entities.map(String) : [];
    const primary = body.primary ? String(body.primary) : (memberIds[0] || null);
    if (!memberIds.length) {
      // clear card_id on listed clear list
      const clear = Array.isArray(body.clear) ? body.clear.map(String) : [];
      for (const id of clear) run('UPDATE ha_entities SET card_id = NULL, card_primary = 0 WHERE entity_id = ?', id);
      return ok('home');
    }
    const cardId = body.card_id ? String(body.card_id).slice(0, 64) : ('card_' + crypto.randomBytes(3).toString('hex'));
    for (const id of memberIds) {
      const row = get('SELECT * FROM ha_entities WHERE entity_id = ?', id);
      if (!row) continue;
      run('UPDATE ha_entities SET card_id = ?, card_primary = ? WHERE entity_id = ?', cardId, id === primary ? 1 : 0, id);
    }
    return ok('home', { card_id: cardId });
  }
  if (M === 'POST' && parts[0] === 'ha' && parts[1] === 'act') {
    const item = haItems().find((x) => x.id === body.entity_id && x.mode === 'control');
    if (!item) throw new HttpError(403, 'That device is not enabled for the dashboard');
    if (item.secure) requirePin(req);
    const call = serviceFor(item, body.action, body.value);
    if (!call) throw new HttpError(400, 'Unsupported action');
    await callHA(call[0], call[1], Object.assign({ entity_id: item.id }, call[2] || {})).catch((e) => { throw new HttpError(502, e.message); });
    return ok();
  }
  if (M === 'POST' && parts[0] === 'ha' && parts[1] === 'service') {
    requirePin(req);
    await callHA(body.domain, body.service, body.data).catch((e) => { throw new HttpError(502, e.message); });
    return ok();
  }

  // --- Google Photos (see google-photos.js). The OAuth callback has no PIN; the one-time state guards it.
  if (parts[0] === 'google') {
    if (M === 'GET' && parts[1] === 'callback') {
      let msg = 'Google Photos connected. You can close this tab and go back to the admin page.';
      try { await GP.finishAuth(url.searchParams.get('code'), url.searchParams.get('state')); } catch (e) { msg = 'Couldn’t connect: ' + e.message; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><meta name="viewport" content="width=device-width"><p style="font:16px system-ui;padding:24px">' + msg.replace(/</g, '&lt;') + '</p>');
    }
    requirePin(req);
    if (M === 'PUT' && parts[1] === 'client') {
      if ('client_id' in body) setSetting('google_client_id', String(body.client_id || '').trim() || null);
      if (body.client_secret) setSetting('google_client_secret', String(body.client_secret).trim());
      return ok('photos');
    }
    if (M === 'POST' && parts[1] === 'auth') { try { return ok(null, { url: GP.authUrl() }); } catch (e) { throw new HttpError(400, e.message); } }
    if (M === 'POST' && parts[1] === 'finish') { // pasted "http://localhost:3030/api/google/callback?..." address
      let u; try { u = new URL(String(body.url || '').trim()); } catch { throw new HttpError(400, 'Paste the whole address from the browser bar'); }
      await GP.finishAuth(u.searchParams.get('code'), u.searchParams.get('state')).catch((e) => { throw new HttpError(400, e.message); });
      return ok('photos');
    }
    if (M === 'POST' && parts[1] === 'disconnect') { if (body.photos && ST.pausedNow()) throw new HttpError(503, ST.paused()); GP.disconnect(); if (body.photos) { GP.removeSource('google-picker'); GP.forget('google-picker'); } return ok('photos'); }
    if (M === 'POST' && parts[1] === 'pick') { const p = await GP.startPick().catch((e) => { throw new HttpError(502, e.message); }); return ok('photos', { uri: p.uri }); }
    if (M === 'POST' && parts[1] === 'cancel') { GP.cancelPick(); return ok('photos'); }
    if (M === 'POST' && parts[1] === 'albums' && !parts[2]) {
      if (!GP.validAlbumUrl(body.url)) { console.log('[album] add rejected, not a shared-album link:', GP.redactUrl(String(body.url || '').slice(0, 120))); throw new HttpError(400, 'That link isn’t a Google Photos shared album. In Google Photos open the album → Share → Create link, and paste a photos.app.goo.gl/… or photos.google.com/share/… link.'); }
      const clean = GP.cleanAlbumUrl(body.url);
      if (get('SELECT 1 FROM google_albums WHERE url = ?', clean)) throw new HttpError(400, 'That album is already added.');
      // Open the link before saving, so a bad/missing key, a single-photo link or a dead link is refused here with its reason.
      const probe = await GP.probeAlbum(clean).catch((e) => { console.log('[album] add rejected:', GP.redactUrl(clean), '-', e.message || e); throw new HttpError(400, String(e.message || e)); });
      for (const a of all('SELECT id, url FROM google_albums')) if (probe.shareId && (await GP.savedShareId(a.url)) === probe.shareId) { console.log('[album] add rejected, same album as #' + a.id + ':', GP.redactUrl(clean)); throw new HttpError(400, 'That album is already added.'); }
      const r = run('INSERT INTO google_albums (url, title) VALUES (?, ?)', clean, probe.title || null);
      console.log('[album] added #' + Number(r.lastInsertRowid) + ':', GP.redactUrl(clean), '(' + probe.count + ' photos)');
      // Screens with a custom selection (any source off) don't get new albums turned on by themselves.
      for (const s of all('SELECT DISTINCT screen_id FROM screen_photo_off')) run('INSERT OR IGNORE INTO screen_photo_off (screen_id, source_key) VALUES (?, ?)', s.screen_id, 'album:' + Number(r.lastInsertRowid));
      GP.checkAlbum(Number(r.lastInsertRowid)).catch(() => {});
      return ok('photos', { id: Number(r.lastInsertRowid) });
    }
    if (M === 'POST' && parts[1] === 'albums' && parts[3] === 'check') { GP.checkAlbum(+parts[2]).catch(() => {}); return ok('photos'); }
    if (M === 'DELETE' && parts[1] === 'albums' && parts[2]) {
      const aid = +parts[2];
      if (!get('SELECT 1 FROM google_albums WHERE id = ?', aid)) throw new HttpError(404, 'No such album'); // a dead id deletes nothing
      if (url.searchParams.get('photos') === '1' && ST.pausedNow()) throw new HttpError(503, ST.paused() + ' Remove it later, or keep its photos.');
      if (url.searchParams.get('photos') === '1') { GP.forget('google-album', aid); GP.removeSource('google-album', aid); } // photos also in another source stay
      else GP.keepSource(aid); // kept photos leave the album ('kept' bucket)
      run('DELETE FROM google_albums WHERE id = ?', aid);
      run('DELETE FROM screen_photo_off WHERE source_key = ?', 'album:' + aid);
      return ok('photos');
    }
    throw new HttpError(404, 'Not found');
  }

  // --- photo folder (storage card): size, free space, move / switch
  if (parts[0] === 'storage') {
    requirePin(req);
    const bad = (e) => { throw new HttpError(400, String(e.message || e)); };
    if (M === 'GET' && !parts[1]) { ST.check(); return send(res, 200, ST.info()); }
    if (M === 'POST' && parts[1] === 'check') { let v; try { v = ST.validate(body.dir); } catch (e) { bad(e); } return send(res, 200, Object.assign({ ok: true }, v)); }
    if (M === 'POST' && parts[1] === 'move') { let m; try { m = ST.startMove(body.dir); } catch (e) { bad(e); } return ok('storage', { move: m }); }
    if (M === 'POST' && parts[1] === 'use') { try { ST.use(body.dir); } catch (e) { bad(e); } return ok('photos'); }
    if (M === 'POST' && parts[1] === 'clear-move') { try { ST.clearMove(); } catch (e) { bad(e); } return ok('storage'); }
  }
  // --- one source's photos, paged (admin photo views). src = upload | picker | kept | album:<id>
  if (M === 'GET' && parts[0] === 'photos' && parts[1] === 'list') {
    requirePin(req);
    const src = String(url.searchParams.get('src') || '');
    const m = src.match(/^(upload|picker|kept|album:(\d+))$/);
    if (!m) throw new HttpError(400, 'Unknown photo source');
    const where = m[1] === 'upload' ? "l.source = 'upload'" : m[1] === 'picker' ? "l.source = 'google-picker'" : m[1] === 'kept' ? "l.source = 'google-album' AND l.source_id IS NULL" : "l.source = 'google-album' AND l.source_id = " + (+m[2]);
    const limit = Math.min(200, Math.max(1, +url.searchParams.get('limit') || 60)), offset = Math.max(0, +url.searchParams.get('offset') || 0);
    const total = get('SELECT COUNT(DISTINCT l.photo_id) AS n FROM photo_links l WHERE ' + where).n;
    const keys = photoKeys();
    // Keyset paging: ?after=<date>|<id> of the last row shown (stable while an import adds/removes rows); ?offset= still works.
    const am = String(url.searchParams.get('after') || '').match(/^([\d-]*)\|(\d+)$/);
    const page = am ? ' AND (COALESCE(p.date, \'\') < ? OR (COALESCE(p.date, \'\') = ? AND p.id < ?))' : '';
    const rows = all('SELECT p.id, p.file, p.date, p.artwork, p.caption, p.place, p.orient, p.source FROM photos p WHERE p.id IN (SELECT l.photo_id FROM photo_links l WHERE ' + where + ')' + page +
      ' ORDER BY COALESCE(p.date, \'\') DESC, p.id DESC LIMIT ? OFFSET ?', ...(am ? [am[1], am[1], +am[2]] : []), limit + 1, am ? 0 : offset)
      .map((p) => Object.assign(p, { srcs: keys.get(p.id) || [photoKey(p)] }));
    const more = rows.length > limit; if (more) rows.pop(); // one extra row = is there a next page (no empty last request)
    const last = rows[rows.length - 1], next = more && last ? (last.date || '') + '|' + last.id : null;
    const name = (photoSources().filter((x) => x.key === src)[0] || {}).name || src;
    return send(res, 200, { src, name, total, offset, limit, next, photos: rows, storage_ok: ST.check() });
  }
  // --- admin grid live check (after an SSE change): for the tiles on screen (ids, newest-first; top / bottom = date|id
  // cursors of the first / last one) → the source's total, how many rows are now newer than the top tile or inside the
  // loaded range but not on screen (new / re-dated photos: "Show N new photos"), and which shown ids left this source.
  if (M === 'POST' && parts[0] === 'photos' && parts[1] === 'sync') {
    requirePin(req);
    const src = String(body.src || ''), m = src.match(/^(upload|picker|kept|album:(\d+))$/);
    if (!m) throw new HttpError(400, 'Unknown photo source');
    const where = m[1] === 'upload' ? "l.source = 'upload'" : m[1] === 'picker' ? "l.source = 'google-picker'" : m[1] === 'kept' ? "l.source = 'google-album' AND l.source_id IS NULL" : "l.source = 'google-album' AND l.source_id = " + (+m[2]);
    const cur = (s) => { const c = String(s || '').match(/^([\d-]*)\|(\d+)$/); return c ? [c[1], +c[2]] : null; };
    if (body.ids != null && !Array.isArray(body.ids)) throw new HttpError(400, 'ids must be a list of photo ids');
    const ids = body.ids || [];
    if (ids.length > 20000 || !ids.every((n) => Number.isSafeInteger(n) && n > 0)) throw new HttpError(400, 'ids must be up to 20000 positive whole numbers');
    const inSrc = 'SELECT p.id, COALESCE(p.date, \'\') AS d FROM photos p WHERE p.id IN (SELECT l.photo_id FROM photo_links l WHERE ' + where + ')';
    const total = get('SELECT COUNT(DISTINCT l.photo_id) AS n FROM photo_links l WHERE ' + where).n;
    const top = cur(body.top), bottom = cur(body.bottom), shown = new Set(ids);
    let newer = 0, missing = 0;
    const live = new Set();
    if (top) {
      newer = get('SELECT COUNT(*) AS n FROM (' + inSrc + ') WHERE d > ? OR (d = ? AND id > ?)', top[0], top[0], top[1]).n;
      if (bottom) for (const r of all('SELECT id FROM (' + inSrc + ') WHERE (d < ? OR (d = ? AND id <= ?)) AND (d > ? OR (d = ? AND id >= ?))', top[0], top[0], top[1], bottom[0], bottom[0], bottom[1])) { live.add(r.id); if (!shown.has(r.id)) missing++; }
    } else newer = total;
    const gone = ids.filter((id) => !live.has(id) && !get('SELECT 1 FROM photo_links l WHERE l.photo_id = ? AND ' + where, id));
    return send(res, 200, { total, newer, missing, gone });
  }
  // --- photos: JSON upload of a (browser-shrunk) JPEG data URL, saved to the photo folder
  if (M === 'POST' && parts[0] === 'photos' && !parts[1]) {
    requirePin(req);
    const m = String(body.data || '').match(/^data:image\/(jpeg|png|webp);base64,(.+)$/);
    if (!m) throw new HttpError(400, 'Expected an image');
    const date = /^\d{4}-\d\d-\d\d$/.test(body.date || '') ? body.date : ymd(new Date());
    const file = Date.now().toString(36) + crypto.randomBytes(3).toString('hex') + '.' + (m[1] === 'jpeg' ? 'jpg' : m[1]);
    const buf = Buffer.from(m[2], 'base64');
    // Uploading a hidden picture on purpose brings back only the upload; album/picker tombstones (incl. the hash one) stay,
    // so album checks don't re-link it (storePhoto ignores hash tombstones for uploads).
    const sp = GP.storePhoto(buf, { file, date, person_id: body.person_id || null, artwork: body.artwork ? 1 : 0, caption: body.caption || null, orient: body.orient === 'p' ? 'p' : 'l' },
      { source: 'upload', source_id: null, ext_id: null });
    return ok('photos', { id: sp.id, duplicate: sp.dup });
  }
  if (M === 'DELETE' && parts[0] === 'photos' && parts[1]) {
    requirePin(req);
    // Removes one membership (?from=<source key>, default its first source); the file goes only with the last one.
    const r = GP.deletePhoto(+parts[1], url.searchParams.get('from') || null, linkKey) || { removed: false, left: [] };
    const names = Object.fromEntries(photoSources().map((x) => [x.key, x.name]));
    return ok('photos', { removed: r.removed, left: r.left, leftNames: r.left.map((k) => names[k] || k) });
  }

  // --- generic CRUD
  const T = TABLES[parts[0]];
  if (T) {
    const [table, cols, needsPin] = T;
    if (needsPin) requirePin(req);
    const id = parts[1];
    const topic = table === 'calendars' ? 'calendar' : table === 'events' ? 'calendar' : table;
    if (M === 'POST' && !id) {
      if (table === 'devices' || table === 'profiles') { checkTheme(body); checkNight(body); checkQuiet(body, null); }
      const v = pickCols(cols, body, table);
      if (table === 'people' && ('name' in v || M === 'POST') && !String(v.name == null ? '' : v.name).trim()) throw new HttpError(400, 'Name can’t be empty');
      const keys = Object.keys(v);
      if (!keys.length) throw new HttpError(400, 'Nothing to save');
      const r = run(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...Object.values(v));
      if (table === 'calendars') fetchCalendars();
      return ok(topic, { id: Number(r.lastInsertRowid) });
    }
    if (M === 'PUT' && id) {
      if (table === 'devices' || table === 'profiles') { checkTheme(body); checkNight(body); checkQuiet(body, get(`SELECT quiet_start, quiet_end FROM ${table} WHERE id = ?`, id)); }
      const v = pickCols(cols, body, table);
      if (table === 'people' && ('name' in v || M === 'POST') && !String(v.name == null ? '' : v.name).trim()) throw new HttpError(400, 'Name can’t be empty');
      const keys = Object.keys(v);
      if (keys.length) run(`UPDATE ${table} SET ${keys.map((k) => k + ' = ?').join(',')} WHERE id = ?`, ...Object.values(v), id);
      if (table === 'calendars') fetchCalendars();
      return ok(topic);
    }
    if (M === 'DELETE' && id) {
      run(`DELETE FROM ${table} WHERE id = ?`, id);
      if (table === 'calendars') fetchCalendars();
      return ok(topic);
    }
  }
  throw new HttpError(404, 'Not found');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveFile(res, file) {
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': file.includes('/assets/') ? 'max-age=31536000, immutable' : 'no-cache' });
  fs.createReadStream(file).pipe(res);
}
const THUMBS = path.join(os.tmpdir(), 'pf-thumbs');
let sharpLib;
function serveThumb(res, name) {
  const src = ST.fileOf(name), dst = path.join(THUMBS, path.basename(name).replace(/\.\w+$/, '') + '.jpg');
  const send = (f) => { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' }); fs.createReadStream(f).pipe(res); };
  if (!fs.existsSync(src)) { res.writeHead(404); return res.end(); }
  if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) return send(dst);
  (sharpLib === undefined ? import('sharp').then((m) => (sharpLib = m.default), () => (sharpLib = null)) : Promise.resolve(sharpLib))
    .then((sharp) => {
      if (!sharp) return send(src);
      fs.mkdirSync(THUMBS, { recursive: true });
      return sharp(src).rotate().resize(320, 320, { fit: 'cover' }).jpeg({ quality: 72 }).toFile(dst + '.tmp').then(() => { fs.renameSync(dst + '.tmp', dst); send(dst); });
    }).catch(() => send(src));
}
function serveStatic(req, res, url) {
  if (url.pathname === '/admin' || url.pathname === '/admin/') return serveFile(res, path.join(HERE, 'admin.html'));
  // Admin grid thumbnails: 320px JPEGs cached outside the photo folder (falls back to the full file).
  const th = url.pathname.match(/^\/photos\/thumb\/([\w.-]+)$/);
  if (th) return serveThumb(res, th[1]);
  if (url.pathname.startsWith('/photos/')) {
    const f = ST.fileOf(decodeURIComponent(url.pathname));
    if (fs.existsSync(f)) { res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'image/jpeg', 'Cache-Control': 'max-age=86400' }); return fs.createReadStream(f).pipe(res); }
    res.writeHead(404); return res.end();
  }
  const file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
  if (file.startsWith(DIST) && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file);
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) return serveFile(res, index);
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('No build yet — run `npm run build`, or use the Vite dev server.');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await reqCtx.run({ client: String(req.headers['x-client-id'] || '').slice(0, 64) }, () => api(req, res, url));
    serveStatic(req, res, url);
  } catch (e) {
    if (!(e instanceof HttpError) && e.code !== 503) console.error(e); // 503 = photo folder paused (storage.js), already logged once
    if (!res.headersSent) send(res, e.code && e.code >= 400 && e.code < 600 ? e.code : 500, { error: e.message });
  }
});
// Ok-to-wake lights: at a person's wake/bed time, set their Home Assistant light to the chosen colour.
const fired = {};
setInterval(() => {
  const now = new Date(), hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0'), day = ymd(now);
  for (const p of all('SELECT * FROM people WHERE wake_light IS NOT NULL')) {
    for (const [when, color] of [[p.wake, p.wake_color || '#FFC34D'], [p.bedtime, p.bed_color || '#3B2A80']]) {
      const key = p.id + when + day;
      if (when !== hm || fired[key]) continue;
      fired[key] = true;
      const n = parseInt(color.slice(1), 16);
      callHA('light', 'turn_on', { entity_id: p.wake_light, rgb_color: [(n >> 16) & 255, (n >> 8) & 255, n & 255], brightness_pct: 40 })
        .catch((e) => console.error('wake light:', e.message));
    }
  }
}, 20e3);

server.listen(PORT, '0.0.0.0', () => {
  console.log('Dashboard server on http://localhost:' + PORT + '  (admin: /admin)');
  start(broadcast);
  ST.startStorage((t) => reqCtx.exit(() => broadcast(t)));
  GP.startGoogle((t) => reqCtx.exit(() => broadcast(t))); // background album work isn’t any tab’s own write
});

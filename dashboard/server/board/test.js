// Board tests: node server/board/test.js  (from dashboard/). Uses a throwaway SQLite file and a fake network:
// nothing here talks to the internet or to the real data.db.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'));
process.env.DB_FILE = path.join(TMP, 'test.db');
const { run, setSetting } = await import('../db.js');
const { cache } = await import('../fetchers.js');
const CS = await import('./charset.js');
const SEL = await import('./select.js');
const B = await import('./index.js');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name); } catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n').join('\n       ')); }
}
const S = 1000, NOW = new Date(2026, 10, 9, 12, 0, 0).getTime();
const card = (type, key, extra) => Object.assign({ type, key, lines: [key] }, extra);
const sel = (cards, st, now, o) => SEL.select(cards, st, now, Object.assign({ rng: seeded(1) }, o)).card;
function seeded(s) { return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

// fake network: counts calls, answers like OpenSky, or fails on demand
let calls = 0, netFail = false;
const fakeHttp = async (url) => {
  calls++;
  if (netFail) throw new Error('network down (test)');
  assert.match(url, /opensky-network\.org/);
  return { states: [['abc123', 'AAL123 ', 'US', 0, 0, -96.82, 33.16, 3000, false]] };
};
const H = { send: (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); },
  requirePin: (req) => { if (req.headers['x-pin'] !== '2468') throw new HttpError(401, 'Parent PIN required'); }, HttpError: null, broadcast() {} };
class HttpError extends Error { constructor(c, m) { super(m); this.code = c; } }
H.HttpError = HttpError;
B.start(H, { timer: false, http: fakeHttp });

console.log('charset');
await t('letters, digits, punctuation and degree encode to Vestaboard codes', () => {
  const r = CS.parseLine('Az 09 !?°');
  assert.deepEqual(r.tokens.map((x) => x.code), [1, 26, 0, 36, 35, 0, 37, 60, 62]);
});
await t('{red}TEXT{/} colours only those letters; [green] and {63} are tiles', () => {
  const r = CS.parseLine('{red}AB{/}C [green]{63}');
  assert.deepEqual(r.tokens, [{ code: 1, fg: 'red' }, { code: 2, fg: 'red' }, { code: 3 }, { code: 0 }, { code: 66 }, { code: 63 }]);
});
await t('accents and smart quotes fold; unknown characters are errors when strict, dropped otherwise', () => {
  assert.deepEqual(CS.parseLine('Café “ok”').tokens.map((x) => x.code), [3, 1, 6, 5, 0, 53, 15, 11, 53]);
  const s = CS.parseLine('hi ~ {pink}x{/}', true);
  assert.equal(s.errors.length, 2);
  assert.match(s.errors.join(' '), /Unknown colour \{pink\}/);
  assert.match(s.errors.join(' '), /can’t show: ~/);
  assert.equal(CS.parseLine('hi ~ {pink}x', false).errors.length, 0);
});
await t('wrap: words move to the next row, long words split, rows centred', () => {
  const g = CS.layout(['THE QUICK BROWN FOX JUMPS', 'OVER'], 10, 5).grid;
  assert.equal(CS.gridText(g), 'THE QUICK \nBROWN FOX \n  JUMPS   \n   OVER   \n          ');
  assert.equal(CS.gridText(CS.layout(['ABCDEFGHIJ'], 8, 2).grid), 'ABCDEFGH\n   IJ   ');
  assert.equal(CS.wrap(['ABCDEFGHIJKLMNOPQRSTUVWXYZ'], 22).rows.length, 2);
});
await t('check(): too long and bad markup give clear errors', () => {
  assert.match(CS.check('A '.repeat(80)).errors[0], /needs 8 rows of 22, the board has 6/);
  assert.match(CS.check('{blurple}HI{/}').errors[0], /Unknown colour \{blurple\}/);
  assert.deepEqual(CS.check('{green}DINNER{/} AT 6:30').errors, []);
});
await t('palette contrast at every flap shade: letters >= 4.5:1 on both halves; colour tiles >= 4.5:1 day, >= 3:1 night', () => {
  for (const [name, p] of Object.entries(CS.PALETTES).flatMap(([n, q]) => CS.SHADES.map((sh) => [n + ' shade ' + sh, CS.shade(q, sh)]))) {
    assert.ok(p.bg && p.bg2 && p.hinge, name + ' has top, bottom and hinge colours');
    assert.ok(CS.contrast(p.bg, '#000000') >= CS.contrast(p.bg2, '#000000'), name + ': top half is the lighter one');
    assert.ok(CS.contrast(p.bg, '#000000') < 1.35, name + ': flap is near-black');
    const lv = (h) => parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
    const gap = (lv(p.bg) - lv(p.bg2)) / 3;
    assert.ok(gap >= 2 && gap <= 5, name + ': top/bottom gap is small (' + gap.toFixed(1) + ' levels)');
    for (const half of [p.bg, p.bg2]) {
      for (const [k, c] of Object.entries(Object.assign({ text: p.text }, p.fg))) {
        const r = CS.contrast(c, half);
        assert.ok(r >= 4.5, name + ' ' + k + ' ' + c + ' on ' + half + ' is ' + r.toFixed(2) + ':1');
      }
      const need = name.startsWith('night') ? 3 : 4.5;
      for (const [k, c] of Object.entries(p.tile)) {
        if (k === '70') continue; // the black tile is meant to look like an empty flap
        const r = CS.contrast(c, half);
        assert.ok(r >= need, name + ' tile ' + k + ' ' + c + ' on ' + half + ' is ' + r.toFixed(2) + ':1 (needs ' + need + ')');
      }
    }
  }
});

console.log('selector');
await t('alert preempts a live card before its dwell is up', () => {
  const st = SEL.newState();
  assert.equal(sel([card('live', 'w')], st, NOW).key, 'w');
  assert.equal(sel([card('live', 'w'), card('alert', 'garage')], st, NOW + 1 * S).key, 'garage');
});
await t('expired cards are not shown; an alert whose source stops emitting it is gone', () => {
  const st = SEL.newState();
  assert.equal(sel([card('alert', 'a', { expires_at: NOW - 1 }), card('live', 'w')], st, NOW).key, 'w');
  sel([card('alert', 'a')], st, NOW);
  assert.equal(sel([card('live', 'w')], st, NOW + 1 * S).key, 'w');
});
await t('live card past stale_after is hidden', () => {
  assert.equal(sel([card('live', 'w', { stale_after: NOW - 1 })], SEL.newState(), NOW), null);
});
await t('a newer card with the same key replaces the old one', () => {
  const c = sel([card('live', 'w', { lines: ['OLD'] }), card('live', 'w', { lines: ['NEW'] })], SEL.newState(), NOW);
  assert.deepEqual(c.lines, ['NEW']);
});
await t('scheduled card shows only inside starts_at..expires_at', () => {
  const c = card('scheduled', 's', { starts_at: NOW + 60 * S, expires_at: NOW + 120 * S });
  assert.equal(sel([c], SEL.newState(), NOW), null);
  assert.equal(sel([c], SEL.newState(), NOW + 90 * S).key, 's');
  assert.equal(sel([c], SEL.newState(), NOW + 120 * S), null);
});
await t('personal weight decays with age (half-life) down to its floor; expired notes go', () => {
  const td = SEL.TYPE_DEFAULTS, hl = td.personal.half_life * S;
  assert.equal(SEL.decay({ created: NOW }, NOW, td), 1);
  assert.ok(Math.abs(SEL.decay({ created: NOW - hl }, NOW + 0, td) - 0.5) < 1e-9);
  assert.equal(SEL.decay({ created: NOW - 20 * hl }, NOW, td), td.personal.floor);
  assert.equal(sel([card('personal', 'p', { expires_at: NOW - 1 })], SEL.newState(), NOW), null);
});
await t('a fresh note gets more turns than an old one (weighted rotation)', () => {
  const count = (created) => {
    const st = SEL.newState(), n = {};
    const cards = [card('personal', 'note', { created, dwell: 1 }), card('live', 'w', { dwell: 1 }), card('scheduled', 's', { dwell: 1 })];
    for (let i = 0; i < 90; i++) { const c = sel(cards, st, NOW + i * 2 * S); n[c.key] = (n[c.key] || 0) + 1; }
    return n.note;
  };
  const fresh = count(NOW), old = count(NOW - 24 * 3600 * S);
  assert.ok(fresh > 40 && old < 25, 'fresh ' + fresh + ' vs old ' + old + ' of 90');
});
await t('ambient: shuffled, no repeat until the pool is used up, no repeat across cycles', () => {
  const pool = [1, 2, 3, 4, 5].map((i) => card('ambient', 'q' + i, { dwell: 1 })), st = SEL.newState(), seen = [];
  for (let i = 0; i < 15; i++) seen.push(sel(pool, st, NOW + i * 2 * S).key);
  for (let c = 0; c < 3; c++) assert.equal(new Set(seen.slice(c * 5, c * 5 + 5)).size, 5, 'cycle ' + c + ': ' + seen.join(','));
  for (let i = 1; i < seen.length; i++) assert.notEqual(seen[i], seen[i - 1]);
});
await t('a new higher card never waits behind a lower one', () => {
  const st = SEL.newState();
  assert.equal(sel([card('ambient', 'q')], st, NOW).key, 'q');
  assert.equal(sel([card('ambient', 'q'), card('personal', 'p')], st, NOW + 1 * S).key, 'p');
});
await t('quiet hours: only urgent alerts get through', () => {
  const cards = [card('alert', 'a'), card('personal', 'p'), card('live', 'w'), card('ambient', 'q')];
  assert.equal(sel(cards, SEL.newState(), NOW, { quiet: true }), null);
  assert.equal(sel(cards.concat(card('alert', 'u', { urgent: true })), SEL.newState(), NOW, { quiet: true }).key, 'u');
});

console.log('board (sources, rotation, cache)');
run("INSERT INTO devices (id, name) VALUES ('kitchen', 'Kitchen'), ('hall', 'Hall')");
setSetting('lat', '33.15'); setSetting('lon', '-96.82');
const cfg = (c) => setSetting('board_config', JSON.stringify(c));
const fresh = () => { B._t.reset(); run('DELETE FROM board_messages'); run('DELETE FROM board_acks'); }; // each test starts clean
const base = { sources: { verse: { enabled: false }, quote: { enabled: false }, weather: { enabled: false }, calendar: { enabled: false }, countdown: { enabled: false } }, screens: { kitchen: { enabled: true } } };
await t('static rotation, then a sticky post preempts it, then rotation resumes', async () => {
  fresh();
  cfg(Object.assign({}, base, { sources: Object.assign({}, base.sources, { static: { enabled: true, opts: { items: [{ text: 'ONE' }, { text: 'TWO' }] } } }) }));
  await B.tick(NOW);
  const show = (now) => CS.gridText(B.compose('kitchen', now, false).cells).replace(/\s+/g, ' ').trim();
  assert.equal(show(NOW), 'ONE');
  assert.equal(show(NOW + 21 * S), 'TWO');
  const m = B.postMessage({ text: '{red}FIRE DRILL{/}', sticky: true }, NOW + 22 * S);
  assert.equal(m.type, 'alert');
  const p = B.compose('kitchen', NOW + 23 * S, false);
  assert.equal(CS.gridText(p.cells).trim(), 'FIRE DRILL');
  assert.equal(p.card.accent, 'red', 'alert accent');
  assert.equal(p.cells[2].find((c) => c.code === 6).fg, 'red', 'F carries its colour');
  run('DELETE FROM board_messages');
  assert.match(show(NOW + 24 * S), /^(ONE|TWO)$/);
});
await t('a note is personal with the soft accent; a source accent overrides the type default', async () => {
  fresh();
  cfg(Object.assign({}, base, { sources: Object.assign({}, base.sources, { static: { enabled: true, accent: 'blue', opts: { items: [{ text: 'HI' }] } } }) }));
  await B.tick(NOW);
  assert.equal(B.compose('kitchen', NOW, false).card.accent, 'blue');
  B.postMessage({ text: 'CALL GRANDMA', screen: 'kitchen' }, NOW);
  const p = B.compose('kitchen', NOW + 1 * S, false);
  assert.deepEqual([p.card.type, p.card.accent], ['personal', 'soft']);
  run('DELETE FROM board_messages');
});
await t('a post for one screen doesn’t show on another', async () => {
  fresh();
  const c = JSON.parse(JSON.stringify(base)); c.screens.hall = { enabled: true };
  cfg(c);
  B.postMessage({ text: 'KITCHEN ONLY', screen: 'kitchen' }, NOW);
  assert.equal(B.compose('hall', NOW, false).card.type, 'clock', 'the hall shows the time instead');
  assert.equal(B.compose('kitchen', NOW, false).card.key.slice(0, 5), 'post:');
  run('DELETE FROM board_messages');
});
await t('flights off: no network call at all', async () => {
  fresh(); calls = 0;
  cfg(base);
  await B.tick(NOW, true);
  assert.equal(calls, 0);
  const c = JSON.parse(JSON.stringify(base)); c.sources.flights = { enabled: true };
  cfg(c); B._t.reset();
  await B.tick(NOW, true);
  assert.equal(calls, 1, 'turned on: one call');
});
await t('a failing fetch keeps the last good cards (and reports the error)', async () => {
  fresh(); calls = 0; netFail = false;
  const c = JSON.parse(JSON.stringify(base)); c.sources.flights = { enabled: true };
  cfg(c);
  await B.tick(NOW, true);
  const before = [...B._t.store.values()].find((e) => e.kind === 'flights');
  assert.equal(before.cards.length, 1);
  netFail = true;
  await B.tick(NOW + 400 * S, true);
  const after = [...B._t.store.values()].find((e) => e.kind === 'flights');
  assert.equal(after.cards.length, 1, 'kept');
  assert.match(after.error, /network down/);
  assert.match(CS.gridText(B.compose('kitchen', NOW + 401 * S, false).cells), /AAL123/);
  netFail = false;
});
await t('weather card comes from the server cache; HA alert clears when the condition ends', async () => {
  fresh();
  cache.weather = { unit: 'F', hi: 80, lo: 60, now: 72, feels: 70, p: Array(24).fill(0), updated: new Date(NOW).toISOString() };
  cache.ha = { states: { 'cover.garage_door': { state: 'open', attributes: {} } }, updated: new Date(NOW).toISOString() };
  const c = JSON.parse(JSON.stringify(base));
  c.sources.weather = { enabled: true }; c.sources.ha_alert = { enabled: true, opts: { rules: [{ entity: 'cover.garage_door', op: '=', value: 'open', message: 'GARAGE IS OPEN' }] } };
  cfg(c);
  await B.tick(NOW, true);
  assert.equal(CS.gridText(B.compose('kitchen', NOW, false).cells).trim(), 'GARAGE IS OPEN');
  cache.ha.states['cover.garage_door'].state = 'closed';
  await B.tick(NOW + 20 * S, true);
  assert.match(CS.gridText(B.compose('kitchen', NOW + 21 * S, false).cells), /NOW 72°/);
  cache.weather = null; cache.ha = null;
});

await t('selector: a skip (tap) moves on at once, then the next card gets its normal dwell', () => {
  const st = SEL.newState(), cards = [card('live', 'a'), card('live', 'b'), card('live', 'c')];
  const first = sel(cards, st, NOW).key;
  assert.equal(sel(cards, st, NOW + 1 * S).key, first, 'no skip: stays');
  st.skip = true;
  const second = sel(cards, st, NOW + 2 * S).key;
  assert.notEqual(second, first, 'skip: moved on');
  assert.equal(sel(cards, st, NOW + 15 * S).key, second, 'and stays for its dwell');
  assert.notEqual(sel(cards, st, NOW + 23 * S).key, second, 'then rotates as usual');
});
await t('tap: next card now, 600 ms debounce, nothing when gestures are off', async () => {
  fresh();
  cfg(Object.assign({}, base, { sources: Object.assign({}, base.sources, { static: { enabled: true, opts: { items: [{ text: 'ONE' }, { text: 'TWO' }, { text: 'THREE' }] } } }) }));
  await B.tick(NOW);
  const shown = () => CS.gridText(B._t.last.get('kitchen').payload.cells).replace(/\s+/g, ' ').trim();
  const a = shown();
  assert.equal(B.tap('kitchen', NOW + 1 * S).action, 'next');
  const b = shown();
  assert.notEqual(b, a);
  assert.equal(B.tap('kitchen', NOW + 1 * S + 300).action, 'debounced');
  assert.equal(shown(), b, 'a debounced tap changes nothing');
  assert.equal(B.tap('kitchen', NOW + 1 * S + 700).action, 'next');
  assert.notEqual(shown(), b);
  const c = JSON.parse(JSON.stringify(B.config())); c.screens.kitchen.gestures = false; cfg(c); B._t.reset();
  await B.tick(NOW + 3 * S);
  const before = shown();
  assert.equal(B.tap('kitchen', NOW + 4 * S).action, 'gestures-off');
  assert.equal(shown(), before);
});
await t('tap on an alert dismisses it for that screen only, and it doesn’t come straight back', async () => {
  fresh();
  const c = JSON.parse(JSON.stringify(base)); c.screens.hall = { enabled: true };
  c.sources.static = { enabled: true, opts: { items: [{ text: 'ROUTINE' }] } };
  cfg(c);
  B.postMessage({ text: 'DOOR OPEN', urgent: true }, NOW);
  await B.tick(NOW);
  assert.equal(B._t.last.get('kitchen').payload.card.type, 'alert');
  const r = B.tap('kitchen', NOW + 1 * S);
  assert.equal(r.action, 'ack');
  assert.notEqual(B._t.last.get('kitchen').payload.card.type, 'alert', 'kitchen moved off the alert');
  for (const s of [2, 15, 40, 90]) assert.notEqual(B.compose('kitchen', NOW + s * S, false).card.type, 'alert', 'still dismissed at +' + s + 's');
  assert.equal(B.compose('hall', NOW + 2 * S, false).card.type, 'alert', 'the hall still shows it');
  run('DELETE FROM board_messages');
  B.compose('kitchen', NOW + 100 * S, false);
  assert.equal(B._t.acks('kitchen').length, 0, 'the ack goes when the alert does');
});
await t('font + gestures: defaults, payload, and server-side validation (PUT config)', async () => {
  fresh(); cfg(base);
  const p = B.compose('kitchen', NOW, false);
  assert.deepEqual([p.font, p.gestures], ['solari', true]);
  assert.deepEqual(Object.keys(CS.FONTS), ['solari', 'modern', 'tall']);
});
await t('fallback: an empty queue shows the time and weather ("12:00 PM" / "42° CLEAR")', async () => {
  fresh(); cfg(base);
  cache.weather = { now: 42, c: Array(24).fill('moon'), updated: new Date(NOW).toISOString() };
  const p = B.compose('kitchen', NOW, false);
  assert.equal(p.card.type, 'clock');
  assert.equal(CS.gridText(p.cells).replace(/\s+/g, ' ').trim(), '12:00 PM 42° CLEAR');
  assert.equal(p.night, false, 'daytime: not dimmed');
});
await t('fallback in quiet hours: the clock card, dimmed (night), and the board stays', async () => {
  fresh(); cfg(base);
  cache.weather = { now: 42, c: Array(24).fill('moon'), updated: new Date(NOW).toISOString() };
  B.postMessage({ text: 'NOT AT NIGHT', screen: 'kitchen' }, NOW);
  const p = B.compose('kitchen', NOW + S, true);
  assert.deepEqual([p.card.type, p.quiet, p.night], ['clock', true, true]);
  assert.match(CS.gridText(p.cells), /12:00 PM/);
  B.postMessage({ text: 'SMOKE ALARM', urgent: true }, NOW);
  assert.equal(B.compose('kitchen', NOW + 2 * S, true).card.type, 'alert', 'urgent alerts still show at night');
});
await t('night screen off: quiet hours are not dimmed here (the frame goes to the night clock as before)', async () => {
  fresh();
  const c = JSON.parse(JSON.stringify(base)); c.screens.kitchen.night_screen = false; cfg(c);
  const p = B.compose('kitchen', NOW, true);
  assert.deepEqual([p.quiet, p.night], [true, false]);
  assert.equal(B.compose('kitchen', NOW, false).night, false);
});
await t('no weather (none, or more than 3 h old): the time only', async () => {
  fresh(); cfg(base);
  cache.weather = null;
  assert.equal(CS.gridText(B.compose('kitchen', NOW, false).cells).replace(/\s+/g, ' ').trim(), '12:00 PM');
  cache.weather = { now: 42, c: Array(24).fill('sun'), updated: new Date(NOW - 4 * 3600e3).toISOString() };
  assert.equal(CS.gridText(B.compose('kitchen', NOW, false).cells).replace(/\s+/g, ' ').trim(), '12:00 PM');
});
await t('minute tick: only the tiles that changed flip (12:00 -> 12:01 is one tile)', async () => {
  fresh(); cfg(base);
  cache.weather = { now: 42, c: Array(24).fill('moon'), updated: new Date(NOW).toISOString() };
  const a = B.compose('kitchen', NOW, false).cells, b = B.compose('kitchen', NOW + 60 * S, false).cells;
  const diff = []; a.forEach((row, r) => row.forEach((x, c) => { if (JSON.stringify(x) !== JSON.stringify(b[r][c])) diff.push([r, c]); }));
  assert.equal(diff.length, 1, 'changed tiles: ' + JSON.stringify(diff));
  const c = B.compose('kitchen', NOW + 30 * S, false).cells;
  assert.deepEqual(c, a, 'same minute: nothing changes');
});
console.log('HTTP (board routes, PIN and token)');
const srv = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
  try { await B.api(req, res, url, url.pathname.split('/').filter(Boolean).slice(1), body); } catch (e) { H.send(res, e.code || 500, { error: e.message }); }
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const U = 'http://127.0.0.1:' + srv.address().port;
const post = (headers, body) => fetch(U + '/api/board/message', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const count = async () => (await import('../db.js')).get('SELECT COUNT(*) AS n FROM board_messages').n;
B._t.reset(); cfg(base); run('DELETE FROM board_messages');
await t('POST without a PIN is rejected and writes nothing', async () => {
  const r = await post({}, { text: 'HELLO' });
  assert.equal(r.status, 401);
  assert.equal(await count(), 0);
});
await t('POST with a wrong token is rejected and writes nothing', async () => {
  setSetting('board_token', 'test-token-0123456789');
  const r = await post({ Authorization: 'Bearer nope-nope-nope-nope-nope' }, { text: 'HELLO' });
  assert.equal(r.status, 401);
  assert.equal(await count(), 0);
});
await t('POST with the PIN (or the right token) is accepted', async () => {
  let r = await post({ 'X-PIN': '2468' }, { text: 'HELLO {green}WORLD{/}' });
  assert.equal(r.status, 200); assert.equal(r.body.type, 'personal');
  r = await post({ Authorization: 'Bearer test-token-0123456789' }, { text: 'FROM HA', urgent: true });
  assert.equal(r.status, 200); assert.equal(r.body.type, 'alert');
  assert.equal(await count(), 2);
});
await t('bad colour names and unknown screens get a 400 with the reason', async () => {
  let r = await post({ 'X-PIN': '2468' }, { text: '{pink}HI{/}' });
  assert.equal(r.status, 400); assert.match(r.body.error, /Unknown colour \{pink\}/);
  r = await post({ 'X-PIN': '2468' }, { text: 'HI', screen: 'nope' });
  assert.equal(r.status, 400); assert.match(r.body.error, /No such screen/);
});
await t('GET /api/board?screen= needs no PIN and records 3D support', async () => {
  const r = await fetch(U + '/api/board?screen=kitchen&flip3d=0').then((x) => x.json());
  assert.equal(r.enabled, true); assert.equal(r.cols, 22); assert.ok(r.palettes.standard);
  assert.equal(B.adminState().screens.find((s) => s.id === 'kitchen').flip3d, 0);
});
await t('full screen is on by default and can be turned off per screen (PUT config, PIN)', async () => {
  let r = await fetch(U + '/api/board?screen=kitchen').then((x) => x.json());
  assert.equal(r.full, true);
  const put = (h) => fetch(U + '/api/board/config', { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, h), body: JSON.stringify({ screens: { kitchen: { full: false } } }) });
  assert.equal((await put({})).status, 401);
  assert.equal((await put({ 'X-PIN': '2468' })).status, 200);
  B._t.reset();
  r = await fetch(U + '/api/board?screen=kitchen').then((x) => x.json());
  assert.equal(r.full, false); assert.equal(r.enabled, true);
});
await t('PUT config: a bad font is a 400; a good one and gestures:false are saved; POST /tap needs no PIN', async () => {
  const put = (b) => fetch(U + '/api/board/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PIN': '2468' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  let r = await put({ screens: { kitchen: { font: 'comic-sans' } } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Font must be one of: solari, modern, tall/);
  r = await put({ screens: { kitchen: { font: 'tall', gestures: false } } });
  assert.equal(r.status, 200);
  B._t.reset();
  const g = await fetch(U + '/api/board?screen=kitchen').then((x) => x.json());
  assert.deepEqual([g.font, g.gestures], ['tall', false]);
  const tp = await fetch(U + '/api/board/tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screen: 'kitchen' }) }).then((x) => x.json());
  assert.equal(tp.action, 'gestures-off');
});
await t('night flaps are hue-free (R, G, B within 2) at every shade; warmth only in letters and tiles', () => {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (const name of ['night', 'night-red']) for (const sh of CS.SHADES) {
    const p = CS.shade(CS.PALETTES[name], sh);
    for (const k of ['bg', 'bg2', 'hinge']) { const c = rgb(p[k]); assert.ok(Math.max(...c) - Math.min(...c) <= 2, name + ' shade ' + sh + ' ' + k + ' ' + p[k] + ' has a hue'); }
    const t70 = rgb(p.tile[70]); assert.ok(Math.max(...t70) - Math.min(...t70) <= 2, name + ' blank tile ' + p.tile[70] + ' has a hue');
    const ink = rgb(p.text); assert.ok(Math.max(...ink) - Math.min(...ink) > 20, name + ': the letters keep their warmth');
  }
});
await t('flap shade: -2..2, moves both halves equally, validated; the payload palettes follow it', async () => {
  const p0 = CS.PALETTES.standard, d = CS.shade(p0, -2), l = CS.shade(p0, 2), lv = (h) => parseInt(h.slice(1, 3), 16);
  assert.deepEqual([lv(d.bg) - lv(p0.bg), lv(d.bg2) - lv(p0.bg2), lv(l.bg) - lv(p0.bg), lv(l.bg2) - lv(p0.bg2)], [-4, -4, 4, 4]);
  assert.equal(d.hinge, p0.hinge); assert.equal(d.text, p0.text);
  assert.equal(CS.shade(p0, 7), p0, 'out of range = normal');
  const put = (b) => fetch(U + '/api/board/config', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-PIN': '2468' }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  for (const bad of [3, -3, 0.5, 'dark']) { const r = await put({ screens: { kitchen: { shade: bad } } }); assert.equal(r.status, 400, 'shade ' + bad); assert.match(r.body.error, /Flap shade/); }
  assert.equal((await put({ screens: { kitchen: { shade: -2 } } })).status, 200);
  B._t.reset();
  const g = await fetch(U + '/api/board?screen=kitchen').then((x) => x.json());
  assert.equal(g.shade, -2);
  assert.deepEqual([g.palettes[g.palette].bg, g.palettes.night.bg, g.palettes['night-red'].bg2], [CS.shade(CS.PALETTES[g.palette], -2).bg, CS.shade(CS.PALETTES.night, -2).bg, CS.shade(CS.PALETTES['night-red'], -2).bg2]);
  assert.equal((await put({ screens: { kitchen: { shade: 0 } } })).status, 200);
});
console.log('gesture hint (js/views/board-hint.js)');
const HINT = await import('../../js/views/board-hint.js');
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
await t('hint shows on the first 3 opens of a screen, then never again', () => {
  const st = memStore();
  assert.deepEqual([1, 2, 3, 4, 5].map(() => HINT.hintShouldShow(st, 'kitchen')), [true, true, true, false, false]);
});
await t('hint: the first tap or hold ends it for good on that screen only', () => {
  const st = memStore();
  assert.equal(HINT.hintShouldShow(st, 'kitchen'), true);
  HINT.hintDone(st, 'kitchen');
  assert.deepEqual([1, 2, 3].map(() => HINT.hintShouldShow(st, 'kitchen')), [false, false, false]); // stays gone across loads
  assert.equal(HINT.hintShouldShow(st, 'hall'), true); // another screen sharing the browser still gets its hint
  assert.equal(st.getItem('pf.flipHint.kitchen'), 'done');
});
await t('hint: no or broken storage means no hint, never a hint on every load', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(HINT.hintShouldShow(broken, 'kitchen'), false);
  const st = memStore(); st.setItem('pf.flipHint.kitchen', 'garbage');
  assert.equal(HINT.hintShouldShow(st, 'kitchen'), true); assert.equal(st.getItem('pf.flipHint.kitchen'), '1');
});
srv.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);

// Google Photos as a photo source, two ways. Everything is downloaded into server/photos/,
// so the frame only ever loads pictures from this server (its old WebView can't do modern HTTPS).
//  1. Picker API (official): parent connects Google once, then picks photos in Google's own picker.
//  2. Public shared-album link (unofficial): the album page is scraped every 6 hours. May break.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, getSetting, setSetting } from './db.js';
import * as ST from './storage.js';

const PICKER = process.env.GP_PICKER_BASE || 'https://photospicker.googleapis.com/v1';
const TOKEN_URL = process.env.GP_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const SIZE = '=w2048-h2048';
let notify = () => {};
// Photo folder (env PHOTOS_DIR > admin setting > server/photos), resolved on every use so a move takes effect live.
const P = (f) => ST.fileOf(f);
// Writes/deletes of photo files (and anything that treats a photo as deleted) wait while the folder is unavailable.
function needStore() { const why = ST.pausedNow(); if (why) { const e = new Error(why); e.code = 503; throw e; } }

// Calendar day in the family's time zone, so "on this day" matches what the frame shows.
const TZ = process.env.TZ || 'America/Chicago';
const localDay = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
const today = () => localDay(Date.now());
// Photos deleted one by one in admin are remembered so picks/album checks don't bring them back.
const gone = (source, extId) => !!get('SELECT 1 FROM photo_tombstones WHERE source = ? AND ext_id = ?', source, extId);
const newFile = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex') + '.jpg';

// ------------------------------------------------------------------ dedup (sha256 of the bytes) + memberships
// Exact-bytes only. A perceptual hash (catching re-encodes / resizes) could be a later step.
export const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const byHash = (h) => get('SELECT id FROM photos WHERE sha256 = ? ORDER BY id LIMIT 1', h);
// A deleted photo is also remembered by its hash (photo_tombstones source 'sha256'), so the same picture
// arriving from another album / the picker stays deleted.
export const hashGone = (h) => !!get("SELECT 1 FROM photo_tombstones WHERE source = 'sha256' AND ext_id = ?", h);
const hasLink = (photoId, source, sourceId, extId) => !!get('SELECT 1 FROM photo_links WHERE photo_id = ? AND source = ? AND source_id IS ? AND ext_id IS ?', photoId, source, sourceId, extId);
export function link(photoId, source, sourceId, extId) {
  if (!hasLink(photoId, source, sourceId, extId)) run('INSERT INTO photo_links (photo_id, source, source_id, ext_id) VALUES (?, ?, ?, ?)', photoId, source, sourceId, extId);
}
// Store a downloaded/uploaded picture once. Returns { id, dup } (dup = an existing photo got this membership instead),
// or null when the same bytes were deleted before (hash tombstone).
export function storePhoto(buf, row, src) {
  needStore();
  const h = sha(buf);
  if (src.source !== 'upload' && hashGone(h)) return null;
  const ex = byHash(h);
  if (ex) { link(ex.id, src.source, src.source_id, src.ext_id); return { id: ex.id, dup: true }; }
  const file = row.file || newFile();
  fs.writeFileSync(P(file), buf); ST.dirty();
  const cols = Object.assign({}, row, { file, sha256: h }, src.source === 'upload' ? {} : { source: src.source, ext_id: src.ext_id, source_id: src.source_id });
  const k = Object.keys(cols);
  const ins = run('INSERT OR IGNORE INTO photos (' + k.join(', ') + ') VALUES (' + k.map(() => '?').join(', ') + ')', ...k.map((c) => cols[c]));
  if (!ins.changes) { // another photos row already owns (source, ext_id): link to it
    fs.rmSync(P(file), { force: true });
    const o = get('SELECT id FROM photos WHERE source = ? AND ext_id = ?', src.source, src.ext_id);
    if (!o) return null;
    link(o.id, src.source, src.source_id, src.ext_id); return { id: o.id, dup: true };
  }
  const id = Number(ins.lastInsertRowid);
  link(id, src.source, src.source_id, src.ext_id);
  return { id, dup: false };
}
// Delete photos that no source holds any more (file + row). Returns how many.
export function dropOrphans() {
  if (ST.paused() || !ST.check()) return 0; // folder unavailable: leave rows/files alone, a later call cleans up
  let n = 0;
  for (const p of all('SELECT id, file FROM photos WHERE id NOT IN (SELECT photo_id FROM photo_links)')) {
    fs.rmSync(P(p.file), { force: true });
    run('DELETE FROM photos WHERE id = ?', p.id); n++;
  }
  if (n) ST.dirty();
  return n;
}
// Startup: hash photos stored before dedup existed (a few per tick), then merge exact duplicates into the oldest copy.
function backfillHashes() {
  if (ST.pausedNow()) return setTimeout(backfillHashes, 60e3); // an unplugged folder would make every photo look 'missing'
  const rows = all('SELECT id, file FROM photos WHERE sha256 IS NULL LIMIT 20');
  for (const p of rows) {
    let h = 'missing:' + p.id;
    try { h = sha(fs.readFileSync(P(p.file))); } catch {}
    run('UPDATE photos SET sha256 = ? WHERE id = ?', h, p.id);
  }
  if (rows.length) return setTimeout(backfillHashes, 50);
  let merged = 0;
  for (const d of all("SELECT sha256, MIN(id) AS keep FROM photos WHERE sha256 IS NOT NULL AND sha256 NOT LIKE 'missing:%' GROUP BY sha256 HAVING COUNT(*) > 1")) {
    for (const o of all('SELECT id FROM photos WHERE sha256 = ? AND id <> ?', d.sha256, d.keep)) {
      for (const l of all('SELECT source, source_id, ext_id FROM photo_links WHERE photo_id = ?', o.id)) link(d.keep, l.source, l.source_id, l.ext_id);
      run('DELETE FROM photo_links WHERE photo_id = ?', o.id); merged++;
    }
  }
  const dropped = dropOrphans();
  console.log('[photos] hashes ready' + (merged ? ', merged ' + merged + ' duplicate copies (' + dropped + ' files removed)' : ''));
  if (merged) notify('photos');
}

// ------------------------------------------------------------------ OAuth client + tokens
export function redirectUri() { return 'http://localhost:' + (+process.env.PORT || 3030) + '/api/google/callback'; }
function client() {
  return { id: process.env.GOOGLE_CLIENT_ID || getSetting('google_client_id') || '', secret: process.env.GOOGLE_CLIENT_SECRET || getSetting('google_client_secret') || '' };
}
let oauthState = null, access = null; // { token, until }
export function authUrl() {
  const c = client();
  if (!c.id || !c.secret) throw new Error('Save the Google client ID and secret first');
  oauthState = crypto.randomBytes(16).toString('hex');
  return AUTH_URL + '?' + new URLSearchParams({ client_id: c.id, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state: oauthState });
}
async function tokenCall(params) {
  const c = client();
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.assign({ client_id: c.id, client_secret: c.secret }, params)) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google: ' + (j.error_description || j.error || 'HTTP ' + r.status));
  access = { token: j.access_token, until: Date.now() + ((j.expires_in || 3600) - 60) * 1000 };
  return j;
}
// Called with the ?code=&state= Google sent back (either to the callback or pasted into admin).
export async function finishAuth(code, state) {
  if (!oauthState || state !== oauthState) throw new Error('This sign-in link is stale, press Connect Google again');
  oauthState = null;
  const j = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() });
  if (!j.refresh_token) throw new Error('Google sent no refresh token, remove the app at myaccount.google.com/permissions and connect again');
  setSetting('google_refresh_token', j.refresh_token);
  setSetting('google_connected_at', new Date().toISOString());
  notify('photos');
}
async function token() {
  if (access && access.until > Date.now()) return access.token;
  const rt = getSetting('google_refresh_token');
  if (!rt) throw new Error('Google isn’t connected');
  await tokenCall({ refresh_token: rt, grant_type: 'refresh_token' });
  return access.token;
}
export function disconnect() { setSetting('google_refresh_token', null); setSetting('google_connected_at', null); access = null; picker = { status: 'idle' }; }

// ------------------------------------------------------------------ Picker sessions
let picker = { status: 'idle' }; // idle | picking | downloading | done | error
async function gapi(method, p) {
  const r = await fetch(PICKER + p, { method, headers: { Authorization: 'Bearer ' + await token() } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Google Photos: ' + ((j.error && j.error.message) || 'HTTP ' + r.status));
  return j;
}
const secs = (s, def) => (parseFloat(s) || def) * 1000; // "5s" -> 5000
export async function startPick() {
  if (picker.status === 'picking' || picker.status === 'downloading') return picker;
  const s = await gapi('POST', '/sessions');
  picker = { status: 'picking', id: s.id, uri: s.pickerUri + '/autoclose', added: 0, skipped: 0, failed: 0, lastError: '', until: Date.now() + secs(s.pollingConfig && s.pollingConfig.timeoutIn, 1800) };
  pollPick(s.id, secs(s.pollingConfig && s.pollingConfig.pollInterval, 5));
  return picker;
}
export function cancelPick() { if (picker.id) gapi('DELETE', '/sessions/' + picker.id).catch(() => {}); picker = { status: 'idle' }; }
function pollPick(id, every) {
  setTimeout(async () => {
    if (picker.id !== id || picker.status !== 'picking') return;
    try {
      const s = await gapi('GET', '/sessions/' + id);
      if (s.mediaItemsSet) return downloadPicked(id);
      if (Date.now() > picker.until) throw new Error('The picker timed out, press Pick photos again');
      pollPick(id, secs(s.pollingConfig && s.pollingConfig.pollInterval, every / 1000));
    } catch (e) { picker = { status: 'error', error: e.message }; notify('photos'); }
  }, every);
}
async function downloadPicked(id) {
  picker.status = 'downloading'; notify('photos');
  try {
    needStore();
    let page = '';
    do {
      const j = await gapi('GET', '/mediaItems?sessionId=' + id + '&pageSize=100' + (page ? '&pageToken=' + encodeURIComponent(page) : ''));
      for (const m of j.mediaItems || []) {
        if (m.type && m.type !== 'PHOTO') { picker.skipped++; continue; } // videos aren't shown on the frame
        if (gone('google-picker', m.id) || get("SELECT 1 FROM photo_links WHERE source = 'google-picker' AND ext_id = ?", m.id)) { picker.skipped++; continue; }
        const f = m.mediaFile || {}, meta = f.mediaFileMetadata || {};
        // baseUrl needs the Bearer token; =w..-h.. gives a frame-sized JPEG (=d would be the full original).
        const r = await fetch(f.baseUrl + SIZE, { headers: { Authorization: 'Bearer ' + await token() } });
        if (!r.ok) { picker.failed++; picker.lastError = 'Download failed (HTTP ' + r.status + ')'; continue; }
        const sp = storePhoto(Buffer.from(await r.arrayBuffer()), { date: m.createTime ? localDay(m.createTime) : today(), orient: +meta.height > +meta.width ? 'p' : 'l' },
          { source: 'google-picker', source_id: null, ext_id: m.id });
        if (!sp) picker.skipped++; else if (sp.dup) { picker.dups = (picker.dups || 0) + 1; picker.skipped++; } else picker.added++;
      }
      page = j.nextPageToken;
    } while (page);
    picker.status = 'done'; picker.at = new Date().toISOString();
  } catch (e) { picker.status = 'error'; picker.error = e.message; }
  gapi('DELETE', '/sessions/' + id).catch(() => {});
  notify('photos');
}

// ------------------------------------------------------------------ public shared albums (unofficial)
const running = new Set();
// Album pages embed each photo as ["AF1Qip…",["https://lh3.googleusercontent.com/pw/…",width,height,…],takenMs,…
export function parseAlbum(html) {
  const out = new Map();
  const rich = /\["(AF1Qip[\w-]+)",\["(https:\/\/lh3\.googleusercontent\.com\/(?:pw\/)?[\w-]{30,})",(\d+),(\d+)[^\]]*\],?(\d{13})?/g;
  let m;
  while ((m = rich.exec(html))) if (!out.has(m[1])) out.set(m[1], { id: m[1], url: m[2], w: +m[3], h: +m[4], ms: m[5] ? +m[5] : 0 });
  if (!out.size) { // layout changed: fall back to any album-photo URL on the page
    for (const u of new Set(html.match(/https:\/\/lh3\.googleusercontent\.com\/pw\/[\w-]+/g) || [])) {
      const id = crypto.createHash('sha1').update(u).digest('hex').slice(0, 20);
      out.set(id, { id, url: u, w: 0, h: 0, ms: 0 });
    }
  }
  const title = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '';
  return { title: title.replace(/&#39;/g, '\'').replace(/&amp;/g, '&'), photos: [...out.values()] };
}
// Accepts photos.app.goo.gl/<id> short links and photos.google.com[/u/N]/share/<id>?key=<key> (http or https, with or without "www.").
const ALBUM_RE = /^(?:https?:\/\/)?(?:www\.)?(photos\.app\.goo\.gl\/[\w-]+|photos\.google\.com\/(?:u\/\d+\/)?share\/[\w-]+)/i;
export function cleanAlbumUrl(u) { const t = String(u || '').trim(); return ALBUM_RE.test(t) ? 'https://' + t.replace(/^(?:https?:\/\/)?(?:www\.)?/i, '') : t; }
export function validAlbumUrl(u) { return ALBUM_RE.test(String(u || '').trim()); }
const UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126 Safari/537.36';
// Short links answer browsers with a JavaScript page (no photos), but plain clients get a 302 to the album: follow it by hand.
// Album keys work like passwords: never log more than the last 4 characters.
export function redactUrl(u) { return String(u == null ? '' : u).replace(/([?&]key=)([\w-]*)/g, (m, k, v) => k + '…' + v.slice(-4)); }
export function shareIdOf(u) { const m = String(u || '').match(/photos\.google\.com\/(?:u\/\d+\/)?share\/([\w-]+)/i); return m ? m[1] : null; }
async function resolveAlbumUrl(u) {
  let cur = cleanAlbumUrl(u);
  for (let hop = 0; hop < 5 && /photos\.app\.goo\.gl\//i.test(cur); hop++) {
    const r = await fetch(cur, { redirect: 'manual', headers: { 'User-Agent': 'curl/8 photo-frame' }, signal: AbortSignal.timeout(20e3) });
    const loc = r.headers.get('location');
    if (r.status === 404) throw new Error('Album link not found. It may have been deleted or mistyped.');
    if (!(r.status >= 300 && r.status < 400) || !loc) throw new Error('Couldn’t open the short link (HTTP ' + r.status + '). Try the full photos.google.com/share/… link.');
    cur = new URL(loc, cur).href;
  }
  cur = cur.replace(/photos\.google\.com\/u\/\d+\/share\//, 'photos.google.com/share/');
  // Trim trailing slashes in the path (…/share/<id>/?key=…) so they aren't read as a photo link.
  cur = cur.replace(/^(https:\/\/photos\.google\.com\/share\/[\w-]+)\/+(?=\?|$)/i, '$1');
  if (!/^https:\/\/photos\.google\.com\/share\/[\w-]+/.test(cur)) throw new Error('That link isn’t a shared album (it opens ' + cur.slice(0, 80) + ').');
  if (/^https:\/\/photos\.google\.com\/share\/[\w-]+\/./.test(cur)) throw new Error('That’s a link to one photo, not the album. Open the album itself → Share → Create link, and paste that.');
  if (!/[?&]key=[\w-]+/.test(cur)) throw new Error('This link has no ?key=… part, so it only works for people signed in to the album. Use Share → Create link and paste that.');
  return cur;
}
// Resolve + open an album link before it's saved: throws the specific reason when it can't work.
const shareIds = new Map(); // saved album url -> share id (short links resolved once)
export async function probeAlbum(u) {
  const page = await resolveAlbumUrl(u);
  const r = await fetch(page, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(30e3) });
  if (r.status === 404 || r.status === 403 || r.status === 400) throw new Error('Google Photos couldn’t open this album (HTTP ' + r.status + '). The key may be wrong, or link sharing was turned off. Paste a fresh link from Share → Create link.');
  if (!r.ok) throw new Error('Google Photos returned HTTP ' + r.status + ' for this album. Try again in a minute.');
  if (/accounts\.google\.com\//.test(r.url)) throw new Error('Album is private: Google asked to sign in. Turn on link sharing for the album.');
  const html = await r.text(), { title, photos } = parseAlbum(html), d = albumData(html);
  if (!photos.length) throw new Error('Found 0 photos at this link. The key may be wrong, or the album is empty.');
  const sid = shareIdOf(page); shareIds.set(cleanAlbumUrl(u), sid);
  return { page, shareId: sid, title, count: d && Array.isArray(d[3]) && Number.isInteger(d[3][21]) ? d[3][21] : photos.length };
}
// Share id of an already-saved album (resolves short links once, then cached). null if it can't be resolved.
export async function savedShareId(url) {
  if (shareIdOf(url)) return shareIdOf(url);
  if (shareIds.has(url)) return shareIds.get(url);
  try { const sid = shareIdOf(await resolveAlbumUrl(url)); shareIds.set(url, sid); return sid; } catch { return null; }
}
// ---- paging. The album page embeds only the first batch (300 items) as AF_initDataCallback 'ds:1':
//   [null, [items…], nextPageToken, [albumKey, title, …, (21) itemCount, …], …]
// The rest comes from the same RPC the web page calls while scrolling: batchexecute rpcid 'snAcKc' with
// [albumKey, pageToken, null, authKey], answered with the same shape. We follow the token until it's empty.
const PAGE_MAX = +process.env.GP_PAGE_MAX || 60;        // 60 × 300 = 18,000 items, then we stop and call the read partial
const PAGE_DELAY = +process.env.GP_PAGE_DELAY || 700;   // ms between page requests (be gentle)
const BATCH = process.env.GP_BATCH_URL || 'https://photos.google.com/_/PhotosUi/data/batchexecute';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function albumData(html) {
  const m = html.match(/AF_initDataCallback\(\{key: 'ds:1'[^]*?data:([^]*?), sideChannel/);
  if (!m) return null;
  try { const d = JSON.parse(m[1]); return Array.isArray(d) && Array.isArray(d[1]) ? d : null; } catch { return null; }
}
function albumItems(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    if (!Array.isArray(x) || typeof x[0] !== 'string' || !Array.isArray(x[1]) || typeof x[1][0] !== 'string') continue;
    if (!/^https:\/\/lh3\.googleusercontent\.com\//.test(x[1][0])) continue;
    out.push({ id: x[0], url: x[1][0], w: +x[1][1] || 0, h: +x[1][2] || 0, ms: typeof x[2] === 'number' ? x[2] : 0 });
  }
  return out;
}
let reqId = Math.floor(Math.random() * 9e4) + 1e4;
async function albumPage(page, ctx, token) {
  const q = [ctx.mediaKey, token, null, ctx.authKey];
  const url = BATCH + '?' + new URLSearchParams({ rpcids: 'snAcKc', 'source-path': new URL(page).pathname, 'f.sid': ctx.sid, bl: ctx.bl, hl: 'en', 'soc-app': '165', 'soc-platform': '1', 'soc-device': '1', _reqid: String(reqId += 100000), rt: 'c' });
  const r = await fetch(url, { method: 'POST', body: 'f.req=' + encodeURIComponent(JSON.stringify([[['snAcKc', JSON.stringify(q), null, 'generic']]])),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': UA, 'Accept-Language': 'en', Origin: 'https://photos.google.com', Referer: 'https://photos.google.com/' }, signal: AbortSignal.timeout(30e3) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const m = (await r.text()).match(/\["wrb\.fr","snAcKc",("(?:[^"\\]|\\.)*")/);
  if (!m) throw new Error('unexpected answer (no album data)');
  const d = JSON.parse(JSON.parse(m[1]));
  if (!Array.isArray(d)) throw new Error('unexpected answer');
  return d;
}
// Read every photo of an album page (the HTML already fetched), following the next-page tokens.
// complete = every page was read AND the count matches what Google says the album holds. Only then may photos be pruned.
export async function readAlbum(page, html, log = () => {}) {
  const d = albumData(html);
  if (!d) { // layout changed: only what the page embeds. The first batch is 300, so fewer than that is the whole album.
    const p = parseAlbum(html);
    const complete = p.photos.length > 0 && p.photos.length < 300;
    return { title: p.title, photos: p.photos, total: null, pages: 1, complete, why: complete ? null : 'the page layout changed, so only the first ' + p.photos.length + ' photos could be read' };
  }
  const og = (html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1]; // same title format as before ("Name · dates 📸")
  const title = og ? og.replace(/&#39;/g, '\'').replace(/&amp;/g, '&') : (Array.isArray(d[3]) && typeof d[3][1] === 'string' ? d[3][1] : '');
  const total = Array.isArray(d[3]) && Number.isInteger(d[3][21]) ? d[3][21] : null;
  const seen = new Map();
  for (const it of albumItems(d[1])) if (!seen.has(it.id)) seen.set(it.id, it);
  let token = typeof d[2] === 'string' && d[2] ? d[2] : null, pages = 1, why = null;
  log('page 1: ' + seen.size + ' photos' + (total != null ? ' (album has ' + total + ')' : '') + (token ? ', more pages' : ''));
  if (token) {
    let req = null;
    try { req = JSON.parse((html.match(/'ds:1' : \{id:'snAcKc'[^}]*?request:(\[[^\]]*\])/) || [])[1] || 'null'); } catch {}
    const ctx = { mediaKey: (req && req[0]) || (Array.isArray(d[3]) && d[3][0]), authKey: (req && req[3]) || ((page.match(/[?&]key=([\w-]+)/) || [])[1]),
      sid: (html.match(/"FdrFJe":"(-?\d+)"/) || [])[1], bl: (html.match(/"cfb2h":"([^"]+)"/) || [])[1] };
    if (!ctx.mediaKey || !ctx.authKey || !ctx.sid || !ctx.bl) why = 'the page didn’t include what’s needed to load more pages';
    while (token && !why) {
      if (pages >= PAGE_MAX) { why = 'stopped after ' + PAGE_MAX + ' pages'; break; }
      await sleep(PAGE_DELAY);
      let dd = null, err = null;
      for (let attempt = 0; attempt < 3 && !dd; attempt++) {
        try {
          if (+process.env.GP_TEST_FAIL_PAGE === pages + 1) throw new Error('simulated failure (GP_TEST_FAIL_PAGE)'); // test hook
          dd = await albumPage(page, ctx, token);
        } catch (e) { err = e; if (attempt < 2) await sleep(1500 * (attempt + 1)); }
      }
      if (!dd) { why = 'page ' + (pages + 1) + ' failed (' + (err && err.message) + ')'; break; }
      pages++;
      const items = albumItems(dd[1]), next = typeof dd[2] === 'string' && dd[2] ? dd[2] : null;
      if (!items.length && next) { why = 'page ' + pages + ' came back empty'; break; }
      for (const it of items) if (!seen.has(it.id)) seen.set(it.id, it);
      log('page ' + pages + ': ' + items.length + ' photos, ' + seen.size + ' so far' + (next ? ', more pages' : ', last page'));
      if (next && next === token) { why = 'Google repeated the same page'; break; }
      token = next;
    }
  }
  if (!why && total != null && seen.size < total) why = 'Google says the album has ' + total + ' items but listed ' + seen.size;
  return { title, photos: [...seen.values()], total, pages, complete: !why, why };
}
// The old scraper missed each photo's taken time, so those photos got their download day as date. Give them the real
// day, but only while the date still equals the download day (a date changed by hand in admin stays).
function fixDate(photoId, ms) {
  const ph = get('SELECT date, created_at FROM photos WHERE id = ?', photoId);
  if (!ph || !ph.created_at) return 0;
  const dl = localDay(String(ph.created_at).replace(' ', 'T') + 'Z'), real = localDay(ms);
  if (ph.date === dl && real !== dl) { run('UPDATE photos SET date = ? WHERE id = ?', real, photoId); return 1; }
  return 0;
}
const progress = new Map(); // album id -> { stage, pages, read, added } while a check runs
export async function checkAlbum(id) {
  const a = get('SELECT * FROM google_albums WHERE id = ?', id);
  if (!a || running.has(id)) return;
  const why = ST.paused() || (ST.check() ? null : ST.paused());
  if (why) { // folder unavailable / moving: don't download, don't prune, don't count misses
    console.log('[album #' + id + '] skipped: ' + why);
    run('UPDATE google_albums SET last_warning = ? WHERE id = ?', 'Paused: ' + why + ' Nothing was downloaded or removed.', id);
    notify('photos'); return 0;
  }
  running.add(id);
  const prog = { stage: 'reading', pages: 0, read: 0, total: null, added: 0 }; progress.set(id, prog);
  let added = 0, failed = 0, skipped = 0;
  console.log('[album #' + id + '] checking', redactUrl(a.url));
  try {
    const page = await resolveAlbumUrl(a.url);
    if (page !== a.url) console.log('[album #' + id + '] resolved to', redactUrl(page));
    const r = await fetch(page, { redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'en' }, signal: AbortSignal.timeout(30e3) });
    if (r.status === 404 || r.status === 403) throw new Error('Album is private or the link expired (HTTP ' + r.status + '). Turn link sharing back on in Google Photos and paste a new link.');
    if (!r.ok) throw new Error('Google Photos returned HTTP ' + r.status + ' for this album. Will retry.');
    const html = await r.text();
    if (/accounts\.google\.com\/(?:ServiceLogin|signin)/.test(r.url)) throw new Error('Album is private: Google asked to sign in. Turn on link sharing for the album.');
    const rd = await readAlbum(page, html, (m) => console.log('[album #' + id + '] ' + m));
    const { title, photos } = rd;
    Object.assign(prog, { stage: 'downloading', pages: rd.pages, read: photos.length, total: rd.total }); notify('photos');
    console.log('[album #' + id + '] "' + title + '": read ' + photos.length + (rd.total != null ? ' of ' + rd.total : '') + ' photos in ' + rd.pages + ' page' + (rd.pages === 1 ? '' : 's') + (rd.complete ? ' (complete)' : ' (PARTIAL: ' + rd.why + ')'));
    if (!photos.length) throw new Error('Found 0 photos in this album. It may be empty, or the page layout changed.');
    let dups = 0, removed = 0, warning = null, n = 0, datesFixed = 0;
    const seen = new Set();
    for (const p of photos) {
      seen.add(p.id);
      if (gone('google-album', p.id)) { skipped++; continue; }
      const have = get("SELECT photo_id FROM photo_links WHERE source = 'google-album' AND source_id = ? AND ext_id = ?", id, p.id);
      if (have) { skipped++; if (p.ms) datesFixed += fixDate(have.photo_id, p.ms); continue; }
      // Kept from a removed album and re-added: adopt it back.
      const kept = get("SELECT id FROM photo_links WHERE source = 'google-album' AND source_id IS NULL AND ext_id = ?", p.id);
      if (kept) { run('UPDATE photo_links SET source_id = ? WHERE id = ?', id, kept.id); skipped++; continue; }
      // Same Google photo already in another album: one more membership, no second download.
      const other = get("SELECT photo_id FROM photo_links WHERE source = 'google-album' AND ext_id = ? LIMIT 1", p.id);
      if (other) { link(other.photo_id, 'google-album', id, p.id); dups++; continue; }
      if (ST.pausedNow()) throw new Error(ST.paused()); // folder went away mid-check: stop (the catch skips pruning)
      const img = await fetch(p.url + SIZE, { signal: AbortSignal.timeout(60e3) }).catch((e) => ({ ok: false, status: e.name || 'error', headers: new Headers() }));
      if (!img.ok || !/^image\//.test(img.headers.get('content-type') || '')) { failed++; console.log('[album #' + id + '] download failed: HTTP ' + img.status); continue; }
      const sp = storePhoto(Buffer.from(await img.arrayBuffer()), { date: p.ms ? localDay(p.ms) : today(), orient: p.h > p.w ? 'p' : 'l' }, { source: 'google-album', source_id: id, ext_id: p.id });
      if (!sp) skipped++; else if (sp.dup) dups++; else { added++; prog.added = added; }
      if (++n % 40 === 0) notify('photos'); // admin counts move during a long first import
    }
    if (failed && !added && !dups && failed === photos.length) throw new Error('Found ' + photos.length + ' photos but couldn’t download ' + failed);
    // Removal sync, only after a COMPLETE read (every page, count matches). Partial read: nothing pruned, no misses counted.
    // Errors / 0 photos threw above (nothing pruned). A drop of 50% or more vs the last accepted count is
    // suspicious: warn and prune nothing this round, unless the previous check warned with this same count (then it's real).
    // A membership is pruned only after it's been missing from 2 consecutive successful complete checks.
    // No count yet (album checked before this column existed): compare with the memberships it has now.
    const prev = a.last_count || get("SELECT COUNT(*) AS n FROM photo_links WHERE source = 'google-album' AND source_id = ?", id).n;
    const storeWhy = ST.paused() || (ST.check() ? null : ST.paused());
    let pending = 0;
    if (!rd.complete || storeWhy) {
      warning = storeWhy ? 'Paused: ' + storeWhy + ' Nothing was removed.'
        : 'Only the first ' + photos.length + (rd.total != null ? ' of ' + rd.total : '') + ' photos could be read from this album (' + rd.why + '), so nothing was removed.';
      for (const l of all("SELECT id, ext_id, miss_count FROM photo_links WHERE source = 'google-album' AND source_id = ? AND miss_count > 0", id)) if (seen.has(l.ext_id)) run('UPDATE photo_links SET miss_count = 0 WHERE id = ?', l.id);
    } else {
      const bigDrop = prev > 0 && photos.length <= prev * 0.5;
      const confirmed = bigDrop && a.last_warning && a.last_seen_count === photos.length && !/^Check failed/.test(a.last_warning);
      if (bigDrop && !confirmed) warning = 'Found only ' + photos.length + ' of the ' + prev + ' photos seen last time, so nothing was removed. If photos really were taken out of the album, they come off after the next checks agree.';
      for (const l of all("SELECT id, ext_id, miss_count FROM photo_links WHERE source = 'google-album' AND source_id = ?", id)) {
        if (seen.has(l.ext_id)) { if (l.miss_count) run('UPDATE photo_links SET miss_count = 0 WHERE id = ?', l.id); continue; }
        const m = (l.miss_count || 0) + 1;
        if (m >= 2 && !warning) { run('DELETE FROM photo_links WHERE id = ?', l.id); removed++; }
        else { run('UPDATE photo_links SET miss_count = ? WHERE id = ?', Math.min(m, 2), l.id); pending++; }
      }
      if (removed) dropOrphans();
    }
    const now = new Date().toISOString();
    run('UPDATE google_albums SET title = COALESCE(?, title), last_checked = ?, last_ok = ?, last_error = ?, last_count = ?, last_removed = ?, last_dups = ?, last_warning = ?, last_total = ?, last_read = ?, last_pages = ?, last_complete = ? WHERE id = ?',
      title || null, now, now, failed ? failed + ' photo' + (failed === 1 ? '' : 's') + ' couldn’t be downloaded, will retry' : null,
      rd.complete ? (warning ? prev : photos.length) : Math.max(prev, photos.length), removed, dups, warning, rd.total, photos.length, rd.pages, rd.complete ? 1 : 0, id);
    if (rd.complete) run('UPDATE google_albums SET last_seen_count = ? WHERE id = ?', photos.length, id);
    if (datesFixed) { console.log('[album #' + id + '] set the real taken date on ' + datesFixed + ' photos stored with their download day'); }
    console.log('[album #' + id + '] done: ' + rd.pages + ' page' + (rd.pages === 1 ? '' : 's') + ', ' + added + ' new, ' + dups + ' duplicates linked, ' + skipped + ' already here/hidden, ' + failed + ' failed, ' + removed + ' removed, ' + pending + ' missing once (removed if still missing next check)' + (warning ? ' (pruning skipped: ' + (rd.complete ? photos.length + '/' + prev : 'partial read') + ')' : ''));
  } catch (e) {
    console.log('[album #' + id + '] error:', e.message || e);
    run('UPDATE google_albums SET last_checked = ?, last_error = ?, last_warning = ? WHERE id = ?', new Date().toISOString(), String(e.message || e).slice(0, 300), 'Check failed, so nothing was removed from the frame.', id);
  } finally { running.delete(id); progress.delete(id); notify('photos'); }
  return added;
}
// A photo deleted on its own: remember every source's id (and its hash) so it isn't downloaded again from anywhere.
const albumKey = (id) => { const a = id == null ? null : get('SELECT url FROM google_albums WHERE id = ?', id); return a ? a.url : null; };
// key = the per-screen source key to remove it from ('upload', 'picker', 'kept', 'album:<id>'); omitted = its first source.
// Only that membership (+ its tombstone) goes; the file is deleted only when no source references it any more.
// Returns { removed, left: [keys still showing it] }.
export function deletePhoto(photoId, key, keyOf) {
  needStore();
  const p = get('SELECT id, file, sha256 FROM photos WHERE id = ?', photoId);
  if (!p) return null;
  const links = all('SELECT id, source, source_id, ext_id FROM photo_links WHERE photo_id = ? ORDER BY id', p.id);
  const mine = links.filter((l) => (key ? keyOf(l) === key : keyOf(l) === keyOf(links[0] || {})));
  if (links.length && !mine.length) return { removed: false, left: [...new Set(links.map(keyOf))] };
  for (const l of mine) {
    if (l.source !== 'upload' && l.ext_id) run('INSERT OR IGNORE INTO photo_tombstones (source, ext_id, source_id, source_key) VALUES (?, ?, ?, ?)',
      l.source, l.ext_id, l.source_id, l.source === 'google-album' ? albumKey(l.source_id) : null);
    run('DELETE FROM photo_links WHERE id = ?', l.id);
  }
  const rest = links.filter((l) => mine.indexOf(l) < 0);
  if (!rest.length) { // last reference: hash tombstone (same bytes from elsewhere stay deleted), then the file
    const g = mine.find((l) => l.source === 'google-album' && l.source_id != null) || mine.find((l) => l.source !== 'upload');
    if (g && p.sha256 && !/^missing:/.test(p.sha256)) run("INSERT OR IGNORE INTO photo_tombstones (source, ext_id, source_id, source_key) VALUES ('sha256', ?, ?, ?)",
      p.sha256, g.source_id, g.source === 'google-album' ? albumKey(g.source_id) : g.source);
    dropOrphans();
  }
  return { removed: true, left: [...new Set(rest.map(keyOf))] };
}
// Removing a whole source with its photos also forgets its deleted-photo list (call before deleting the album row).
export function forget(source, sourceId) {
  needStore();
  if (sourceId == null) { run("DELETE FROM photo_tombstones WHERE source = 'sha256' AND source_key = ?", source); return run('DELETE FROM photo_tombstones WHERE source = ?', source); }
  const key = albumKey(sourceId);
  if (key) run("DELETE FROM photo_tombstones WHERE source IN (?, 'sha256') AND source_key = ?", source, key);
  // Old rows from before source_key whose album was already gone can't be matched by URL.
  run('DELETE FROM photo_tombstones WHERE source = ? AND source_key IS NULL AND source_id = ?', source, sourceId);
}
// Remove a source's pictures: its memberships go; pictures still in another source stay. sourceId undefined = whole source.
export function removeSource(source, sourceId) {
  needStore();
  if (sourceId === undefined) run('DELETE FROM photo_links WHERE source = ?', source);
  else run('DELETE FROM photo_links WHERE source = ? AND source_id IS ?', source, sourceId);
  return dropOrphans();
}
// Album removed but photos kept: they move to the 'kept' bucket.
export function keepSource(sourceId) {
  run("UPDATE photo_links SET source_id = NULL WHERE source = 'google-album' AND source_id = ?", sourceId);
  run("UPDATE photos SET source_id = NULL WHERE source = 'google-album' AND source_id = ?", sourceId);
}

// ------------------------------------------------------------------ admin view + start
export function googleAdmin() {
  const c = client();
  return {
    client_id: c.id, secret_set: !!c.secret, secret_hint: c.secret ? '…' + c.secret.slice(-4) : '', from_env: !!process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(), connected: !!getSetting('google_refresh_token'), connected_at: getSetting('google_connected_at') || '',
    picker: { status: picker.status, uri: picker.uri || '', added: picker.added || 0, skipped: picker.skipped || 0, dups: picker.dups || 0, failed: picker.failed || 0, last_error: picker.lastError || '', error: picker.error || '', at: picker.at || '' },
    picked: get("SELECT COUNT(DISTINCT photo_id) AS n FROM photo_links WHERE source = 'google-picker'").n,
    albums: all('SELECT * FROM google_albums ORDER BY id').map((a) => ({ ...a, checking: running.has(a.id), progress: progress.get(a.id) || null,
      count: get("SELECT COUNT(DISTINCT photo_id) AS n FROM photo_links WHERE source = 'google-album' AND source_id = ?", a.id).n,
      // photos this album shares with a source that had them first (stored once, shown once)
      dups: get("SELECT COUNT(*) AS n FROM photo_links l WHERE l.source = 'google-album' AND l.source_id = ? AND EXISTS (SELECT 1 FROM photo_links o WHERE o.photo_id = l.photo_id AND o.id < l.id)", a.id).n }))
  };
}
export function startGoogle(broadcast) {
  notify = broadcast;
  setTimeout(backfillHashes, 0);
  const sweep = () => { for (const a of all('SELECT id FROM google_albums')) checkAlbum(a.id).catch(() => {}); };
  setTimeout(sweep, 60e3);
  setInterval(sweep, 6 * 3600e3);
}

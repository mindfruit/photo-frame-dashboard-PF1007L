// Where photo files live, whether that folder is usable right now, how big it is, and moving it.
// photos.file is always a bare file name, so a move only changes the folder setting.
//   Folder = env PHOTOS_DIR (wins) > setting photos_dir > server/photos.
// If the folder is missing / unreadable / doesn't hold our photos (unplugged drive, unmounted share), every
// operation that could treat a photo as deleted (removal sync, pruning, tombstones, orphan cleanup, downloads,
// uploads) is paused: callers check paused() first. The frame keeps showing whatever files it can still read.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { all, get, getSetting, setSetting } from './db.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DIR = path.join(HERE, 'photos');
const APP_DIR = path.dirname(HERE); // dashboard/: the app's own code, never a photo folder (except DEFAULT_DIR)
// Marks a folder as this server's photo store, so an empty mount point (drive not plugged in) isn't mistaken for it.
export const SENTINEL = '.photo-frame-store';
const GB = 1024 ** 3;
const RESERVE = 512 * 1024 ** 2; // always left free on the target by a move
export const LOW_FREE = 10 * GB;
let notify = () => {};

export function configured() {
  const env = (process.env.PHOTOS_DIR || '').trim(), set = (getSetting('photos_dir') || '').trim();
  return { dir: path.resolve(env || set || DEFAULT_DIR), from: env ? 'env' : set ? 'setting' : 'default' };
}
export const dir = () => configured().dir;
export const fileOf = (f) => path.join(dir(), path.basename(String(f || '')));

// ------------------------------------------------------------------ same-folder / inside tests
// Spellings lie (case-only changes on macOS, /tmp vs /private/tmp, symlinks), so compare the real path and the
// folder's device + inode. A path that doesn't exist yet is its parent's real path + its own name.
function real(p) {
  p = path.resolve(p);
  try { return fs.realpathSync.native(p); } catch { const up = path.dirname(p); return up === p ? p : path.join(real(up), path.basename(p)); }
}
const idOf = (p) => { try { const st = fs.statSync(p); return st.dev + ':' + st.ino; } catch { return null; } };
export function sameDir(a, b) {
  if (real(a) === real(b)) return true;
  const x = idOf(a); return !!x && x === idOf(b);
}
// true when `inner` is `outer` or anywhere below it: walks up inner's real path comparing each folder's dev + inode with outer's.
export function within(inner, outer) {
  const o = idOf(outer), ro = real(outer);
  for (let p = real(inner); ; p = path.dirname(p)) {
    if (p === ro || (o && idOf(p) === o)) return true;
    if (path.dirname(p) === p) return false;
  }
}
function isLinkTo(link, target) { try { return fs.lstatSync(link).isSymbolicLink() && sameFile(fs.realpathSync(link), target); } catch { return false; } }
function sameFile(a, b) { // the same file on disk (hard link / same folder under another name)
  try { const x = fs.statSync(a), y = fs.statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
}

let state = { ok: true, reason: '', dir: '' }, move = null; // move = running/last job (also saved in settings.photos_move)
const shaFile = (f) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('error', rej).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))); });

// A few photos spread over the whole collection (random, not the newest: fresh downloads into an empty mount point
// mustn't make it look like the store).
function hasImages(d) { try { return fs.readdirSync(d).some((n) => PHOTO_EXT.test(n)); } catch { return false; } }
// Re-check the folder. Cheap (stat + access + a few existsSync). Returns true when usable. Writes and deletes call
// this fresh (pausedNow()), not the 30 s cached state.
export function check() {
  const c = configured(), d = c.dir;
  let ok = true, reason = '';
  try {
    if (c.from === 'default') fs.mkdirSync(d, { recursive: true }); // never create a configured folder: it may be an unplugged drive's mount point
    const st = fs.statSync(d);
    if (!st.isDirectory()) throw new Error('isn’t a folder');
    fs.accessSync(d, fs.constants.R_OK | fs.constants.W_OK);
    if (!fs.existsSync(path.join(d, SENTINEL))) {
      // No marker. Adopted on its own only when nothing can be lost:
      //  - any folder (env / setting / default) when the db has NO photos and the folder holds no image files (fresh install);
      //  - the built-in server/photos when EVERY expected photo file is in it (a stat each; never a sample).
      // Otherwise a configured folder without a marker stays paused (it may be an empty mount point): choose it in admin.
      const expected = all('SELECT DISTINCT file FROM photos').map((p) => path.basename(p.file));
      if (expected.length || hasImages(d)) {
        if (c.from !== 'default') throw new Error('has no ' + SENTINEL + ' marker, so it may not be the photo folder (drive not plugged in?). If it is, open admin › Settings › Storage and press Use without moving');
        const there = expected.filter((f) => fs.existsSync(path.join(d, f))).length;
        if (there < expected.length) throw new Error('is there, but ' + missingText(expected.length - there, expected.length) + ' in it');
      }
      fs.writeFileSync(path.join(d, SENTINEL), 'Photo folder of the family dashboard. Keep this file.\n');
      console.log('[storage] adopted ' + d + ' as the photo folder (marker written)');
    }
  } catch (e) {
    ok = false;
    reason = 'Photo folder ' + d + ' ' + (e.code === 'ENOENT' ? 'is missing (drive unplugged?)' : e.code === 'EACCES' || e.code === 'EPERM' ? 'can’t be written' : e.code ? 'can’t be opened (' + e.code + ')' : e.message);
  }
  const changed = ok !== state.ok || reason !== state.reason || d !== state.dir;
  state = { ok, reason, dir: d };
  if (changed) {
    console.log(ok ? '[storage] photo folder OK: ' + d : '[storage] ' + reason + '. Downloads, removal sync and deletes are paused.');
    sizeAt = 0; notify('storage');
  }
  return ok;
}
// paused() after a fresh check(): use before writing or deleting any photo file.
export function pausedNow() { check(); return paused(); }
// null when photo files may be written/deleted, else the reason they may not (as of the last check()).
export function paused() {
  if (move && move.state === 'copying') return 'Photos are being moved to ' + move.to + '. Downloads and deletes wait until that’s done.';
  return state.ok ? null : state.reason;
}

// ------------------------------------------------------------------ size / free space (cached)
let sizeCache = { bytes: 0, files: 0 }, sizeAt = 0;
const PHOTO_EXT = /\.(jpe?g|png|webp|gif|heic|heif|avif)$/i;
export const fmtBytes = (n) => (n >= GB ? (n / GB).toFixed(1) + ' GB' : Math.max(n > 0 ? 0.1 : 0, n / 1024 ** 2).toFixed(1) + ' MB');
export function dirty() { sizeAt = Math.min(sizeAt, Date.now() - 4 * 60e3); } // recompute within ~1 min after a change
function folderSize(d) {
  let bytes = 0, files = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (!e.isFile() || e.name.startsWith('.') || !PHOTO_EXT.test(e.name)) continue; // photo files only (no .part, notes, …)
    try { bytes += fs.statSync(path.join(d, e.name)).size; files++; } catch {}
  }
  return { bytes, files };
}
export function volumeOf(d) {
  const s = fs.statfsSync(d);
  return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
}
export function info() {
  const c = configured();
  let vol = null, err = null;
  if (state.ok) {
    if (Date.now() - sizeAt > 5 * 60e3) { try { sizeCache = folderSize(c.dir); sizeAt = Date.now(); } catch (e) { err = e.message; } }
    try { vol = volumeOf(c.dir); } catch (e) { err = e.message; }
  }
  return {
    dir: c.dir, from: c.from, default_dir: DEFAULT_DIR, ok: state.ok, reason: state.reason, paused: paused(),
    bytes: state.ok ? sizeCache.bytes : null, files: state.ok ? sizeCache.files : null, size_at: sizeAt ? new Date(sizeAt).toISOString() : null,
    photos: get('SELECT COUNT(*) AS n FROM photos').n,
    free: vol ? vol.free : null, total: vol ? vol.total : null, low: !!(vol && vol.free < LOW_FREE), low_limit: LOW_FREE, error: err,
    move: move ? Object.assign({}, move, { files: undefined }) : null
  };
}

// ------------------------------------------------------------------ choosing / validating a folder
// Throws a readable Error when `d` can't hold photos; otherwise returns its volume info and how many of our photos are already there.
export function validate(d) {
  d = String(d || '').trim();
  if (!d) d = DEFAULT_DIR;
  if (!path.isAbsolute(d)) throw new Error('Use a full path that starts with / (for example /Volumes/Photos/frame).');
  d = path.resolve(d);
  if (within(d, APP_DIR) && !sameDir(d, DEFAULT_DIR)) throw new Error('That folder is inside the app’s own folder (' + APP_DIR + '). Pick one outside it, or leave the box empty for the built-in folder.');
  let st;
  try { st = fs.statSync(d); } catch (e) { throw new Error(e.code === 'ENOENT' ? 'That folder doesn’t exist. Create it first (and plug in the drive).' : 'Can’t open that folder (' + (e.code || e.message) + ').'); }
  if (!st.isDirectory()) throw new Error('That path is a file, not a folder.');
  const probe = path.join(d, '.pf-probe-' + crypto.randomBytes(4).toString('hex'));
  try { fs.writeFileSync(probe, 'probe'); if (fs.readFileSync(probe, 'utf8') !== 'probe') throw new Error('read back wrong'); } catch (e) { try { fs.rmSync(probe, { force: true }); } catch {} throw new Error('Can’t write to that folder (' + (e.code || e.message) + ').'); }
  fs.rmSync(probe, { force: true });
  const files = all('SELECT DISTINCT file FROM photos').map((p) => path.basename(p.file));
  const there = files.filter((f) => fs.existsSync(path.join(d, f))).length;
  // photo files there that are symlinks (e.g. into the old store): a move would leave the store made of links
  const links = files.filter((f) => { try { return fs.lstatSync(path.join(d, f)).isSymbolicLink(); } catch { return false; } }).length;
  const vol = volumeOf(d), need = needBytes(files, d);
  return { dir: d, same: sameDir(d, dir()), free: vol.free, total: vol.total, low: vol.free < LOW_FREE, photos: files.length, there, need, links,
    reserve: RESERVE, short: need > 0 && need > vol.free - RESERVE }; // short: copying would eat into the 512 MB kept free
}
function needBytes(files, target) {
  let n = 0;
  for (const f of files) { if (fs.existsSync(path.join(target, f))) continue; try { n += fs.statSync(path.join(dir(), f)).size; } catch {} }
  return n;
}
// "1 of the 262 photos isn’t" / "3 of the 262 photos aren’t"
function missingText(miss, total) { return miss + ' of the ' + total + (total === 1 ? ' photo' : ' photos') + (miss === 1 ? ' isn’t' : ' aren’t'); }
function envLock() { if (configured().from === 'env') throw new Error('PHOTOS_DIR is set in the server’s environment, so the folder can only be changed there.'); }
const setDir = (d) => setSetting('photos_dir', path.resolve(d) === DEFAULT_DIR ? null : path.resolve(d));
// Switch to a folder that already holds every photo (copied by hand). Nothing is copied or deleted.
export function use(d) {
  const env = configured().from === 'env';
  if (env && !sameDir(String(d || '').trim() || DEFAULT_DIR, dir())) envLock(); // under PHOTOS_DIR, Use only confirms that folder (writes its marker)
  if (move && (move.state === 'copying' || move.state === 'deleting')) throw new Error('A move is running.');
  const v = validate(d);
  if (v.links) throw new Error(v.links + ' of the photo files there ' + (v.links === 1 ? 'is a symlink' : 'are symlinks') + ' (probably into the current folder). Remove ' + (v.links === 1 ? 'it and copy the real file' : 'them and copy real files') + ', or pick another folder.');
  if (v.there < v.photos) throw new Error(missingText(v.photos - v.there, v.photos) + ' in that folder. ' + (env ? 'Copy ' + (v.photos - v.there === 1 ? 'it' : 'them') + ' in by hand, then press Use without moving again.' : 'Use “Move photos here” to copy ' + (v.photos - v.there === 1 ? 'it.' : 'them.')));
  if (!env) setDir(v.dir);
  if (!fs.existsSync(path.join(v.dir, SENTINEL))) fs.writeFileSync(path.join(v.dir, SENTINEL), 'Photo folder of the family dashboard. Keep this file.\n');
  check(); dirty(); notify('storage');
  return v;
}

// ------------------------------------------------------------------ move (copy → verify sha256 → switch → delete old copies)
// Resumable: progress lives in settings.photos_move. Copying again skips files whose copy already verifies; the old copy of a
// file is deleted only after EVERY file verified and the folder setting switched, and only if its new copy still matches.
const save = () => setSetting('photos_move', JSON.stringify(Object.assign({}, move, { files: undefined })));
export function startMove(d) {
  envLock();
  if (move && (move.state === 'copying' || move.state === 'deleting')) throw new Error('A move is already running.');
  if (!state.ok) throw new Error('The current photo folder isn’t available, so there’s nothing to copy from. ' + state.reason);
  const v = validate(d);
  if (v.same || sameDir(v.dir, dir())) throw new Error('That’s already the photo folder (the same folder under another name).');
  if (within(v.dir, dir()) || within(dir(), v.dir)) throw new Error('Pick a folder that isn’t inside the current one (or the other way round).');
  if (v.links) throw new Error(v.links + ' of the photo files there ' + (v.links === 1 ? 'is a symlink' : 'are symlinks') + ' (probably into the current folder). Remove ' + (v.links === 1 ? 'it and copy the real file' : 'them and copy real files') + ', or pick another folder.');
  if (v.short) throw new Error('Not enough free space there: need ' + fmtBytes(v.need) + ', ' + fmtBytes(Math.max(0, v.free - RESERVE)) + ' usable (' + fmtBytes(v.free) + ' free, 512 MB kept spare).');
  move = { from: dir(), to: v.dir, state: 'copying', total: 0, done: 0, copied: 0, skipped: 0, missing: 0, failed: 0, deleted: 0, kept: 0, failures: [], started: new Date().toISOString(), finished: null, error: null };
  save(); notify('storage');
  runMove().catch((e) => { move.state = 'error'; move.error = String(e.message || e); save(); notify('storage'); console.log('[storage] move error:', e); });
  return info().move;
}
async function runMove() {
  if (sameDir(move.from, move.to)) { // never "move" a folder onto itself (that would delete every photo)
    move.state = 'error'; move.error = 'From and to are the same folder, so nothing was copied or deleted.'; move.finished = new Date().toISOString();
    save(); notify('storage'); console.log('[storage] move refused: ' + move.from + ' and ' + move.to + ' are the same folder'); return;
  }
  const files = all('SELECT DISTINCT file FROM photos').map((p) => path.basename(p.file));
  const tick = () => new Promise((r) => setImmediate(r));
  if (move.state === 'copying') {
    move.total = files.length; move.done = move.copied = move.skipped = move.missing = move.failed = 0; move.failures = [];
    console.log('[storage] moving ' + files.length + ' photos: ' + move.from + ' → ' + move.to);
    for (const f of files) {
      const src = path.join(move.from, f), dst = path.join(move.to, f);
      try {
        if (!fs.existsSync(src)) { if (fs.existsSync(dst)) move.skipped++; else move.missing++; }
        else {
          const hs = await shaFile(src);
          if (fs.existsSync(dst) && (await shaFile(dst)) === hs) move.skipped++;
          else {
            const part = dst + '.part';
            await fs.promises.copyFile(src, part);
            if ((await shaFile(part)) !== hs) { fs.rmSync(part, { force: true }); throw new Error('copy didn’t match'); }
            fs.renameSync(part, dst); move.copied++;
          }
        }
      } catch (e) { move.failed++; if (move.failures.length < 20) move.failures.push(f + ': ' + (e.code || e.message)); }
      move.done++;
      if (move.done % 25 === 0) { save(); notify('storage-progress'); await tick(); }
    }
    if (move.failed) {
      move.state = 'error'; move.error = move.failed + ' file' + (move.failed === 1 ? '' : 's') + ' didn’t copy correctly, so nothing was switched or deleted. Fix the folder and press Move again (it resumes).';
      move.finished = new Date().toISOString(); save(); notify('storage'); console.log('[storage] move stopped: ' + move.error);
      return;
    }
    fs.writeFileSync(path.join(move.to, SENTINEL), 'Photo folder of the family dashboard. Keep this file.\n');
    setDir(move.to); move.state = 'deleting'; save(); check(); dirty(); notify('storage'); notify('photos');
    console.log('[storage] all ' + files.length + ' verified, switched to ' + move.to + ', removing old copies');
  }
  if (move.state === 'deleting') {
    move.deleted = move.kept = move.same = 0;
    for (const f of files) {
      const src = path.join(move.from, f), dst = path.join(move.to, f);
      try {
        if (fs.existsSync(src)) {
          if (sameFile(src, dst) || isLinkTo(dst, src)) move.same = (move.same || 0) + 1; // the old copy IS the new one (hard link / symlink): already there, never unlink
          else if (fs.existsSync(dst) && (await shaFile(dst)) === (await shaFile(src))) { fs.rmSync(src); move.deleted++; } else move.kept++;
        }
      } catch { move.kept++; }
      if ((move.deleted + move.kept) % 50 === 0) { save(); notify('storage-progress'); await tick(); }
    }
    if (!move.kept && !move.same && !sameDir(move.from, move.to)) { try { fs.rmSync(path.join(move.from, SENTINEL), { force: true }); } catch {} }
    move.state = 'done'; move.finished = new Date().toISOString(); save(); notify('storage');
    console.log('[storage] move done: ' + move.copied + ' copied, ' + move.skipped + ' already there, ' + move.deleted + ' old copies removed' + (move.same ? ', ' + move.same + ' already there as the same file (left in place)' : '') + (move.kept ? ', ' + move.kept + ' old copies kept (new copy missing/different)' : ''));
  }
}
export function clearMove() { if (move && (move.state === 'copying' || move.state === 'deleting')) throw new Error('A move is running.'); move = null; setSetting('photos_move', null); notify('storage'); }

export function startStorage(broadcast) {
  notify = broadcast;
  try { move = JSON.parse(getSetting('photos_move') || 'null'); } catch { move = null; }
  check();
  if (move && (move.state === 'copying' || move.state === 'deleting')) {
    console.log('[storage] resuming interrupted move (' + move.state + ') ' + move.from + ' → ' + move.to);
    runMove().catch((e) => { move.state = 'error'; move.error = String(e.message || e); save(); notify('storage'); });
  }
  setInterval(check, 30e3);
}

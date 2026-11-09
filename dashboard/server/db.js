// SQLite storage. Uses Node's built-in node:sqlite when available (Node >= 22.5),
// otherwise the better-sqlite3 package. Both expose the same prepare/run/get/all API.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const FILE = process.env.DB_FILE || fileURLToPath(new URL('./data.db', import.meta.url));

function open() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(FILE);
  } catch {
    const Database = require('better-sqlite3');
    return new Database(FILE);
  }
}

export const db = open();
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'kid',   -- kid | parent
  color TEXT NOT NULL DEFAULT '#2D5BFF', birthday TEXT, ha_entity TEXT, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS calendars (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,  -- NULL = whole family
  url TEXT NOT NULL, last_ok TEXT, last_error TEXT);
CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, name TEXT NOT NULL, from_h INTEGER, to_h INTEGER, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS chores (
  id INTEGER PRIMARY KEY, person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,  -- NULL = anyone
  routine_id TEXT NOT NULL DEFAULT 'morning', title TEXT NOT NULL, emoji TEXT DEFAULT '⭐',
  stars INTEGER NOT NULL DEFAULT 1, days TEXT NOT NULL DEFAULT '0123456',  -- weekdays, 0 = Sunday
  active INTEGER NOT NULL DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS completions (
  id INTEGER PRIMARY KEY, chore_id INTEGER NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  day TEXT NOT NULL, by_person INTEGER REFERENCES people(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, UNIQUE (chore_id, day));
CREATE TABLE IF NOT EXISTS stars (
  id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL, reason TEXT, completion_id INTEGER, redemption_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS rewards (id INTEGER PRIMARY KEY, title TEXT NOT NULL, emoji TEXT DEFAULT '🎁', cost INTEGER NOT NULL DEFAULT 10, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS redemptions (
  id INTEGER PRIMARY KEY, reward_id INTEGER REFERENCES rewards(id) ON DELETE SET NULL,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE, title TEXT, cost INTEGER NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS stores (id INTEGER PRIMARY KEY, name TEXT NOT NULL, cat_order TEXT, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS shopping (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, cat TEXT DEFAULT 'Other', qty INTEGER DEFAULT 1,
  store_id INTEGER REFERENCES stores(id) ON DELETE SET NULL, done INTEGER DEFAULT 0, note TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS usuals (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS countdowns (id INTEGER PRIMARY KEY, title TEXT NOT NULL, emoji TEXT DEFAULT '🎉', date TEXT NOT NULL,
  person_id INTEGER REFERENCES people(id) ON DELETE SET NULL);
CREATE TABLE IF NOT EXISTS events (  -- events added on the dashboard itself (Google calendars are read-only)
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, all_day INTEGER DEFAULT 0,
  people TEXT DEFAULT '[]', loc TEXT, notes TEXT);
`);

// SQLite wants null rather than undefined, and 1/0 rather than true/false.
const norm = (a) => a.map((v) => (v === undefined ? null : v === true ? 1 : v === false ? 0 : v));
// Columns added after the first version; added in place so existing data.db files keep working.
function addColumn(table, col, def) {
  if (!db.prepare('PRAGMA table_info(' + table + ')').all().some((c) => c.name === col)) db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + def);
}
addColumn('people', 'show_tab', 'INTEGER NOT NULL DEFAULT 0');
addColumn('people', 'widgets', `TEXT NOT NULL DEFAULT '["chores","stars","rewards","countdowns","today","weather","sleep"]'`);
addColumn('people', 'approval', 'TEXT');        // NULL = use the global setting, 'on' / 'off' = override
addColumn('people', 'bedtime', 'TEXT');          // 'HH:MM'
addColumn('people', 'wake', 'TEXT');
addColumn('redemptions', 'status', "TEXT NOT NULL DEFAULT 'approved'"); // requested | approved | denied
addColumn('people', 'wake_light', 'TEXT');   // optional HA light for ok-to-wake
addColumn('people', 'wake_color', 'TEXT');   // '#RRGGBB' at wake time
addColumn('people', 'bed_color', 'TEXT');    // '#RRGGBB' at bedtime
db.exec(`CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY, file TEXT NOT NULL, date TEXT NOT NULL, person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
  artwork INTEGER DEFAULT 0, caption TEXT, place TEXT, orient TEXT DEFAULT 'l', fav INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
// Screens (each frame/tablet/browser) and reusable profiles. tabs = JSON list in display order.
db.exec(`CREATE TABLE IF NOT EXISTS profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL, tabs TEXT, default_tab TEXT DEFAULT 'home',
  kid_lock INTEGER DEFAULT 0, quiet_start TEXT, quiet_end TEXT, dim INTEGER DEFAULT 40);
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT, ua TEXT, ip TEXT, last_seen TEXT, profile_id INTEGER,
  tabs TEXT, default_tab TEXT DEFAULT 'home', kid_lock INTEGER DEFAULT 0, quiet_start TEXT, quiet_end TEXT, dim INTEGER DEFAULT 40,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
addColumn('people', 'goal_reward_id', 'INTEGER');  // the reward the kid is saving for (star jar)
db.exec(`CREATE TABLE IF NOT EXISTS feelings (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  feeling TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  text TEXT, emoji TEXT, photo TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, hearted_at TEXT);
CREATE TABLE IF NOT EXISTS icons (id INTEGER PRIMARY KEY, keyword TEXT NOT NULL, emoji TEXT NOT NULL);  -- "Today in pictures"`);
db.exec(`CREATE TABLE IF NOT EXISTS ha_entities (  -- Home Assistant entities shown on the dashboard
  entity_id TEXT PRIMARY KEY, mode TEXT NOT NULL DEFAULT 'control',  -- control | sensor
  label TEXT, sort INTEGER DEFAULT 0);`);
db.exec(`CREATE TABLE IF NOT EXISTS ha_groups (  -- Home area/group overrides (rename + reorder)
  id TEXT PRIMARY KEY, name TEXT, sort INTEGER DEFAULT 0);`);
addColumn('ha_entities', 'group_id', 'TEXT');          // NULL = use HA area; '_other' / custom id = override
addColumn('ha_entities', 'card_id', 'TEXT');           // shared id → multi-sensor card
addColumn('ha_entities', 'card_primary', 'INTEGER NOT NULL DEFAULT 0');

export const all = (sql, ...a) => db.prepare(sql).all(...norm(a));
export const get = (sql, ...a) => db.prepare(sql).get(...norm(a));
export const run = (sql, ...a) => db.prepare(sql).run(...norm(a));

export function getSetting(key, def = null) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : def;
}
export function setSetting(key, value) {
  if (value == null) run('DELETE FROM settings WHERE key = ?', key);
  else run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

// First-run defaults (no fake people).
if (!get('SELECT 1 FROM routines LIMIT 1')) {
  run("INSERT INTO routines VALUES ('morning', 'Morning', 0, 11, 0)");
  run("INSERT INTO routines VALUES ('after', 'Afternoon', 11, 17, 1)");
  run("INSERT INTO routines VALUES ('evening', 'Evening', 17, 24, 2)");
}
if (!get('SELECT 1 FROM stores LIMIT 1')) run("INSERT INTO stores (name) VALUES ('Grocery')");
if (getSetting('location') == null) {
  setSetting('location', 'Frisco, TX');
  setSetting('lat', '33.1507'); setSetting('lon', '-96.8236');
  setSetting('units', 'fahrenheit');
}
if (!get('SELECT 1 FROM icons LIMIT 1')) {
  const seed = [['school', '🏫'], ['soccer', '⚽'], ['swim', '🏊'], ['dance', '💃'], ['ballet', '🩰'], ['piano', '🎹'], ['music', '🎵'], ['doctor', '🩺'],
    ['dentist', '🦷'], ['birthday', '🎂'], ['party', '🎉'], ['park', '🛝'], ['library', '📚'], ['read', '📖'], ['book', '📖'], ['bath', '🛁'],
    ['teeth', '🪥'], ['brush', '🪥'], ['bed', '🛏️'], ['dress', '👕'], ['clothes', '👕'], ['breakfast', '🥣'], ['lunch', '🥪'], ['dinner', '🍝'],
    ['grandma', '👵'], ['grandpa', '👴'], ['playdate', '🧸'], ['play', '🧸'], ['zoo', '🦁'], ['movie', '🎬'], ['church', '⛪'], ['trip', '🚗'],
    ['flight', '✈️'], ['shopping', '🛒'], ['toys', '🧸'], ['tidy', '🧹'], ['clean', '🧹'], ['pet', '🐶'], ['dog', '🐶'], ['cat', '🐱'], ['art', '🎨']];
  for (const [k, e] of seed) run('INSERT INTO icons (keyword, emoji) VALUES (?, ?)', k, e);
}
if (getSetting('learning_items') == null) {
  setSetting('learning_items', ['A 🍎 Apple', 'B 🐻 Bear', 'C 🐱 Cat', 'D 🐶 Dog', '1 ☝️ One', '2 ✌️ Two', '3 🐻🐻🐻 Three', '● Circle', '■ Square', '▲ Triangle',
    'E 🐘 Elephant', 'F 🐟 Fish', 'G 🍇 Grapes', '4 🍀 Four', '5 🖐️ Five', '★ Star', '♥ Heart', 'H 🏠 House', 'I 🍦 Ice cream', '6 🎲 Six'].join('\n'));
}
if (!get('SELECT 1 FROM profiles LIMIT 1')) {
  // tabs: null = everything (including new people's tabs); "kids" = every kid with a tab
  run("INSERT INTO profiles (name, tabs, default_tab, kid_lock, dim) VALUES ('Family', NULL, 'home', 0, 40)");
  run(`INSERT INTO profiles (name, tabs, default_tab, kid_lock, quiet_start, quiet_end, dim) VALUES ('Kid', '["kids"]', 'kids', 1, '19:30', '07:00', 15)`);
}
if (getSetting('approval_required') == null) setSetting('approval_required', '0');

// Per-screen photo sources: a row = this screen does NOT show that source (no rows = show everything,
// so new albums appear everywhere). source_key: 'upload' | 'picker' | 'demo' | 'kept' | 'album:<google_albums.id>'.
// Screens with any row have a custom selection, so albums added later start off there (see album add).
db.exec(`CREATE TABLE IF NOT EXISTS screen_photo_off (screen_id TEXT NOT NULL, source_key TEXT NOT NULL, PRIMARY KEY (screen_id, source_key));`);

// Google Photos sources. photos.source: NULL = uploaded in admin, 'google-picker' or 'google-album'.
addColumn('photos', 'source', 'TEXT');
addColumn('photos', 'ext_id', 'TEXT');        // Google media id (picker) or album photo id
addColumn('photos', 'source_id', 'INTEGER');  // google_albums.id for album photos
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS photos_ext ON photos (source, ext_id);
CREATE TABLE IF NOT EXISTS google_albums (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT,
  last_checked TEXT, last_ok TEXT, last_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
// Google photos deleted one by one in admin, so picks / album checks don't download them again.
db.exec(`CREATE TABLE IF NOT EXISTS photo_tombstones (source TEXT NOT NULL, ext_id TEXT NOT NULL, source_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (source, ext_id));`);
// Album row ids get reused after remove/re-add, so tombstones are tied to the album's share URL.
addColumn('photo_tombstones', 'source_key', 'TEXT');
db.exec(`UPDATE photo_tombstones SET source_key = (SELECT url FROM google_albums WHERE google_albums.id = photo_tombstones.source_id)
  WHERE source = 'google-album' AND source_key IS NULL AND source_id IS NOT NULL;`);
// Album ids must never be reused (a reused id used to adopt, and later delete, photos kept from a removed album):
// rebuild google_albums once with AUTOINCREMENT, keeping every row and id.
if (!/AUTOINCREMENT/i.test((get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'google_albums'") || {}).sql || '')) {
  db.exec(`BEGIN;
CREATE TABLE google_albums_new (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL, title TEXT,
  last_checked TEXT, last_ok TEXT, last_error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
INSERT INTO google_albums_new (id, url, title, last_checked, last_ok, last_error, created_at)
  SELECT id, url, title, last_checked, last_ok, last_error, created_at FROM google_albums;
DROP TABLE google_albums;
ALTER TABLE google_albums_new RENAME TO google_albums;
COMMIT;`);
}
// Photos kept from a removed album have no album link (source_id NULL = the 'kept' bucket).
db.exec(`UPDATE photos SET source_id = NULL WHERE source = 'google-album' AND source_id IS NOT NULL
  AND source_id NOT IN (SELECT id FROM google_albums);
DELETE FROM screen_photo_off WHERE source_key LIKE 'album:%' AND CAST(substr(source_key, 7) AS INTEGER) NOT IN (SELECT id FROM google_albums);`);

// Cross-source dedup: photos.sha256 = hash of the stored file's bytes. Every source a picture belongs to is a
// photo_links row (source 'upload' | 'google-picker' | 'google-album', source_id = album id or NULL = kept, ext_id);
// the same picture from two albums / an album + an upload is one file + one photos row with two links.
// A photo with no links left is deleted (see google-photos.js). photos.source/source_id/ext_id stay as the first source.
addColumn('photos', 'sha256', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS photo_links (id INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE, source TEXT NOT NULL, source_id INTEGER, ext_id TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS photo_links_photo ON photo_links (photo_id);
CREATE INDEX IF NOT EXISTS photo_links_ext ON photo_links (source, ext_id);
CREATE INDEX IF NOT EXISTS photos_sha ON photos (sha256);
INSERT INTO photo_links (photo_id, source, source_id, ext_id)
  SELECT id, COALESCE(source, 'upload'), source_id, ext_id FROM photos WHERE id NOT IN (SELECT photo_id FROM photo_links);
UPDATE photo_links SET source_id = NULL WHERE source = 'google-album' AND source_id IS NOT NULL
  AND source_id NOT IN (SELECT id FROM google_albums);`);
// Album sync bookkeeping: photos seen last time (guards pruning), memberships removed, duplicates skipped, prune warning.
addColumn('google_albums', 'last_count', 'INTEGER');
addColumn('google_albums', 'last_removed', 'INTEGER');
addColumn('google_albums', 'last_dups', 'INTEGER');
addColumn('google_albums', 'last_warning', 'TEXT');
// Removal sync: an album membership is pruned only after it's missing from 2 consecutive successful checks.
addColumn('photo_links', 'miss_count', 'INTEGER NOT NULL DEFAULT 0');
addColumn('google_albums', 'last_seen_count', 'INTEGER'); // raw count of the last successful check (a repeated big drop = real)

// Kiosk exit PIN override per screen (salt:sha256); NULL = use the global kiosk PIN setting.
addColumn('devices', 'kiosk_pin_hash', 'TEXT');
addColumn('devices', 'kiosk_lockout_reset_at', 'INTEGER'); // admin 'Clear lockout': kiosk ends its cooldown when this changes

// Look: per-screen / per-profile theme ('default' | 'paper') and a per-photo-source frame style
// (source_key as in screen_photo_off; style 'plain' | 'polaroid' | 'torn'; no row = 'auto' = follow the screen's theme).
addColumn('devices', 'theme', "TEXT NOT NULL DEFAULT 'default'");
addColumn('profiles', 'theme', "TEXT NOT NULL DEFAULT 'default'");
// Night style for the dashboard during quiet hours ('dim' = muted natural colours | 'red' = amber/red, for bedrooms)
addColumn('devices', 'night_style', "TEXT NOT NULL DEFAULT 'dim'");
addColumn('profiles', 'night_style', "TEXT NOT NULL DEFAULT 'dim'");
db.exec(`CREATE TABLE IF NOT EXISTS photo_source_style (source_key TEXT PRIMARY KEY, style TEXT NOT NULL);`);
// Shared-album paging: Google's item count, items read last check, pages read, 1 = the whole album was read (prune allowed).
addColumn('google_albums', 'last_total', 'INTEGER');
addColumn('google_albums', 'last_read', 'INTEGER');
addColumn('google_albums', 'last_pages', 'INTEGER');
addColumn('google_albums', 'last_complete', 'INTEGER');
// photos.file is a bare file name inside the photo folder (so moving the folder only changes the setting).
db.exec("UPDATE photos SET file = replace(file, rtrim(file, replace(file, '/', '')), '') WHERE file LIKE '%/%'");

// Builds the one JSON document the dashboard loads (GET /api/state).
// The shapes match what js/views/* expect (see js/data.js).
import { all, get, getSetting } from './db.js';
import { cache } from './fetchers.js';

export const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

function rgbOf(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function personStyle(color) {
  const [r, g, b] = rgbOf(color);
  const light = 0.299 * r + 0.587 * g + 0.114 * b > 165;
  return { color, rgb: r + ' ' + g + ' ' + b, ink: light ? '#111111' : '#FFFFFF' };
}
function ageOf(bday) {
  if (!bday) return undefined;
  const b = new Date(bday + 'T00:00'), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}

const DEFAULT_CATS = ['Produce', 'Bakery', 'Meat & Fish', 'Dairy & Eggs', 'Pantry', 'Frozen', 'Snacks', 'Household'];
const EMPTY_WEATHER = { unit: 'F', hi: '–', lo: '–', feels: '–', humidity: '–', wind: '–', t: Array(24).fill('–'), c: Array(24).fill('cloud'), p: Array(24).fill(0), missing: true };

function haState(id) { return cache.ha && id ? cache.ha.states[id] : null; }

// Locks, garage doors and alarms need the parent PIN even from the frame.
export function isSecure(id, attrs) {
  const d = id.split('.')[0];
  return d === 'lock' || d === 'alarm_control_panel' || (d === 'cover' && (attrs || {}).device_class === 'garage');
}

const OTHER = '_other';

function titleCaseId(id) {
  return String(id || '').replace(/^_/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Other';
}

// Resolve which group an entity belongs to (override → HA area → Other).
export function haGroupIdFor(entityId, groupOverride) {
  if (groupOverride) return groupOverride;
  const aid = cache.ha && cache.ha.entityArea && cache.ha.entityArea[entityId];
  return aid || OTHER;
}

export function haGroupMeta() {
  const overrides = Object.fromEntries(all('SELECT * FROM ha_groups').map((g) => [g.id, g]));
  const areas = (cache.ha && cache.ha.areas) || {};
  const names = { ...areas };
  for (const [id, g] of Object.entries(overrides)) {
    if (g.name) names[id] = g.name;
  }
  names[OTHER] = (overrides[OTHER] && overrides[OTHER].name) || 'Other';
  return { overrides, names };
}

// Home Assistant entities the parents picked in /admin, with their live state + area/card overrides.
export function haItems() {
  const { overrides, names } = haGroupMeta();
  return all('SELECT * FROM ha_entities ORDER BY sort, entity_id').map((r) => {
    const s = cache.ha && cache.ha.states[r.entity_id], a = (s && s.attributes) || {};
    const haArea = (cache.ha && cache.ha.entityArea && cache.ha.entityArea[r.entity_id]) || null;
    const groupId = haGroupIdFor(r.entity_id, r.group_id || null);
    return {
      id: r.entity_id, domain: r.entity_id.split('.')[0], mode: r.mode,
      name: r.label || a.friendly_name || r.entity_id, state: s ? s.state : 'unavailable',
      unit: a.unit_of_measurement || '', deviceClass: a.device_class || '', secure: isSecure(r.entity_id, a),
      level: a.brightness != null ? Math.round(a.brightness / 2.55) : undefined,
      pos: a.current_position, current: a.current_temperature, target: a.temperature,
      title: a.media_title, artist: a.media_artist,
      sort: r.sort == null ? 0 : r.sort,
      groupId, groupName: names[groupId] || titleCaseId(groupId),
      haArea, cardId: r.card_id || null, cardPrimary: !!r.card_primary
    };
  });
}

// Ordered groups that currently have at least one enabled entity.
export function haGroupsFor(items) {
  const { overrides, names } = haGroupMeta();
  const seen = {};
  for (const x of items) seen[x.groupId] = true;
  const ids = Object.keys(seen);
  ids.sort((a, b) => {
    const sa = overrides[a] && overrides[a].sort != null ? +overrides[a].sort : (a === OTHER ? 9000 : 1000);
    const sb = overrides[b] && overrides[b].sort != null ? +overrides[b].sort : (b === OTHER ? 9000 : 1000);
    if (sa !== sb) return sa - sb;
    return (names[a] || a).localeCompare(names[b] || b);
  });
  return ids.map((id, i) => ({
    id, name: names[id] || titleCaseId(id),
    sort: overrides[id] && overrides[id].sort != null ? +overrides[id].sort : i,
    renamed: !!(overrides[id] && overrides[id].name),
    fromHa: id !== OTHER && !String(id).startsWith('c_')
  }));
}

function homeControl() {
  const ha = haItems();
  const ctl = ha.filter((x) => x.mode === 'control');
  const out = {
    ha, haGroups: haGroupsFor(ha), homeEnabled: ha.length > 0, connected: !!cache.ha,
    rooms: [], cameras: [], scenes: [],
    // simple summaries the Today screen uses
    devices: ctl.map((x) => {
      if (x.domain === 'light') return { id: x.id, type: 'light', name: x.name, on: x.state === 'on', level: x.level || 100 };
      if (x.domain === 'lock') return { id: x.id, type: 'lock', name: x.name, locked: x.state === 'locked' };
      if (x.domain === 'cover' && x.deviceClass === 'garage') return { id: x.id, type: 'garage', name: x.name, state: x.state };
      return null;
    }).filter(Boolean),
    climate: { current: '–', set: '–', mode: 'off', humidity: '–', outside: cache.weather ? cache.weather.now : '–' },
    media: { room: 'No', title: 'Nothing playing', artist: '', playing: false, volume: 0, seed: 'speaker' }
  };
  const clim = ha.find((x) => x.domain === 'climate');
  if (clim) Object.assign(out.climate, { current: clim.current != null ? clim.current : '–', set: clim.target != null ? clim.target : '–', mode: clim.state });
  return out;
}

function approvalFor(p) {
  if (p && p.approval === 'on') return true;
  if (p && p.approval === 'off') return false;
  return getSetting('approval_required', '0') === '1';
}
export function needsApproval(personId) {
  return approvalFor(personId != null ? get('SELECT approval FROM people WHERE id = ?', personId) : null);
}

// Which per-screen photo source a photos row belongs to (see screen_photo_off in db.js)
export function photoKey(p) { return p.source === 'google-picker' ? 'picker' : p.source === 'google-album' ? (p.source_id == null ? 'kept' : 'album:' + p.source_id) : 'upload'; }

// Every per-screen source key of each photo (a deduped photo can be in several albums / picker / uploads).
export const linkKey = (l) => photoKey({ source: l.source === 'upload' ? null : l.source, source_id: l.source_id });
export function photoKeys() {
  const m = new Map();
  for (const l of all('SELECT photo_id, source, source_id FROM photo_links ORDER BY id')) {
    const k = linkKey(l), a = m.get(l.photo_id) || [];
    if (a.indexOf(k) < 0) a.push(k);
    m.set(l.photo_id, a);
  }
  return m;
}

export function buildState() {
  const now = new Date(), today = ymd(now), dow = now.getDay();
  const peopleRows = all('SELECT * FROM people ORDER BY sort, id');
  const people = peopleRows.map((p) => {
    const ha = haState(p.ha_entity);
    const home = ha ? ha.state === 'home' : true;
    return {
      id: String(p.id), name: p.name, role: p.role, age: ageOf(p.birthday), ...personStyle(p.color),
      home, status: ha ? (home ? 'Home' : ha.state === 'not_home' ? 'Away' : ha.state) : '',
      showTab: !!p.show_tab, widgets: safeJson(p.widgets, []), bedtime: p.bedtime || '', wake: p.wake || '',
      approval: approvalFor(p),
      wakeLight: !!p.wake_light,
      goalRewardId: p.goal_reward_id != null ? String(p.goal_reward_id) : '',
      feeling: (get("SELECT feeling FROM feelings WHERE person_id = ? AND created_at >= datetime('now', '-12 hours') ORDER BY id DESC LIMIT 1", p.id) || {}).feeling || ''
    };
  });
  const ALL = people.map((p) => p.id);
  const kids = peopleRows.filter((p) => p.role === 'kid');

  // chores scheduled today + today's completion
  const routines = all('SELECT * FROM routines ORDER BY sort').map((r) => ({
    id: r.id, name: r.name, from: r.from_h, to: r.to_h, range: fmtRange(r.from_h, r.to_h)
  }));
  const choreRows = all(`SELECT c.*, k.id AS comp_id, k.status, k.by_person FROM chores c
    LEFT JOIN completions k ON k.chore_id = c.id AND k.day = ? AND k.status != 'rejected'
    WHERE c.active = 1 ORDER BY c.sort, c.id`, today);
  const chores = choreRows.filter((c) => c.days.includes(String(dow))).map((c) => ({
    id: String(c.id), r: c.routine_id, who: c.person_id == null ? 'any' : String(c.person_id), title: c.title, emoji: c.emoji, stars: c.stars,
    done: !!c.comp_id, pending: c.status === 'pending', doneBy: c.by_person != null ? String(c.by_person) : undefined
  }));

  const stars = {}, pendingStars = {}, week = {};
  const monday = new Date(now); monday.setHours(0, 0, 0, 0); monday.setDate(monday.getDate() - ((dow + 6) % 7));
  for (const k of kids) {
    stars[k.id] = get('SELECT COALESCE(SUM(delta), 0) AS s FROM stars WHERE person_id = ?', k.id).s;
    pendingStars[k.id] = get(`SELECT COALESCE(SUM(c.stars), 0) AS s FROM completions k JOIN chores c ON c.id = k.chore_id
      WHERE k.status = 'pending' AND COALESCE(k.by_person, c.person_id) = ?`, k.id).s;
    const mine = choreRows.filter((c) => c.person_id === k.id);
    week[k.id] = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      const d = new Date(monday); d.setDate(d.getDate() + i);
      if (d > now) return null;
      const list = mine.filter((c) => c.days.includes(String(d.getDay())));
      if (!list.length) return null;
      const n = get(`SELECT COUNT(*) AS n FROM completions WHERE day = ? AND status != 'rejected' AND chore_id IN (${list.map(() => '?').join(',')})`, ymd(d), ...list.map((c) => c.id)).n;
      return n >= list.length ? 1 : 0;
    });
  }

  // calendar: Google feeds + events added on the dashboard
  const events = cache.calendar.map((e) => ({
    id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay || undefined, loc: e.loc, notes: e.notes,
    people: e.personId != null && ALL.includes(String(e.personId)) ? [String(e.personId)] : ALL.slice(), source: 'google'
  })).concat(all('SELECT * FROM events').map((e) => ({
    id: 'l' + e.id, title: e.title, start: e.start, end: e.end, allDay: !!e.all_day || undefined, loc: e.loc || undefined, notes: e.notes || undefined,
    people: JSON.parse(e.people || '[]').filter((id) => ALL.includes(id)), source: 'local'
  })));
  events.forEach((e) => { if (!e.people.length) e.people = ALL.slice(); });

  const storeRows = all('SELECT * FROM stores ORDER BY sort, id');
  const catOrder = { all: DEFAULT_CATS };
  storeRows.forEach((s) => { catOrder[String(s.id)] = s.cat_order ? JSON.parse(s.cat_order) : DEFAULT_CATS; });

  return {
    people, ALL, routines, chores, stars, pendingStars, week,
    events,
    stores: storeRows.map((s) => ({ id: String(s.id), name: s.name })),
    catOrder,
    groceries: all('SELECT * FROM shopping ORDER BY id').map((g) => ({ id: String(g.id), name: g.name, cat: g.cat || 'Other', qty: g.qty, store: g.store_id != null ? String(g.store_id) : String(storeRows[0] ? storeRows[0].id : ''), done: !!g.done, note: g.note || '' })),
    usuals: all('SELECT name FROM usuals ORDER BY id').map((u) => u.name),
    rewards: all('SELECT id, title, emoji, cost FROM rewards WHERE active = 1 ORDER BY cost').map((r) => ({ ...r, id: String(r.id) })),
    countdowns: all("SELECT * FROM countdowns WHERE date >= ? ORDER BY date", today).map((c) => ({
      id: String(c.id), title: c.title, emoji: c.emoji, date: c.date, who: c.person_id != null ? String(c.person_id) : 'family',
      days: Math.round((new Date(c.date + 'T00:00') - new Date(today + 'T00:00')) / 864e5)
    })),
    rewardRequests: all("SELECT id, reward_id, person_id, title, cost FROM redemptions WHERE status = 'requested'").map((r) => ({ ...r, id: String(r.id), reward_id: String(r.reward_id), person_id: String(r.person_id) })),
    notes: all('SELECT * FROM notes ORDER BY id DESC LIMIT 30').map((n) => ({ id: String(n.id), person_id: String(n.person_id), text: n.text || '', emoji: n.emoji || '', photo: n.photo || '', created_at: n.created_at, hearted: !!n.hearted_at })),
    icons: all('SELECT keyword, emoji FROM icons ORDER BY length(keyword) DESC').map((r) => [r.keyword.toLowerCase(), r.emoji]),
    learning: learningToday(now),
    family: familyGoal(monday),
    photos: ((keys) => all('SELECT * FROM photos ORDER BY date DESC').map((p) => ({ srcs: keys.get(p.id) || [photoKey(p)],
      id: String(p.id), seed: '/photos/' + p.file, o: p.orient || 'l', date: p.date, place: p.caption || p.place || (p.artwork ? 'Artwork' : ''),
      from: p.person_id != null ? String(p.person_id) : 'family', tag: 'p' + p.id, fav: !!p.fav, artwork: !!p.artwork, src: (keys.get(p.id) || [photoKey(p)])[0]
    })))(photoKeys()),
    quiet: { start: getSetting('quiet_start') || '', end: getSetting('quiet_end') || '' },
    soundsOn: getSetting('sounds_muted') !== '1',
    approvalRequired: getSetting('approval_required', '0') === '1',
    pendingApprovals: get("SELECT COUNT(*) AS n FROM completions WHERE status = 'pending'").n,
    weather: cache.weather || { ...EMPTY_WEATHER, unit: getSetting('units', 'fahrenheit') === 'fahrenheit' ? 'F' : 'C' },
    location: getSetting('location'),
    ...homeControl(),
    serverTime: now.toISOString()
  };
}

function learningToday(now) {
  const items = (getSetting('learning_items') || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return null;
  const day = Math.floor((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(2020, 0, 1)) / 864e5);
  return items[day % items.length];
}
function familyGoal(monday) {
  const stars = get('SELECT COALESCE(SUM(delta), 0) AS s FROM stars WHERE delta > 0 AND completion_id IS NOT NULL AND created_at >= ?',
    monday.toISOString().slice(0, 19).replace('T', ' ')).s;
  return { stars, goal: +(getSetting('family_goal_stars') || 0), title: getSetting('family_goal_title') || '', emoji: getSetting('family_goal_emoji') || '🏆' };
}

function safeJson(s, d) { try { return JSON.parse(s); } catch { return d; } }

function fmtRange(a, b) {
  const f = (h) => (h % 12 || 12) + (h % 24 >= 12 ? ' PM' : ' AM');
  return f(a) + ' – ' + f(b);
}

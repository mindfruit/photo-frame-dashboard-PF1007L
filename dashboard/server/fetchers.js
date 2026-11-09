// Background fetchers: weather (Open-Meteo), Google calendars (secret iCal links), Home Assistant.
// Results live in memory in `cache`; onChange(topic) is called when something actually changed.
import ical from 'node-ical';
import { all, run, getSetting, setSetting } from './db.js';

export const cache = { weather: null, calendar: [], ha: null, errors: {} };
let onChange = () => {};
const last = {};
function changed(topic, value) {
  const s = JSON.stringify(value);
  if (last[topic] === s) return;
  last[topic] = s;
  onChange(topic);
}

// ------------------------------------------------------------------ weather
const WMO = (code, day) => {
  if (code <= 1) return day ? 'sun' : 'moon';
  if (code === 2) return day ? 'partly' : 'moon';
  if (code === 3 || code === 45 || code === 48) return 'cloud';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
  return 'cloud'; // snow etc. — no icon for it yet
};

// "Frisco, TX" or "33.15,-96.82" -> lat/lon (saved in settings)
export async function geocode(location) {
  const m = String(location).match(/^\s*(-?\d+(\.\d+)?)\s*,\s*(-?\d+(\.\d+)?)\s*$/);
  if (m) return { lat: +m[1], lon: +m[3] };
  const [name, hint = ''] = location.split(',').map((s) => s.trim());
  const r = await fetch('https://geocoding-api.open-meteo.com/v1/search?count=10&name=' + encodeURIComponent(name)).then((x) => x.json());
  const list = r.results || [];
  const h = hint.toLowerCase();
  const pick = list.find((x) => h && [x.admin1, x.country, x.country_code].some((v) => v && v.toLowerCase().startsWith(h))) || list[0];
  if (!pick) throw new Error('Location not found: ' + location);
  return { lat: pick.latitude, lon: pick.longitude };
}

export async function fetchWeather() {
  try {
    const lat = getSetting('lat'), lon = getSetting('lon');
    const F = getSetting('units', 'fahrenheit') === 'fahrenheit';
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
      '&hourly=temperature_2m,precipitation_probability,weather_code,is_day' +
      '&daily=temperature_2m_max,temperature_2m_min' +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m' +
      '&timezone=auto&forecast_days=1' + (F ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : '');
    const r = await fetch(url).then((x) => { if (!x.ok) throw new Error('Open-Meteo HTTP ' + x.status); return x.json(); });
    const H = r.hourly;
    cache.weather = {
      unit: F ? 'F' : 'C',
      hi: Math.round(r.daily.temperature_2m_max[0]), lo: Math.round(r.daily.temperature_2m_min[0]),
      now: Math.round(r.current.temperature_2m), feels: Math.round(r.current.apparent_temperature),
      humidity: r.current.relative_humidity_2m, wind: Math.round(r.current.wind_speed_10m),
      t: H.temperature_2m.slice(0, 24).map(Math.round),
      c: H.weather_code.slice(0, 24).map((c, i) => WMO(c, H.is_day[i])),
      p: H.precipitation_probability.slice(0, 24).map((x) => x || 0),
      updated: new Date().toISOString()
    };
    delete cache.errors.weather;
    changed('weather', cache.weather);
  } catch (e) { cache.errors.weather = e.message; }
}

// ------------------------------------------------------------------ calendars
const DAY = 864e5;
function localDay(d, utc) { // all-day dates -> local midnight
  return utc ? new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function expandIcs(text, from, to) {
  const out = [];
  const data = ical.sync.parseICS(text);
  for (const ev of Object.values(data)) {
    if (ev.type !== 'VEVENT' || !ev.start) continue;
    if (ev.status === 'CANCELLED') continue;
    const allDay = ev.datetype === 'date' || ev.start.dateOnly;
    const dur = ev.end ? ev.end - ev.start : (allDay ? DAY : 0);
    const push = (src, start, end) => {
      if (end <= from || start >= to) return;
      out.push({
        uid: ev.uid, title: String(src.summary && src.summary.val != null ? src.summary.val : src.summary || '(busy)'),
        start, end, allDay: !!allDay,
        loc: src.location ? String(src.location.val || src.location) : undefined,
        notes: src.description ? String(src.description.val || src.description).slice(0, 400) : undefined
      });
    };
    if (ev.rrule) {
      const ex = ev.exdate || {};
      const dates = ev.rrule.between(new Date(from - dur), to, true);
      for (const d of dates) {
        const key = d.toISOString().slice(0, 10);
        if (ex[key]) continue;
        const o = ev.recurrences && ev.recurrences[key];
        if (o) { if (o.status !== 'CANCELLED') push(o, o.start, o.end || new Date(+o.start + dur)); continue; }
        const s = allDay ? localDay(d, true) : d;
        push(ev, s, new Date(+s + dur));
      }
    } else {
      const s = allDay ? localDay(ev.start) : ev.start;
      push(ev, s, allDay ? localDay(new Date(+s + dur + 3600e3)) : new Date(+s + dur));
    }
  }
  return out;
}

export async function fetchCalendars() {
  const now = Date.now(), from = new Date(now - 45 * DAY), to = new Date(now + 90 * DAY);
  const events = [];
  for (const cal of all('SELECT * FROM calendars')) {
    try {
      const res = await fetch(cal.url.replace(/^webcal:/, 'https:'));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      for (const e of expandIcs(await res.text(), from, to)) {
        events.push({ ...e, id: 'ics' + cal.id + '-' + e.uid + '-' + +e.start, personId: cal.person_id });
      }
      run('UPDATE calendars SET last_ok = ?, last_error = NULL WHERE id = ?', new Date().toISOString(), cal.id);
    } catch (e) {
      run('UPDATE calendars SET last_error = ? WHERE id = ?', e.message, cal.id);
    }
  }
  cache.calendar = events;
  changed('calendar', events);
}

// ------------------------------------------------------------------ Home Assistant
// Area registry via the template API (no websocket client needed).
async function fetchHAAreas(base, token) {
  const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const template = `{% for a in areas() %}{{ a }}|{{ area_name(a) }}
{% endfor %}---
{% for s in states %}{% set aid = area_id(s.entity_id) %}{% if aid %}{{ s.entity_id }}|{{ aid }}
{% endif %}{% endfor %}`;
  const res = await fetch(base + '/api/template', { method: 'POST', headers, body: JSON.stringify({ template }) });
  if (!res.ok) throw new Error('Home Assistant template HTTP ' + res.status);
  const text = await res.text();
  const areas = {}, entityArea = {};
  const [areaPart, entPart = ''] = text.split('\n---\n');
  for (const line of (areaPart || '').split('\n')) {
    const i = line.indexOf('|');
    if (i < 1) continue;
    const id = line.slice(0, i).trim(), name = line.slice(i + 1).trim();
    if (id) areas[id] = name || id;
  }
  for (const line of entPart.split('\n')) {
    const i = line.indexOf('|');
    if (i < 1) continue;
    const eid = line.slice(0, i).trim(), aid = line.slice(i + 1).trim();
    if (eid && aid) entityArea[eid] = aid;
  }
  return { areas, entityArea };
}

export async function fetchHA() {
  const base = (getSetting('ha_url') || '').replace(/\/+$/, ''), token = getSetting('ha_token');
  if (!base || !token) { if (cache.ha) { cache.ha = null; changed('home', null); } return; }
  try {
    const headers = { Authorization: 'Bearer ' + token };
    const res = await fetch(base + '/api/states', { headers });
    if (!res.ok) throw new Error('Home Assistant HTTP ' + res.status);
    const states = await res.json();
    let areas = {}, entityArea = {};
    try {
      const a = await fetchHAAreas(base, token);
      areas = a.areas; entityArea = a.entityArea;
    } catch (ae) {
      // areas are optional for live state; keep last known if any
      if (cache.ha) { areas = cache.ha.areas || {}; entityArea = cache.ha.entityArea || {}; }
    }
    cache.ha = {
      states: Object.fromEntries(states.map((s) => [s.entity_id, { state: s.state, attributes: s.attributes }])),
      areas, entityArea, updated: new Date().toISOString()
    };
    delete cache.errors.ha;
    // only wake the frames when an entity they show (or a person's home/away) changed
    const watched = all('SELECT entity_id FROM ha_entities').map((r) => r.entity_id)
      .concat(all('SELECT ha_entity FROM people WHERE ha_entity IS NOT NULL').map((r) => r.ha_entity));
    changed('home', watched.map((id) => [id, cache.ha.states[id] && cache.ha.states[id].state, cache.ha.states[id] && cache.ha.states[id].attributes]));
  } catch (e) { cache.errors.ha = e.message; }
}

export async function callHA(domain, service, data) {
  const base = (getSetting('ha_url') || '').replace(/\/+$/, ''), token = getSetting('ha_token');
  if (!base || !token) throw new Error('Home Assistant is not configured');
  const res = await fetch(base + '/api/services/' + domain + '/' + service, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(data || {})
  });
  if (!res.ok) throw new Error('Home Assistant HTTP ' + res.status);
  setTimeout(fetchHA, 500);
}

export function start(notify) {
  onChange = notify;
  const every = (fn, ms) => { fn(); setInterval(fn, ms); };
  every(fetchWeather, 15 * 60e3);
  every(fetchCalendars, 5 * 60e3);
  every(fetchHA, 30e3);
}
export { setSetting };

// Board sources. Each one: { kind, label, type, every (s), needsKey?, notes, fields, defaultOpts, fetch(ctx) -> cards[] }.
// fetch runs on the server only; ctx = { opts, cache, now, http, state, all, key }. A thrown error keeps the
// source's last cards (the board keeps showing them until they expire or go stale).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATA = (f) => JSON.parse(fs.readFileSync(fileURLToPath(new URL('./data/' + f, import.meta.url)), 'utf8'));
let VERSES = null, QUOTES = null;
const H = 3600e3, DAY = 864e5;
const hm = (d) => { const h = d.getHours(), m = d.getMinutes(); return (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (h >= 12 ? 'PM' : 'AM'); };
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const at = (base, hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); const d = new Date(base); d.setHours(h, m || 0, 0, 0); return +d; };
const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return +d; };
const clean = (s) => String(s == null ? '' : s).trim();

// "a | b | c" list fields: parse one line into an object / format it back (admin edits them as text)
const pipe = (line) => line.split('|').map((x) => x.trim());
export const LINE_FORMATS = {
  static: {
    hint: 'One message per line. Optional: | days=12345 (0 = Sunday) | 07:00-09:00 | from=2026-12-01 | to=2026-12-25',
    parse(line) {
      const [text, ...rest] = pipe(line), o = { text };
      for (const r of rest) {
        let m;
        if ((m = r.match(/^days=([0-6]{1,7})$/))) o.days = m[1];
        else if ((m = r.match(/^(\d{1,2}:\d\d)\s*-\s*(\d{1,2}:\d\d)$/))) { o.from = m[1].padStart(5, '0'); o.to = m[2].padStart(5, '0'); }
        else if ((m = r.match(/^from=(\d{4}-\d\d-\d\d)$/))) o.start = m[1];
        else if ((m = r.match(/^to=(\d{4}-\d\d-\d\d)$/))) o.end = m[1];
        else throw new Error('Didn’t understand “' + r + '” in: ' + line);
      }
      return o;
    },
    format: (o) => [o.text].concat(o.days ? ['days=' + o.days] : [], o.from ? [o.from + '-' + o.to] : [], o.start ? ['from=' + o.start] : [], o.end ? ['to=' + o.end] : []).join(' | ')
  },
  sensors: {
    hint: 'One per line: entity_id | LABEL, e.g. sensor.outdoor_temperature | OUTSIDE',
    parse(line) { const [entity, label] = pipe(line); if (!/^[a-z_]+\.[\w-]+$/.test(entity)) throw new Error('Not an entity id: ' + entity); return { entity, label: label || '' }; },
    format: (o) => o.entity + (o.label ? ' | ' + o.label : '')
  },
  rules: {
    hint: 'One per line: entity_id = on | MESSAGE | urgent (optional). Operators: = != > <. e.g. cover.garage_door = open | {red}GARAGE{/} IS OPEN',
    parse(line) {
      const [cond, message, flag] = pipe(line);
      const m = String(cond).match(/^([a-z_]+\.[\w-]+)\s*(!=|=|>|<)\s*(.+)$/);
      if (!m) throw new Error('Rule needs “entity = value”: ' + line);
      if (!message) throw new Error('Rule needs a message after |: ' + line);
      if (flag && flag !== 'urgent') throw new Error('Only “urgent” can follow the message: ' + line);
      return { entity: m[1], op: m[2], value: m[3].trim(), message, urgent: flag === 'urgent' };
    },
    format: (o) => o.entity + ' ' + o.op + ' ' + o.value + ' | ' + o.message + (o.urgent ? ' | urgent' : '')
  },
  countdowns: {
    hint: 'One per line: 2026-12-25 | CHRISTMAS',
    parse(line) { const [date, label] = pipe(line); if (!/^\d{4}-\d\d-\d\d$/.test(date) || !label) throw new Error('Countdown needs “YYYY-MM-DD | LABEL”: ' + line); return { date, label }; },
    format: (o) => o.date + ' | ' + o.label
  }
};

export const KINDS = {
  static: {
    label: 'Static messages', type: 'scheduled', every: 30, enabled: true,
    notes: 'Your own messages. Each one can be limited to weekdays, a time of day or a date range.',
    fields: [{ k: 'items', label: 'Messages', type: 'lines', fmt: 'static' }],
    defaultOpts: { items: [] },
    fetch({ opts, now }) {
      const out = [], today = new Date(now), ds = dayStart(now);
      (opts.items || []).forEach((it, i) => {
        if (!clean(it.text)) return;
        if (it.days && !it.days.includes(String(today.getDay()))) return;
        if (it.start && ds < +new Date(it.start + 'T00:00')) return;
        if (it.end && ds > +new Date(it.end + 'T00:00')) return;
        const c = { type: 'scheduled', key: 'static:' + i, lines: [it.text] };
        if (it.from && it.to) { c.starts_at = at(now, it.from); c.expires_at = at(now, it.to); if (c.expires_at <= c.starts_at) c.expires_at += DAY; }
        else c.expires_at = ds + DAY; // re-checked daily (weekday rules)
        out.push(c);
      });
      return out;
    }
  },
  weather: {
    label: 'Weather', type: 'live', every: 60, enabled: true,
    notes: 'From the dashboard’s own weather (Open-Meteo, already fetched by the server).',
    fields: [{ k: 'label', label: 'Title', type: 'text', ph: 'WEATHER' }],
    defaultOpts: { label: '' },
    fetch({ opts, cache, now }) {
      const w = cache.weather;
      if (!w) throw new Error('No weather yet');
      const h = new Date(now).getHours(), rain = (w.p || []).slice(h).findIndex((p) => p >= 50);
      const lines = [clean(opts.label) || 'WEATHER', 'NOW ' + w.now + '° FEELS ' + w.feels + '°', 'HI ' + w.hi + '° LO ' + w.lo + '°'];
      lines.push(rain < 0 ? 'DRY TODAY' : rain === 0 ? '{blue}RAIN NOW{/}' : '{blue}RAIN ~' + hm(new Date(dayStart(now) + (h + rain) * H)) + '{/}');
      return [{ type: 'live', key: 'weather', lines, stale_after: +new Date(w.updated) + 2 * H }];
    }
  },
  calendar: {
    label: 'Next events', type: 'scheduled', every: 60, enabled: true,
    notes: 'Upcoming events from the family calendars. Each shows from a few hours before it starts until it starts.',
    fields: [{ k: 'lookahead_hours', label: 'Show from (hours before)', type: 'number' }, { k: 'max', label: 'How many', type: 'number' }],
    defaultOpts: { lookahead_hours: 12, max: 3 },
    fetch({ opts, cache, now, all }) {
      const ahead = (+opts.lookahead_hours || 12) * H;
      const local = all ? all('SELECT id, title, start, all_day FROM events').map((e) => ({ id: 'l' + e.id, title: e.title, start: new Date(e.start), allDay: !!e.all_day })) : [];
      const evs = (cache.calendar || []).concat(local).filter((e) => !e.allDay && +e.start > now && +e.start - now <= ahead)
        .sort((a, b) => a.start - b.start).slice(0, +opts.max || 3);
      return evs.map((e) => {
        const s = +e.start, day = dayStart(s) === dayStart(now) ? 'TODAY' : dayStart(s) === dayStart(now) + DAY ? 'TOMORROW' : DOW[new Date(s).getDay()];
        return { type: 'scheduled', key: 'cal:' + (e.id || e.uid || e.title) + ':' + s, lines: ['NEXT UP', clean(e.title), day + ' ' + hm(new Date(s))], starts_at: s - ahead, expires_at: s };
      });
    }
  },
  countdown: {
    label: 'Countdowns', type: 'scheduled', every: 600, enabled: true,
    notes: 'Days until a date. Shows from N days before; also uses the dashboard’s Countdowns list if ticked.',
    fields: [{ k: 'items', label: 'Countdowns', type: 'lines', fmt: 'countdowns' }, { k: 'days_before', label: 'Show from (days before)', type: 'number' }, { k: 'include_dashboard', label: 'Include Settings › Countdowns', type: 'check' }],
    defaultOpts: { items: [], days_before: 30, include_dashboard: true },
    fetch({ opts, now, all }) {
      const list = (opts.items || []).slice();
      if (opts.include_dashboard && all) for (const c of all('SELECT title, date FROM countdowns')) list.push({ date: c.date, label: c.title });
      const before = (+opts.days_before || 30) * DAY, ds = dayStart(now);
      return list.map((it, i) => {
        const d = +new Date(it.date + 'T00:00');
        if (!(d >= ds) || d - ds > before) return null;
        const n = Math.round((d - ds) / DAY);
        return { type: 'scheduled', key: 'countdown:' + it.date + ':' + i, lines: n === 0 ? ['TODAY IS', clean(it.label)] : [n + (n === 1 ? ' DAY' : ' DAYS') + ' UNTIL', clean(it.label)], starts_at: d - before, expires_at: d + DAY };
      }).filter(Boolean);
    }
  },
  ha_sensors: {
    label: 'Home Assistant sensors', type: 'live', every: 30, enabled: true,
    notes: 'Live values of the entities you list, from the Home Assistant connection in Settings.',
    fields: [{ k: 'title', label: 'Title', type: 'text', ph: 'HOME' }, { k: 'entities', label: 'Entities', type: 'lines', fmt: 'sensors' }],
    defaultOpts: { title: '', entities: [] },
    fetch({ opts, cache }) {
      if (!(opts.entities || []).length) return [];
      if (!cache.ha) throw new Error('Home Assistant not connected');
      const lines = [clean(opts.title) || 'HOME'];
      for (const e of opts.entities) {
        const s = cache.ha.states[e.entity];
        if (!s) continue;
        const unit = (s.attributes && s.attributes.unit_of_measurement) || '';
        const v = isNaN(+s.state) ? s.state : String(Math.round(+s.state * 10) / 10);
        lines.push(((e.label || (s.attributes && s.attributes.friendly_name) || e.entity) + ' ' + v + (unit === '°F' || unit === '°C' ? '°' : unit ? ' ' + unit : '')).trim());
      }
      return [{ type: 'live', key: 'ha_sensors', lines, align: 'left', stale_after: +new Date(cache.ha.updated) + 10 * 60e3 }];
    }
  },
  ha_alert: {
    label: 'Home Assistant alerts', type: 'alert', every: 15, enabled: true,
    notes: 'Shows a message while an entity matches, e.g. the garage is open or the washer is done. Clears itself when the condition ends; shows for the alert time limit at most.',
    fields: [{ k: 'rules', label: 'Rules', type: 'lines', fmt: 'rules' }],
    defaultOpts: { rules: [] },
    fetch({ opts, cache, now, state, ttl }) {
      if (!(opts.rules || []).length) return [];
      if (!cache.ha) throw new Error('Home Assistant not connected');
      state.since = state.since || {};
      const out = [];
      opts.rules.forEach((r, i) => {
        const s = cache.ha.states[r.entity], v = s ? s.state : null, key = 'ha_alert:' + i + ':' + r.entity;
        const hit = v != null && (r.op === '=' ? v === r.value : r.op === '!=' ? v !== r.value : r.op === '>' ? +v > +r.value : +v < +r.value);
        if (!hit) { delete state.since[key]; return; } // condition cleared: stop emitting
        const t0 = state.since[key] || (state.since[key] = now);
        out.push({ type: 'alert', key, lines: [r.message], urgent: !!r.urgent, created: t0, expires_at: t0 + ttl * 1000 });
      });
      return out;
    }
  },
  verse: {
    label: 'Bible verse', type: 'ambient', every: 3600, enabled: true,
    notes: 'World English Bible (public domain), a bundled set of 236 short verses. No internet needed.',
    fields: [{ k: 'mode', label: 'Show', type: 'select', opts: [['daily', 'One verse a day'], ['pool', 'Shuffle all of them']] }],
    defaultOpts: { mode: 'daily' },
    fetch({ opts, now }) {
      VERSES = VERSES || DATA('verses.json').verses;
      const card = (v, i) => ({ type: 'ambient', key: 'verse:' + i, lines: [v.text, '- ' + v.ref] });
      if (opts.mode === 'pool') return VERSES.map(card);
      const i = Math.floor(dayStart(now) / DAY) % VERSES.length;
      return [card(VERSES[i], i)];
    }
  },
  quote: {
    label: 'Quotes', type: 'ambient', every: 3600, enabled: true,
    notes: 'Ben Franklin’s Way to Wealth sayings (1758, public domain), bundled.',
    fields: [],
    defaultOpts: {},
    fetch() {
      QUOTES = QUOTES || DATA('quotes.json').quotes;
      return QUOTES.map((q, i) => ({ type: 'ambient', key: 'quote:' + i, lines: [q.text, '- ' + q.by.toUpperCase()] }));
    }
  },
  flights: {
    label: 'Planes overhead', type: 'live', every: 300, enabled: false,
    notes: 'Aircraft near home from public ADS-B data, no account or key. OpenSky (anonymous: 400 requests a day, so the default is one every 5 minutes; non-commercial use) or adsb.lol (ODbL). Uses the home location from Settings. Off until you turn it on.',
    fields: [{ k: 'provider', label: 'Data', type: 'select', opts: [['opensky', 'OpenSky Network'], ['adsblol', 'adsb.lol']] }, { k: 'radius_mi', label: 'Radius (miles)', type: 'number' }, { k: 'max', label: 'How many', type: 'number' }],
    defaultOpts: { provider: 'opensky', radius_mi: 8, max: 3 },
    async fetch({ opts, http, now, home }) {
      if (!home || home.lat == null) throw new Error('Set the home location in Settings first');
      const r = Math.min(50, Math.max(1, +opts.radius_mi || 8)), lat = +home.lat, lon = +home.lon;
      const dLat = r / 69, dLon = r / (69 * Math.cos(lat * Math.PI / 180));
      let planes = [];
      if (opts.provider === 'adsblol') {
        const j = await http('https://api.adsb.lol/v2/point/' + lat.toFixed(4) + '/' + lon.toFixed(4) + '/' + Math.round(r * 0.869));
        planes = (j.ac || []).map((a) => ({ cs: clean(a.flight) || a.hex, alt: a.alt_baro === 'ground' ? 0 : a.alt_baro, lat: a.lat, lon: a.lon }));
      } else {
        const j = await http('https://opensky-network.org/api/states/all?lamin=' + (lat - dLat).toFixed(4) + '&lomin=' + (lon - dLon).toFixed(4) + '&lamax=' + (lat + dLat).toFixed(4) + '&lomax=' + (lon + dLon).toFixed(4));
        planes = (j.states || []).filter((s) => !s[8]).map((s) => ({ cs: clean(s[1]) || s[0], alt: s[7] != null ? Math.round(s[7] * 3.281) : null, lat: s[6], lon: s[5] }));
      }
      const dist = (p) => Math.hypot((p.lat - lat) * 69, (p.lon - lon) * 69 * Math.cos(lat * Math.PI / 180));
      planes = planes.filter((p) => p.lat != null && p.alt).sort((a, b) => dist(a) - dist(b)).slice(0, +opts.max || 3);
      if (!planes.length) return [];
      return [{ type: 'live', key: 'flights', align: 'left', stale_after: now + 10 * 60e3,
        lines: ['OVERHEAD'].concat(planes.map((p) => (p.cs + ' ' + Math.round(p.alt / 100) * 100 + 'FT ' + dist(p).toFixed(0) + 'MI').replace(/\s+/g, ' '))) }];
    }
  },
  flights_tracked: {
    label: 'Tracked flight (needs API key)', type: 'live', every: 600, enabled: false, needsKey: true,
    notes: 'Setup notes only, no calls yet. To follow a flight number (delays, gate, landing) you need a keyed API: FlightAware AeroAPI (Personal tier, $5 free credit a month) or AviationStack (free tier: 100 requests a month). Sign up yourself, paste the key here, then ask for this source to be finished. Until then it stays off and makes no requests.',
    fields: [{ k: 'provider', label: 'API', type: 'select', opts: [['aeroapi', 'FlightAware AeroAPI'], ['aviationstack', 'AviationStack']] }, { k: 'flight', label: 'Flight number', type: 'text', ph: 'UA123' }],
    defaultOpts: { provider: 'aeroapi', flight: '' },
    fetch() { throw new Error('Not built yet: setup notes only (no requests are made)'); }
  }
};

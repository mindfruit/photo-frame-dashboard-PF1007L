// Card selector: which card a screen shows now. Pure (state object in, card out); times are ms numbers.
//
// A card: { type, key, lines, starts_at?, expires_at?, stale_after?, dwell?, screens?, priority?, urgent?, created?, accent?, align? }
// Ladder (higher never waits behind lower): ALERT > PERSONAL > LIVE = SCHEDULED > AMBIENT.
//   alert      preempts at once, short dwell, expires fast or when its source stops emitting it
//   personal   posted notes: biggest weight share, decaying with age (half-life), expire after N hours
//   live       refreshed by key, hidden once past stale_after
//   scheduled  only inside starts_at..expires_at
//   ambient    verses / quotes: shuffled, no repeat until the pool is used up; fills gaps, plus its (small) weight share
//              when it has one (weight 0 = gaps only)
// Quiet hours: only alerts marked urgent.

export const TYPES = ['alert', 'personal', 'live', 'scheduled', 'ambient'];
export const LEVEL = { alert: 4, personal: 3, live: 2, scheduled: 2, ambient: 1 };
// Defaults (seconds). Each source can override dwell / accent / priority, each screen the weights and which types run.
export const TYPE_DEFAULTS = {
  alert: { dwell: 12, ttl: 600, accent: 'red' },
  personal: { dwell: 20, ttl: 12 * 3600, weight: 5, half_life: 3 * 3600, floor: 0.2, accent: 'soft' },
  live: { dwell: 20, stale: 1800, weight: 2, accent: '' },
  scheduled: { dwell: 20, weight: 2, accent: '' },
  ambient: { dwell: 30, weight: 1, accent: '' }
};

export function newState() { return { cur: null, since: 0, last: {}, rr: {}, bag: [], lastAmbient: null }; }

function active(c, now) {
  return (!c.starts_at || now >= c.starts_at) && (!c.expires_at || now < c.expires_at) && (!c.stale_after || now < c.stale_after);
}
// A newer card with the same key replaces the old one (cards are in arrival order).
export function dedupe(cards) {
  const m = new Map();
  for (const c of cards) m.set(c.key, c);
  return [...m.values()];
}
export function decay(c, now, td) {
  const p = td.personal, age = Math.max(0, (now - (c.created || now)) / 1000);
  return Math.max(p.floor, Math.pow(0.5, age / p.half_life));
}

// opts: { screen, types: {alert:true,...}, weights: {personal, live, scheduled, ambient}, quiet, defaults, rng }
export function select(cards, st, now, opts = {}) {
  const td = opts.defaults || TYPE_DEFAULTS, on = opts.types || {}, W = Object.assign({}, ...TYPES.map((t) => ({ [t]: (td[t] || {}).weight || 0 })), opts.weights || {});
  const rng = opts.rng || Math.random;
  const pool = dedupe(cards).filter((c) => LEVEL[c.type] && on[c.type] !== false && active(c, now) &&
    (!c.screens || !opts.screen || c.screens.includes('all') || c.screens.includes(opts.screen)) &&
    (!opts.quiet || (c.type === 'alert' && c.urgent)));
  const dwell = (c) => (c.dwell || (td[c.type] || {}).dwell || 20) * 1000;
  const unseen = (c) => st.last[c.key] == null;
  const cur = pool.find((c) => c.key === st.cur);
  const alerts = pool.filter((c) => c.type === 'alert');

  let go = !cur;
  if (cur && alerts.length && cur.type !== 'alert') go = true; // alert preempts
  else if (cur && pool.some((c) => LEVEL[c.type] > LEVEL[cur.type] && unseen(c))) go = true; // a new higher card doesn't wait
  else if (cur && now - st.since >= dwell(cur)) go = true;
  if (!go) return { card: cur, switched: false };

  const lru = (list) => list.slice().sort((a, b) => (unseen(b) - unseen(a)) || ((b.priority || 0) - (a.priority || 0)) ||
    ((st.last[a.key] || 0) - (st.last[b.key] || 0)) || (a.key < b.key ? -1 : 1));
  const notCur = (list) => (list.length > 1 ? list.filter((c) => c.key !== st.cur) : list);
  let pick = null;
  if (alerts.length) pick = lru(notCur(alerts))[0];
  else {
    const groups = { personal: [], live: [], scheduled: [], ambient: [] };
    for (const c of pool) if (groups[c.type]) groups[c.type].push(c);
    // never-shown cards go first, highest level first
    for (const g of ['personal', 'live', 'scheduled']) { const u = groups[g].filter(unseen); if (u.length) { pick = lru(u)[0]; break; } }
    if (!pick) {
      const w = {
        personal: groups.personal.length ? W.personal * Math.max(...groups.personal.map((c) => decay(c, now, td))) : 0,
        live: groups.live.length ? W.live : 0, scheduled: groups.scheduled.length ? W.scheduled : 0,
        ambient: groups.ambient.length && (W.ambient > 0) ? W.ambient : 0
      };
      const total = w.personal + w.live + w.scheduled + w.ambient;
      let g = null;
      if (total > 0) { // smooth weighted round robin (deterministic, spreads each group out evenly)
        for (const k of Object.keys(w)) { if (w[k] > 0) st.rr[k] = (st.rr[k] || 0) + w[k]; else delete st.rr[k]; }
        g = Object.keys(st.rr).sort((a, b) => st.rr[b] - st.rr[a] || LEVEL[b] - LEVEL[a])[0];
        st.rr[g] -= total;
      } else if (groups.ambient.length) g = 'ambient'; // nothing else: ambient fills the gap
      if (g === 'ambient') pick = fromBag(groups.ambient, st, rng);
      else if (g) pick = lru(notCur(groups[g]))[0];
    }
  }
  if (!pick) { st.cur = null; return { card: null, switched: !!cur }; }
  const switched = pick.key !== st.cur;
  st.cur = pick.key; st.since = now; st.last[pick.key] = now;
  return { card: pick, switched };
}

// Shuffle bag: every ambient card once before any repeats; a new cycle doesn't start with the one just shown.
function fromBag(list, st, rng) {
  const keys = new Set(list.map((c) => c.key));
  st.bag = st.bag.filter((k) => keys.has(k));
  if (!st.bag.length) {
    const b = [...keys];
    for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = b[i]; b[i] = b[j]; b[j] = t; }
    if (b.length > 1 && b[b.length - 1] === st.lastAmbient) { const t = b[0]; b[0] = b[b.length - 1]; b[b.length - 1] = t; }
    st.bag = b;
  }
  const k = st.bag.pop();
  st.lastAmbient = k;
  return list.find((c) => c.key === k);
}

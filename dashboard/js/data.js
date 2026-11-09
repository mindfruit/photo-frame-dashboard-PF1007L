// Dashboard data. Real data comes from the local server (GET /api/state, see server/) and stays
// live through Server-Sent Events (/api/events). Views read window.DATA.<field> each time they
// render, so on every change we swap the fields in place and re-render the current view.
// Photos and the AI-agent panel are still demo data (see js/data-mock.js for the original mock).
window.DATA = (function () {
  var base = new Date();
  base.setHours(0, 0, 0, 0);

  var CATS = ['Produce', 'Bakery', 'Meat & Fish', 'Dairy & Eggs', 'Pantry', 'Frozen', 'Snacks', 'Household'];
  // Name -> aisle dictionary used to auto-categorize shopping items.
  var catalog = [
    ['Apples', 'Produce'], ['Avocados', 'Produce'], ['Bananas', 'Produce'], ['Baby spinach', 'Produce'], ['Blueberries', 'Produce'],
    ['Broccoli', 'Produce'], ['Carrots', 'Produce'], ['Cucumber', 'Produce'], ['Garlic', 'Produce'], ['Grapes', 'Produce'],
    ['Lemons', 'Produce'], ['Limes', 'Produce'], ['Onions', 'Produce'], ['Potatoes', 'Produce'], ['Strawberries', 'Produce'],
    ['Tomatoes', 'Produce'], ['Bread', 'Bakery'], ['Bagels', 'Bakery'], ['Croissants', 'Bakery'], ['Sourdough loaf', 'Bakery'],
    ['Tortillas', 'Bakery'], ['Hamburger buns', 'Bakery'], ['Bacon', 'Meat & Fish'], ['Chicken breasts', 'Meat & Fish'],
    ['Chicken thighs', 'Meat & Fish'], ['Ground beef', 'Meat & Fish'], ['Salmon fillets', 'Meat & Fish'], ['Shrimp', 'Meat & Fish'],
    ['Butter', 'Dairy & Eggs'], ['Cheddar', 'Dairy & Eggs'], ['Cream cheese', 'Dairy & Eggs'], ['Eggs', 'Dairy & Eggs'],
    ['Greek yogurt', 'Dairy & Eggs'], ['Milk 2%', 'Dairy & Eggs'], ['Oat milk', 'Dairy & Eggs'], ['Parmesan', 'Dairy & Eggs'],
    ['Black beans', 'Pantry'], ['Cereal', 'Pantry'], ['Coffee beans', 'Pantry'], ['Flour', 'Pantry'], ['Honey', 'Pantry'],
    ['Maple syrup', 'Pantry'], ['Olive oil', 'Pantry'], ['Pasta sauce', 'Pantry'], ['Peanut butter', 'Pantry'], ['Rice', 'Pantry'],
    ['Rigatoni', 'Pantry'], ['Spaghetti', 'Pantry'], ['Sugar', 'Pantry'], ['Tea', 'Pantry'], ['Frozen peas', 'Frozen'],
    ['Frozen berries', 'Frozen'], ['Ice cream', 'Frozen'], ['Pizza', 'Frozen'], ['Waffles', 'Frozen'], ['Chips', 'Snacks'],
    ['Crackers', 'Snacks'], ['Dark chocolate', 'Snacks'], ['Goldfish crackers', 'Snacks'], ['Granola bars', 'Snacks'],
    ['Popcorn', 'Snacks'], ['Dish soap', 'Household'], ['Dishwasher pods', 'Household'], ['Garbage bags', 'Household'],
    ['Laundry detergent', 'Household'], ['Paper towels', 'Household'], ['Toilet paper', 'Household'], ['Toothpaste', 'Household']
  ];

  // ---------------------------------------------------------------- AI agent usage (CodexBar-style)
  // left = minutes until the window resets; win = window length in minutes (for pace)
  var H5 = 300, DAY = 1440, WEEK = 10080, MONTH = 43200;
  var agents = [
    {
      id: 'claude', name: 'Claude', plan: 'Max 20×', color: '#D97757', rgb: '217 119 87', status: 'ok',
      meters: [
        { label: 'Session', win: H5, used: 62, left: 134 },
        { label: 'Weekly · all models', win: WEEK, used: 41, left: 4680 }
      ],
      tokens: 3.1, cost: 21.4, week: [2.2, 3.8, 2.9, 4.4, 1.6, 0.8, 3.1]
    },
    {
      id: 'codex', name: 'Codex', plan: 'ChatGPT Pro', color: '#10A37F', rgb: '16 163 127', status: 'ok',
      meters: [
        { label: 'Session', win: H5, used: 88, left: 38 },
        { label: 'Weekly', win: WEEK, used: 57, left: 7320 }
      ],
      tokens: 4.6, cost: 17.9, week: [3.1, 2.4, 5.2, 4.0, 2.2, 1.1, 4.6]
    },
    {
      id: 'cursor', name: 'Cursor', plan: 'Pro+', color: '#111111', rgb: '17 17 17', status: 'ok',
      meters: [
        { label: 'Included usage', win: MONTH, used: 76, left: 17280, detail: '$45.60 of $60' },
        { label: 'On-demand', win: MONTH, used: 16, left: 17280, detail: '$8.20 of $50 cap' }
      ],
      tokens: 1.8, cost: 6.3, week: [1.2, 1.9, 0.7, 2.3, 1.5, 0.4, 1.8]
    },
    {
      id: 'gemini', name: 'Gemini', plan: 'AI Ultra', color: '#3F6FE4', rgb: '63 111 228', status: 'ok',
      meters: [
        { label: 'Requests · daily', win: DAY, used: 16, left: 522, detail: '320 of 2,000' },
        { label: 'Pro model · daily', win: DAY, used: 52, left: 522, detail: '104 of 200' }
      ],
      tokens: 0.9, cost: 0, week: [0.4, 1.1, 0.6, 0.2, 0.9, 1.3, 0.9]
    },
    {
      id: 'copilot', name: 'Copilot', plan: 'Pro+', color: '#8957E5', rgb: '137 87 229', status: 'degraded', incident: 'Elevated errors on coding agent',
      meters: [
        { label: 'Premium requests', win: MONTH, used: 75, left: 17280, detail: '1,124 of 1,500' },
        { label: 'Coding agent', win: MONTH, used: 38, left: 17280, detail: '19 of 50 sessions' }
      ],
      tokens: 1.2, cost: 0, week: [0.9, 1.4, 1.1, 0.8, 1.6, 0.3, 1.2]
    }
  ];


  var D = {
    people: [], ALL: [],
    family: { id: 'family', name: 'Family', color: '#111111', rgb: '17 17 17', ink: '#FFFFFF' },
    events: [], busyExtras: [],
    routines: [
      { id: 'morning', name: 'Morning', range: '12 AM – 11 AM', from: 0, to: 11 },
      { id: 'after', name: 'Afternoon', range: '11 AM – 5 PM', from: 11, to: 17 },
      { id: 'evening', name: 'Evening', range: '5 PM – 12 AM', from: 17, to: 24 }
    ],
    chores: [], stars: {}, pendingStars: {}, week: {}, rewards: [], countdowns: [], pendingApprovals: 0,
    stores: [], catOrder: { all: CATS }, groceries: [], catalog: catalog, usuals: [],
    rooms: [], devices: [], cameras: [], scenes: [], connected: false, ha: [], haGroups: [], homeEnabled: false,
    rewardRequests: [], approvalRequired: false, notes: [], icons: [], learning: null, family: { id: 'family', name: 'Family', color: '#111111', rgb: '17 17 17', ink: '#FFFFFF', stars: 0, goal: 0, title: '', emoji: '🏆' },
    climate: { current: '–', set: '–', mode: 'off', humidity: '–', outside: '–' },
    media: { room: 'No', title: 'Nothing playing', artist: '', playing: false, volume: 0, seed: 'speaker' },
    weather: { unit: 'F', hi: '–', lo: '–', feels: '–', humidity: '–', wind: '–', t: fill('–'), c: fill('cloud'), p: fill(0), missing: true },
    photos: [], // local-only: no demo pictures; with no real photos the slideshows show "Add photos in the admin"
    agents: agents, quiet: { start: '', end: '' }, soundsOn: true,
    loaded: false, online: false
  };
  function fill(v) { var a = []; for (var i = 0; i < 24; i++) a.push(v); return a; }

  // Temporary ids for optimistic adds; the next reload replaces them with server ids.
  var tmp = 0;
  D._gid = function () { return 'tmp' + (++tmp); };
  D._eid = function () { return 'tmp' + (++tmp); };

  // Small fetch wrapper: D.api('POST', 'shopping', { name: 'Milk' })
  D.api = function (method, path, body, pin) {
    var headers = body ? { 'Content-Type': 'application/json' } : {};
    if (pin) headers['X-PIN'] = pin;
    return fetch('/api/' + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var err = new Error(j.error || ('HTTP ' + r.status)); err.status = r.status; throw err; }
        return j;
      });
    });
  };

  // Which screen is this? ?device=kitchen in the URL wins; otherwise a random id kept in localStorage.
  var qs = /[?&]device=([\w.-]+)/.exec(location.search);
  var deviceId = qs ? qs[1] : (localStorage.getItem('deviceId') || 'screen-' + Math.random().toString(36).slice(2, 8));
  try { localStorage.setItem('deviceId', deviceId); } catch (e) {}
  var ua = navigator.userAgent;
  var hint = /Android/.test(ua) ? 'Android ' + ((/;\s*([^;)]+)\s+Build/.exec(ua) || [])[1] || 'screen') : /iPhone|iPad/.test(ua) ? 'iOS device' : /Mac/.test(ua) ? 'Mac browser' : 'Browser';
  D.deviceId = deviceId;
  D.device = null;

  var FIELDS = ['people', 'ALL', 'routines', 'chores', 'stars', 'pendingStars', 'week', 'events', 'stores', 'catOrder',
    'groceries', 'usuals', 'rewards', 'countdowns', 'pendingApprovals', 'weather', 'rooms', 'devices', 'climate',
    'media', 'cameras', 'scenes', 'connected', 'ha', 'haGroups', 'homeEnabled', 'rewardRequests', 'approvalRequired', 'notes', 'icons', 'learning', 'family', 'quiet', 'soundsOn'];
  D.reload = function () {
    return fetch('/api/state?device=' + encodeURIComponent(deviceId) + '&name=' + encodeURIComponent(hint), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (s) {
      s.events.forEach(function (e) { e.start = new Date(e.start); e.end = new Date(e.end); });
      if (!s.routines.length) delete s.routines;
      // (only swap the list when it really changed, so the slideshow isn't reset on every live update)
      var key = function (ps) { return ps.map(function (p) { return p.seed + p.date + (p.fav ? '*' : '') + (p.place || '') + '@' + (p.src || '') + '~' + (p.frame || '') + (p.style || '') + (p.mat || '') + (p.album || ''); }).join('|'); }; // + caption, source and frame style, so photos moved between albums relabel / restyle
      // per-screen sources: the server already filtered s.photos
      if (s.photos && s.photos.length) { if (key(D.photos) !== key(s.photos)) D.photos = s.photos; } else if (D.photos.length) D.photos = [];
      delete s.demoPhotos; // older servers
      D.device = s.device || null;
      if (D.device && D.device.quiet.start && D.device.quiet.end) s.quiet = D.device.quiet; // per-screen quiet hours win
      FIELDS.forEach(function (k) { if (s[k] !== undefined) D[k] = s[k]; });
      // the server's family is only the star goal: keep the Family look (Anyone lane, Everyone button) on it
      D.family = Object.assign({ id: 'family', name: 'Family', color: '#111111', rgb: '17 17 17', ink: '#FFFFFF' }, D.family);
      // real state: only server-reported agents (mock cards stay for the offline/demo fallback only)
      D.agents = Array.isArray(s.agents) ? s.agents : [];
      D.loaded = true; D.online = true;
      if (window.App && App.emit) { App.emit('data'); if (App.rerender) App.rerender(); }
    }).catch(function (e) {
      D.online = false;
      console.warn('Dashboard data unavailable:', e.message);
    });
  };

  var timer;
  D.scheduleReload = function () { clearTimeout(timer); timer = setTimeout(D.reload, 250); };
  D.reload();
  if (window.EventSource) {
    var es = new EventSource('/api/events');
    es.addEventListener('change', D.scheduleReload);
    es.addEventListener('hello', D.scheduleReload); // also fires after a reconnect, so we resync
  }
  setInterval(D.reload, 5 * 60 * 1000); // safety net (and picks up the new day's chores)

  return D;
})();
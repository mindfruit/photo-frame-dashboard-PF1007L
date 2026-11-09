// Core shell: router, demo clock, idle/ambient, toasts, sheets, helpers.
(function () {
  'use strict';
  var D = window.DATA;
  var App = window.App = { state: D, views: {}, current: null, mode: 'day', calMode: 'normal' };
  var $ = App.$ = function (s, r) { return (r || document).querySelector(s); };
  App.$$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ------------------------------------------------------------ events
  var handlers = {};
  App.on = function (e, fn) { (handlers[e] = handlers[e] || []).push(fn); };
  App.emit = function (e, a) { (handlers[e] || []).forEach(function (fn) { fn(a); }); };

  // ------------------------------------------------------------ time (demo clock)
  var offset = 0;
  App.now = function () { return new Date(Date.now() + offset); };
  App.setTime = function (h, m) {
    if (h == null) offset = 0;
    else { var d = new Date(); d.setHours(h, m, 0, 0); offset = d - Date.now(); }
    lastMin = -1;
    App.emit('time');
    App.rerender();
  };
  App.dayStart = function (d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  App.addDays = function (d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; };
  App.sameDay = function (a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); };
  // Quiet hours come from the parent page (Settings); default 10 PM – 6 AM.
  App.isQuiet = function () {
    var q = (window.DATA && window.DATA.quiet) || {};
    if (!q.start || !q.end) return false;
    var n = App.now(), m = n.getHours() * 60 + n.getMinutes();
    var s = +q.start.slice(0, 2) * 60 + +q.start.slice(3), e = +q.end.slice(0, 2) * 60 + +q.end.slice(3);
    return s > e ? (m >= s || m < e) : (m >= s && m < e);
  };
  App.isNight = function () {
    var q = (window.DATA && window.DATA.quiet) || {};
    if (q.start && q.end) return App.isQuiet();
    var h = App.now().getHours(); return h >= 22 || h < 6;
  };

  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'June', 'July', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
  App.fmt = {
    time: function (d, ampm) {
      var h = d.getHours(), m = d.getMinutes();
      var s = (h % 12 || 12) + ':' + (m < 10 ? '0' : '') + m;
      return ampm === false ? s : s + ' ' + (h >= 12 ? 'PM' : 'AM');
    },
    // "4 PM", "3:45 PM"
    hour: function (d) {
      var h = d.getHours(), m = d.getMinutes();
      return (h % 12 || 12) + (m ? ':' + (m < 10 ? '0' : '') + m : '') + ' ' + (h >= 12 ? 'PM' : 'AM');
    },
    ampm: function (d) { return d.getHours() >= 12 ? 'PM' : 'AM'; },
    range: function (a, b) {
      var same = App.fmt.ampm(a) === App.fmt.ampm(b);
      return (same ? App.fmt.time(a, false) : App.fmt.time(a)) + ' – ' + App.fmt.time(b);
    },
    day: function (d) { return DAYS[d.getDay()]; },
    dayShort: function (d) { return DAYS[d.getDay()].slice(0, 3); },
    month: function (d) { return MONTHS[d.getMonth()]; },
    monthShort: function (d) { return MON_SHORT[d.getMonth()]; },
    mins: function (m) {
      m = Math.max(0, Math.round(m));
      if (m < 60) return m + ' min';
      var h = Math.floor(m / 60), r = m % 60;
      return h + ' hr' + (r ? ' ' + r + ' min' : '');
    },
    rel: function (d) {
      var t = App.dayStart(App.now()), x = App.dayStart(d), diff = Math.round((x - t) / 864e5);
      if (diff === 0) return 'Today';
      if (diff === 1) return 'Tomorrow';
      if (diff === -1) return 'Yesterday';
      return DAYS[d.getDay()];
    }
  };
  App.esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };

  // ------------------------------------------------------------ icons + people
  App.icon = function (name, size, cls) {
    size = size || 24;
    return '<svg class="i ' + (cls || '') + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (window.ICONS[name] || '') + '</svg>';
  };
  App.person = function (id) {
    if (id === 'family' || id === 'any') return D.family;
    for (var i = 0; i < D.people.length; i++) if (D.people[i].id === id) return D.people[i];
    return D.family;
  };
  // WCAG contrast of two #rrggbb colours
  function lum(hex) {
    var n = parseInt(String(hex).replace('#', ''), 16) || 0;
    return [n >> 16 & 255, n >> 8 & 255, n & 255].map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); })
      .reduce(function (s, v, i) { return s + v * [0.2126, 0.7152, 0.0722][i]; }, 0);
  }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
  App.contrast = contrast;
  var paperInk = {}, nightC = {};
  // The person colour for the Dim night dashboard (css/night.css): mixed into the night background (#15110D) as far as
  // the night ink (#C2A780) still reads on it at 4.6:1 (fills), and halfway to the ink for text on the dark page.
  function hex(c) { return '#' + c.map(function (v) { v = Math.round(v); return (v < 16 ? '0' : '') + v.toString(16); }).join(''); }
  function nightOf(c) {
    if (nightC[c]) return nightC[c];
    var bg = [21, 17, 13], ink = [194, 167, 128], m = /^#([0-9a-f]{6})$/i.exec(c);
    if (!m || lum(c) < 0.03) return (nightC[c] = { c: '#3A2E22', t: '#C2A780' }); // ink-like colours (Family) = the night "selected" fill
    var rgb = [0, 2, 4].map(function (i) { return parseInt(m[1].substr(i, 2), 16); }), mix = function (a, b, k) { return hex(a.map(function (v, i) { return v * k + b[i] * (1 - k); })); };
    var k = 0.5; while (k > 0.15 && contrast(mix(rgb, bg, k), '#C2A780') < 4.6) k -= 0.05;
    return (nightC[c] = { c: mix(rgb, bg, k), t: mix(rgb, ink, 0.5) });
  }
  App.pstyle = function (p) {
    if (typeof p === 'string') p = App.person(p);
    // --c-ink-p: the paper theme's text on the person colour, paper ink or white, whichever reads better (css/themes/paper.css)
    var c = p.color, pi = paperInk[c] || (paperInk[c] = /^#[0-9a-f]{6}$/i.test(c) && contrast(c, '#2B2118') >= contrast(c, '#FFFFFF') ? '#2B2118' : '#FFFFFF'), n = nightOf(c);
    return '--c:' + c + ';--c-rgb:' + p.rgb + ';--c-ink:' + p.ink + ';--c-ink-p:' + pi + ';--c-n:' + n.c + ';--c-nt:' + n.t;
  };
  App.avatar = function (p, size, cls) {
    if (typeof p === 'string') p = App.person(p);
    size = size || 48;
    return '<span class="avatar ' + (cls || '') + '" style="' + App.pstyle(p) + ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.46) + 'px">' + (p.id === 'family' ? '★' : (p.name || '?')[0]) + '</span>';
  };
  App.dots = function (ids, size) {
    return '<span class="dots">' + ids.map(function (id) { return '<i style="' + App.pstyle(id) + (size ? ';width:' + size + 'px;height:' + size + 'px' : '') + '"></i>'; }).join('') + '</span>';
  };

  // ------------------------------------------------------------ calendar helpers
  App.events = function () {
    var list = D.events.slice();
    var today = App.dayStart(App.now());
    if (App.calMode === 'busy') list = list.concat(D.busyExtras);
    if (App.calMode === 'empty') list = list.filter(function (e) { return e.allDay || !App.sameDay(e.start, today); });
    return list;
  };
  App.isFamily = function (e) { return e.people.length >= D.people.length; };
  App.evColor = function (e) { return App.isFamily(e) ? D.family : App.person(e.people[0]); };
  App.timedOn = function (day, pid) {
    var s = App.dayStart(day), e = App.addDays(s, 1);
    return App.events().filter(function (ev) {
      return !ev.allDay && ev.start < e && ev.end > s && (!pid || ev.people.indexOf(pid) > -1);
    }).sort(function (a, b) { return a.start - b.start || b.end - a.end; });
  };
  App.allDayOn = function (day, pid) {
    var s = App.dayStart(day), e = App.addDays(s, 1);
    return App.events().filter(function (ev) {
      return ev.allDay && ev.start < e && ev.end > s && (!pid || ev.people.indexOf(pid) > -1);
    });
  };
  App.leaveBy = function (e) { return e.travel ? new Date(+e.start - e.travel * 60000) : e.start; };
  // The next thing someone needs to act on: earliest upcoming "leave by" today.
  App.nextEvent = function () {
    var now = App.now();
    var list = App.timedOn(now).filter(function (e) { return e.start > now; });
    list.sort(function (a, b) { return App.leaveBy(a) - App.leaveBy(b); });
    return list[0] || null;
  };
  App.findEvent = function (id) {
    return App.events().filter(function (e) { return e.id === id; })[0];
  };

  // ------------------------------------------------------------ chores + weather helpers
  App.currentRoutine = function () {
    var h = App.now().getHours();
    for (var i = 0; i < D.routines.length; i++) if (h >= D.routines[i].from && h < D.routines[i].to) return D.routines[i];
    return D.routines[2];
  };
  App.weatherNow = function () {
    var W = D.weather, h = App.now().getHours();
    var rainAt = -1;
    for (var i = h; i < 24; i++) if (W.p[i] >= 50) { rainAt = i; break; }
    var summary, advice;
    if (rainAt === h) {
      var stop = h; while (stop < 24 && W.p[stop] >= 50) stop++;
      summary = 'Rain until ' + App.fmt.hour(new Date(2000, 0, 1, stop));
      advice = 'Umbrella weather';
    } else if (rainAt > -1) {
      summary = 'Rain from ' + App.fmt.hour(new Date(2000, 0, 1, rainAt));
      var soccer = App.timedOn(App.now()).filter(function (e) { return /soccer/i.test(e.title) && e.start > App.now(); })[0];
      advice = soccer ? 'Pack a rain jacket for soccer' : 'Grab a rain jacket';
    } else {
      var cool = W.t[h] < (W.unit === 'C' ? 12 : 54);
      summary = cool ? 'Clear and cool' : 'Dry all day';
      advice = cool ? 'Jacket weather' : 'Light layers';
    }
    var labels = { sun: 'Sunny', moon: 'Clear', partly: 'Partly cloudy', cloud: 'Overcast', rain: 'Rain' };
    return { temp: W.t[h], cond: W.c[h], label: labels[W.c[h]], hi: W.hi, lo: W.lo, summary: summary, advice: advice, hour: h };
  };
  App.hourly = function (count) {
    var W = D.weather, h = App.now().getHours(), out = [];
    for (var i = 0; i < count; i++) {
      var x = (h + i) % 24;
      out.push({ h: x, t: W.t[x], c: W.c[x], p: W.p[x], label: i === 0 ? 'Now' : ((x % 12 || 12) + (x >= 12 ? 'p' : 'a')) });
    }
    return out;
  };

  // ------------------------------------------------------------ router
  App.register = function (name, view) { App.views[name] = view; };
  // Views are built once and kept laid out (hidden with content-visibility), so switching tabs
  // only has to paint. A view is rebuilt when its data changed ('data'/'time' events) or, for
  // time-sensitive views (minutely: true), when the minute has rolled over since it was built.
  function minuteKey() { return Math.floor(App.now().getTime() / 60000); }
  function build(name, opts) {
    var view = App.views[name];
    view.show($('#view-' + name), opts || {});
    view._built = true; view._dirty = false; view._min = minuteKey();
  }
  App.go = function (name, opts) {
    opts = opts || {};
    if (!App.views[name]) name = 'home';
    if (App.current && App.current !== name && App.views[App.current].hide) App.views[App.current].hide();
    App.$$('.view').forEach(function (v) { v.classList.toggle('is-active', v.dataset.view === name); });
    App.$$('.rail-item').forEach(function (b) { b.classList.toggle('is-active', b.dataset.go === name); });
    App.current = name;
    var view = App.views[name];
    if (!view._built || view._dirty || opts.rerender || (view.minutely && view._min !== minuteKey())) build(name, opts);
    else if (view.resume) view.resume($('#view-' + name));
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  };
  // Build a hidden view and lay it out now (cached by content-visibility; no paint happens).
  function prebuild(name) {
    var el = $('#view-' + name), view = App.views[name];
    build(name);
    if (view.hide) view.hide();
    el.classList.add('is-warming');
    el.offsetHeight;
    el.classList.remove('is-warming');
  }
  // Pre-build (startup) and re-build (after data changes) hidden views in the background, one per
  // slot, so navigating to them never pays the rebuild cost.
  var refreshTimer = null;
  function refreshStale(delay) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function next() {
      var name = Object.keys(App.views).filter(function (k) {
        var v = App.views[k];
        return k !== App.current && (!v._built || v._dirty);
      })[0];
      if (!name) return;
      prebuild(name);
      refreshTimer = setTimeout(next, 400);
    }, delay);
  }
  function markStale() {
    Object.keys(App.views).forEach(function (k) { if (k !== App.current) App.views[k]._dirty = true; });
    refreshStale(1500);
  }
  App.on('data', markStale);
  App.on('time', markStale);
  App.rerender = function () {
    if (App.current) App.views[App.current].show($('#view-' + App.current), { rerender: true });
  };

  // ------------------------------------------------------------ toasts (single, with undo)
  var toastTimer;
  App.toast = function (html, opts) {
    opts = opts || {};
    var box = $('#toasts');
    box.innerHTML = '';
    box.classList.toggle('is-top', !!opts.top); // opts.top: show it at the top of the screen (doesn't cover the content)
    clearTimeout(toastTimer);
    var ms = opts.ms || 5000;
    var t = document.createElement('div');
    t.className = 'toast' + (opts.tone ? ' toast--' + opts.tone : '');
    t.style.setProperty('--ms', ms + 'ms');
    t.innerHTML = (opts.icon ? App.icon(opts.icon, 26) : '') + '<span class="toast-msg">' + html + '</span>' +
      (opts.undo ? '<button class="toast-undo">' + App.icon('undo', 22) + 'Undo</button>' : '');
    box.appendChild(t);
    t.classList.add('is-in');
    function kill() { t.remove(); }
    toastTimer = setTimeout(kill, ms);
    if (opts.undo) t.querySelector('.toast-undo').addEventListener('click', function () { clearTimeout(toastTimer); opts.undo(); kill(); });
  };

  // ------------------------------------------------------------ sheets (modal cards)
  App.sheet = function (html, opts) {
    opts = opts || {};
    var layer = $('#sheetLayer');
    layer.innerHTML = '<div class="sheet-scrim"></div><div class="sheet ' + (opts.cls || '') + '">' +
      '<button class="sheet-x" data-close aria-label="Close">' + App.icon('x', 28) + '</button>' + html + '</div>';
    layer.classList.add('is-open');
    function close() {
      if (!layer.classList.contains('is-open')) return;
      layer.classList.remove('is-open');
      if (opts.onClose) opts.onClose();
      layer.innerHTML = '';
    }
    App.closeSheet = close;
    layer.querySelector('.sheet-scrim').addEventListener('click', close);
    App.$$('[data-close]', layer).forEach(function (b) { b.addEventListener('click', close); });
    if (opts.onMount) opts.onMount(layer.querySelector('.sheet'), close);
    return close;
  };
  App.closeSheet = function () {};

  // Stage-local coordinates for an element's center (stage may be scaled on desktop)
  App.centerOf = function (el) {
    var stage = $('#stage').getBoundingClientRect(), r = el.getBoundingClientRect(), k = stage.width / 1280;
    return { x: (r.left + r.width / 2 - stage.left) / k, y: (r.top + r.height / 2 - stage.top) / k };
  };

  // ------------------------------------------------------------ press-and-hold
  App.hold = function (el, ms, cb) {
    var t = null;
    el.style.setProperty('--hold', ms + 'ms');
    el.addEventListener('pointerdown', function () {
      if (cb.enabled && !cb.enabled()) return;
      el.classList.add('is-holding');
      t = setTimeout(function () { t = null; el.classList.remove('is-holding'); cb.done(); }, ms);
    });
    function cancel(e) {
      if (!t) return;
      clearTimeout(t); t = null;
      el.classList.remove('is-holding');
      if (cb.cancel && e.type === 'pointerup') cb.cancel();
    }
    el.addEventListener('pointerup', cancel);
    el.addEventListener('pointerleave', cancel);
    el.addEventListener('pointercancel', cancel);
  };

  // ------------------------------------------------------------ modes: day / ambient / night
  App.setMode = function (m) {
    var stage = $('#stage');
    if (m === 'day' || m === 'ambient') App.nightBy = null; // night <-> nightdash keeps the reason it went dark
    App.mode = m;
    stage.dataset.mode = m;
    App.emit('mode', m);
  };

  // ------------------------------------------------------------ idle
  App.idle = { home: 60, ambient: 120 };
  var idleSec = 0;
  function onIdleTick() {
    idleSec++;
    var blocked = $('#takeover').classList.contains('is-open');
    if (App.mode === 'nightdash' && idleSec >= 20) { App.setMode('night'); return; }
    var cur = App.views[App.current];
    // The Flipboard stays up: no Today / slideshow, and in quiet hours it dims itself (unless its "night screen" is off)
    if (App.mode === 'day' && !blocked && cur && cur.stay && cur.stay()) return;
    if (App.mode === 'day' && !blocked && idleSec >= 30 && App.isQuiet()) { App.closeSheet(); App.go(App.homeTab || 'home'); App.setMode('night'); App.nightBy = 'quiet'; return; }
    if (App.mode !== 'day' || blocked) return;
    if (idleSec === App.idle.home && App.current !== (App.homeTab || 'home')) { App.closeSheet(); App.go(App.homeTab || 'home'); }
    if (idleSec >= App.idle.ambient) {
      App.closeSheet();
      App.go(App.homeTab || 'home');
      var dark = App.isNight();
      App.setMode(dark ? 'night' : 'ambient');
      if (dark) App.nightBy = App.isQuiet() ? 'quiet' : 'hours';
    }
  }
  // The night clock (and the night dashboard) end on their own: at the end of quiet hours, or as soon as the parent
  // clears or moves them in admin (checked every minute and on every state update, incl. SSE). Quiet-hours night ends
  // when quiet hours no longer cover now; the no-quiet-hours idle night (10 PM–6 AM) at 6 AM, or when quiet hours
  // that don't cover now get set. A night clock opened by hand (demo / keyboard 'n') isn't touched.
  App.checkNight = function () {
    if ((App.mode !== 'night' && App.mode !== 'nightdash') || !App.nightBy) return;
    if (App.nightBy === 'quiet' ? App.isQuiet() : App.isNight()) return;
    App.closeSheet(); App.go(App.homeTab || 'home'); App.setMode('day'); App.resetIdle();
  };
  App.on('minute', function () { App.checkNight(); });
  App.on('data', function () { App.checkNight(); });
  App.resetIdle = function () { idleSec = 0; };

  // ------------------------------------------------------------ stage scaling (desktop preview only)
  // Full-screen Board (html.board-full): the stage grows to the viewport's shape so the board can use all of it.
  function fit() {
    var vw = window.innerWidth, vh = window.innerHeight, s = Math.min(vw / 1280, vh / 800), st = $('#stage').style;
    if (document.documentElement.classList.contains('board-full')) {
      var w = Math.round(vw / s), h = Math.round(vh / s);
      st.width = w + 'px'; st.height = h + 'px'; st.margin = Math.round(-h / 2) + 'px 0 0 ' + Math.round(-w / 2) + 'px';
    } else { st.width = ''; st.height = ''; st.margin = ''; }
    st.transform = Math.abs(s - 1) < 0.01 ? '' : 'scale(' + s + ')';
  }
  App.fit = fit;

  // ------------------------------------------------------------ clock tick
  var lastMin = -1;
  function tick() {
    var n = App.now();
    App.emit('second', n);
    if (n.getMinutes() !== lastMin) {
      lastMin = n.getMinutes();
      $('#railClock').innerHTML = '<b>' + App.fmt.time(n, false) + '</b><span>' + App.fmt.ampm(n) + '</span>';
      App.emit('minute', n);
    }
    onIdleTick();
  }

  // ------------------------------------------------------------ boot
  App.start = function () {
    // App.setTime(15, 18); // demo default: a busy weekday afternoon
    fit();
    window.addEventListener('resize', fit);
    // Tap vs drag: a tab switches on release only if the finger moved < 10px and the rail didn't
    // scroll, so an overfull rail can be dragged. A touch scroll fires pointercancel (no switch).
    // Keyboard "clicks" (detail === 0) still work.
    var rail = $('#rail'), press = null;
    rail.addEventListener('pointerdown', function (e) {
      var b = e.target.closest('[data-go]');
      press = b && e.button === 0 ? { b: b, x: e.clientX, y: e.clientY, top: rail.scrollTop, id: e.pointerId } : null;
    });
    rail.addEventListener('pointermove', function (e) {
      if (press && press.id === e.pointerId && Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) >= 10) press = null;
    });
    rail.addEventListener('pointercancel', function () { press = null; });
    rail.addEventListener('scroll', function () { if (press && rail.scrollTop !== press.top) press = null; });
    rail.addEventListener('pointerup', function (e) {
      var p = press; press = null;
      if (!p || p.id !== e.pointerId || rail.scrollTop !== p.top) return;
      var b = e.target.closest('[data-go]');
      if (b === p.b) App.go(b.dataset.go);
    });
    $('#rail').addEventListener('click', function (e) {
      var b = e.target.closest('[data-go]');
      if (b && e.detail === 0) App.go(b.dataset.go);
    });
    document.addEventListener('pointerdown', App.resetIdle, true);
    window.addEventListener('hashchange', function () { App.go(location.hash.slice(1)); });
    App.go(location.hash.slice(1) || 'home');
    tick();
    setInterval(tick, 1000);
    App.emit('ready');
    refreshStale(1500);
    // The demo-controls tip: once per device (localStorage), at the top so it doesn't sit on the content.
    setTimeout(function () {
      try { if (localStorage.getItem('pf.tipSeen')) return; localStorage.setItem('pf.tipSeen', '1'); } catch (e) {}
      App.toast('Tip: press and hold the <b>clock</b> in the sidebar for demo controls', { ms: 6000, icon: 'bolt', top: true });
    }, 1200);
  };
  document.addEventListener('DOMContentLoaded', function () { App.start(); });
})();

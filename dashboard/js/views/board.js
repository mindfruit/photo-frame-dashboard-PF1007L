// Board: a Vestaboard-style split-flap grid. The server picks the card and lays out the grid (server/board/);
// this view only draws cells { code, fg? } and flips the ones that changed. Plain ES5-style JS for old WebViews:
// no CSS grid or custom properties (rows of inline-block cells, sizes in a generated <style>).
// Flip = CSS rotateX on two half-flaps, at most flip_cap cells at once (the rest queue), only when the
// screen's Flip setting is on and the browser can do 3D transforms; otherwise cells change instantly.
import { hintShouldShow, hintDone } from './board-hint.js';

(function () {
  'use strict';
  var D = window.DATA;
  var GLYPH = { 0: '' }, A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', P = { 37: '!', 38: '@', 39: '#', 40: '$', 41: '(', 42: ')', 44: '-', 46: '+', 47: '&', 48: '=', 49: ';', 50: ':', 52: "'", 53: '"', 54: '%', 55: ',', 56: '.', 59: '/', 60: '?', 62: '°' };
  for (var i = 0; i < 26; i++) GLYPH[i + 1] = A.charAt(i);
  for (i = 1; i <= 9; i++) GLYPH[26 + i] = String(i);
  GLYPH[36] = '0';
  for (var k in P) GLYPH[k] = P[k];

  var V = { el: null, bd: null, cols: 0, rows: 0, cells: [], want: [], shown: [], busy: [], queue: [], running: 0, p: null, css: '', size: '', stale: false, full: false };
  var CAN3D = (function () {
    try {
      if (window.CSS && CSS.supports && (CSS.supports('transform', 'rotateX(10deg)') || CSS.supports('-webkit-transform', 'rotateX(10deg)')) &&
        (CSS.supports('perspective', '100px') || CSS.supports('-webkit-perspective', '100px'))) return true;
    } catch (e) {}
    var s = document.createElement('div').style;
    try { s.transform = 'rotateX(10deg)'; s.webkitTransform = 'rotateX(10deg)'; s.perspective = '100px'; s.webkitPerspective = '100px'; } catch (e) { return false; }
    return !!((s.transform || s.webkitTransform) && (s.perspective || s.webkitPerspective));
  })();
  // Which built bundle this frame runs (dist/assets/index-<hash>.js), so the server/admin can tell if a frame has reloaded.
  var UI = (function () { var x = document.querySelector('script[src*="/assets/index-"]'); var m = x && /index-([\w-]+)\.js/.exec(x.src); return m ? m[1] : 'dev'; })();
  var CAP = { solari: 0.7109, modern: 0.70, tall: 0.81 }; // cap height / em of public/fonts/flap-*.woff2
  var sig = function (c) { return c ? c.code + ':' + (c.fg || '') : '0:'; };

  // ------------------------------------------------------------ colours + size (one generated stylesheet)
  function styleEl() {
    var s = document.getElementById('board-style');
    if (!s) { s = document.createElement('style'); s.id = 'board-style'; document.head.appendChild(s); }
    return s;
  }
  function palRules(pre, pal) {
    var r = pre + ' .bh{background:' + pal.bg + ';color:' + pal.text + '}' + // top half; the bottom half a touch darker
      pre + ' .bb{background:' + (pal.bg2 || pal.bg) + '}' + pre + ' .bc:after{background:' + (pal.hinge || '#000') + '}';
    for (var f in pal.fg) r += pre + ' .f-' + f + '{color:' + pal.fg[f] + '}';
    for (var t in pal.tile) r += pre + ' .t-' + t + '{background:' + pal.tile[t] + '}';
    return r;
  }
  function paintStyle() {
    var p = V.p, css = '';
    if (!p || !p.palettes) return;
    css += palRules('.bd', p.palettes[p.palette]);
    // night: the night dashboard, or quiet hours on a "night screen" Flipboard (html.board-night), same muted colours
    if (p.palettes.night) css += palRules('.stage[data-mode="nightdash"] .bd', p.palettes.night) + palRules('html.board-night .bd', p.palettes.night);
    if (p.palettes['night-red']) css += palRules('html[data-night="red"] .stage[data-mode="nightdash"] .bd', p.palettes['night-red']) + palRules('html.board-night[data-night="red"] .bd', p.palettes['night-red']);
    css += V.size;
    if (css !== V.css) { V.css = css; styleEl().textContent = css; }
  }
  function measure() {
    if (!V.el || !V.cols) return;
    var W = V.el.clientWidth || 1100, H = V.el.clientHeight || 800, gap = V.cols > 30 ? 3 : 5, pad = V.full ? 48 : 56;
    var w = Math.floor((W - pad - gap * (V.cols - 1)) / V.cols), h = Math.floor(w * 1.4);
    if (h * V.rows + gap * (V.rows - 1) > H - pad) { h = Math.floor((H - pad - gap * (V.rows - 1)) / V.rows); w = Math.floor(h / 1.4); }
    h -= h % 2; // even, so each half is a whole number of pixels and both halves cut the same glyph box at the same line
    // Each flap font's caps are 56% of the tile height (CAP = its cap height / em); the font files' line metrics put the caps
    // in the middle of the line box, so every letter, digit and mark sits at the same height, centred on the hinge.
    var fs = '';
    for (var f in CAP) fs += '.bd.font-' + f + ' .bc{font-size:' + Math.round(h * 0.56 / CAP[f]) + 'px}';
    V.size = fs + '.bd .bc{width:' + w + 'px;height:' + h + 'px;margin:0 ' + gap + 'px ' + gap + 'px 0}' +
      '.bd .bc:last-child{margin-right:0}.bd .bd-row:last-child .bc{margin-bottom:0}.bd .bh{height:' + (h / 2) + 'px}' +
      '.bd .g{height:' + h + 'px;line-height:' + h + 'px}.bd .bb .g{top:' + (-h / 2) + 'px}';
    paintStyle();
  }

  // ------------------------------------------------------------ cells
  function half(cls) { return '<b class="bh ' + cls + '"><b class="g"></b></b>'; }
  function build(cols, rows) {
    V.cols = cols; V.rows = rows; V.cells = []; V.want = []; V.shown = []; V.busy = []; V.queue = [];
    var html = '';
    for (var r = 0; r < rows; r++) {
      html += '<div class="bd-row">';
      for (var c = 0; c < cols; c++) html += '<i class="bc">' + half('bt') + half('bb') + '</i>';
      html += '</div>';
    }
    V.bd.innerHTML = html;
    var list = V.bd.querySelectorAll('.bc');
    for (var i = 0; i < list.length; i++) { V.cells.push(list[i]); V.want.push('0:'); V.shown.push('0:'); V.busy.push(false); }
    measure();
  }
  function setHalf(h, s) {
    var p = s.split(':'), code = +p[0], fg = p[1];
    h.className = h.className.replace(/ (t|f)-\w+/g, '') + (code >= 63 ? ' t-' + code : fg ? ' f-' + fg : '');
    h.firstChild.textContent = code >= 63 ? '' : (GLYPH[code] || '');
  }
  function setCell(i, s) { var c = V.cells[i]; setHalf(c.firstChild, s); setHalf(c.lastChild, s); V.shown[i] = s; }

  // ------------------------------------------------------------ full screen: no rail, no toasts, all black
  // On while the Board tab is showing and the screen's "Full screen" is on. A long-press shows the rail for 8 s.
  var root = document.documentElement, peekT = null;
  function setFull(on) {
    on = !!on;
    if (!on) { clearTimeout(peekT); peekT = null; root.classList.remove('board-peek'); }
    if (on === V.full) return;
    V.full = on;
    root.classList[on ? 'add' : 'remove']('board-full');
    if (App.fit) App.fit();
    measure();
  }
  function setNight(on) { root.classList[on ? 'add' : 'remove']('board-night'); }
  function wantFull() { return !!(V.el && App.current === 'board' && V.p && V.p.enabled && V.p.full !== false); }
  function peek() {
    if (!V.full) return;
    root.classList.add('board-peek');
    clearTimeout(peekT);
    peekT = setTimeout(function () { peekT = null; root.classList.remove('board-peek'); }, 8000);
  }

  function animOn() { return V.p && V.p.flip && CAN3D && App.current === 'board' && (App.mode === 'day' || App.mode === 'nightdash'); }
  function flip(i) {
    var c = V.cells[i], from = V.shown[i], to = V.want[i];
    V.busy[i] = true; V.running++;
    setHalf(c.firstChild, to); // top shows the new face behind the falling flap; bottom keeps the old one until the flap lands
    var ft = document.createElement('b'), fb = document.createElement('b');
    ft.className = 'bh bt fl ft'; ft.innerHTML = '<b class="g"></b>'; setHalf(ft, from);
    fb.className = 'bh bb fl fb'; fb.innerHTML = '<b class="g"></b>'; setHalf(fb, to);
    c.appendChild(ft); c.appendChild(fb);
    setTimeout(function () {
      setHalf(c.children[1], to); // the static bottom half
      if (ft.parentNode) c.removeChild(ft);
      if (fb.parentNode) c.removeChild(fb);
      V.shown[i] = to; V.busy[i] = false; V.running--;
      if (V.want[i] !== V.shown[i]) V.queue.push(i);
      pump();
    }, 300);
  }
  var pumpT = null;
  function pump() {
    if (pumpT) return;
    (function next() {
      pumpT = null;
      if (!animOn()) { while (V.queue.length) { var j = V.queue.shift(); if (!V.busy[j]) setCell(j, V.want[j]); } return; }
      if (V.running < (V.p.flip_cap || 8) && V.queue.length) {
        var i = V.queue.shift();
        if (!V.busy[i] && V.want[i] !== V.shown[i]) flip(i);
        pumpT = setTimeout(next, 30); // small stagger: a left-to-right ripple
      }
    })();
  }

  function paint(p) {
    V.p = p;
    var box = V.el.querySelector('.bd-wrap');
    if (!p || !p.enabled) {
      setFull(false);
      box.innerHTML = '<div class="bd-off">The Flipboard is off for this screen.<br><small>Parents: Flipboard in the admin page.</small></div>';
      V.bd = null; V.cols = 0; return;
    }
    setFull(wantFull());
    setNight(App.current === 'board' && !!p.night);
    hint();
    if (!V.bd) { box.innerHTML = '<div class="bd"></div>'; V.bd = box.firstChild; V.cols = 0; }
    if (p.cols !== V.cols || p.rows !== V.rows) build(p.cols, p.rows);
    V.bd.className = 'bd font-' + (CAP[p.font] ? p.font : 'solari') + (V.stale ? ' is-stale' : '');
    paintStyle();
    var anim = animOn();
    for (var r = 0, i = 0; r < p.rows; r++) for (var c = 0; c < p.cols; c++, i++) {
      var s = sig(p.cells[r] && p.cells[r][c]);
      V.want[i] = s;
      if (s === V.shown[i] || V.busy[i]) continue;
      if (anim) { if (V.queue.indexOf(i) < 0) V.queue.push(i); } else setCell(i, s);
    }
    if (anim) pump();
  }

  // ------------------------------------------------------------ data (the frame only talks to the local server)
  var loadT = null, inflight = false;
  function load() {
    clearTimeout(loadT); loadT = null;
    if (inflight) { loadT = setTimeout(load, 300); return; }
    inflight = true;
    fetch('/api/board?screen=' + encodeURIComponent(D.deviceId) + '&flip3d=' + (CAN3D ? 1 : 0) + '&ui=' + UI, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (p) { inflight = false; V.stale = false; if (V.el) paint(p); })
      .catch(function () { inflight = false; V.stale = true; if (V.bd) V.bd.className += ' is-stale'; }); // the last grid stays up
  }
  function soon() { if (!loadT) loadT = setTimeout(load, 150); }
  if (D.es) {
    D.es.addEventListener('change', function (e) {
      var t = ''; try { t = JSON.parse(e.data).topic; } catch (x) {}
      if ((t === 'board' || t === 'board-config') && V.el && App.current === 'board') soon();
    });
    D.es.addEventListener('hello', function () { if (V.el && App.current === 'board') soon(); });
  }
  setInterval(function () { if (V.el && App.current === 'board') load(); }, 60000); // safety net
  window.addEventListener('resize', function () { measure(); });

  // ------------------------------------------------------------ gestures (one finger only)
  // Tap: next card now (a tap on an alert dismisses it for this screen); the server debounces too, and the flips
  // still go at most flip_cap at a time. Long-press (700 ms): the menu for 8 s. Two or more fingers: nothing here,
  // so the kiosk app's two-finger 1.5 s hold works as before. Gestures off (per screen): only the long-press.
  var G = { t: null, x: 0, y: 0, ids: {}, n: 0, long: false, dead: false, last: 0 };
  function gStop() { clearTimeout(G.t); G.t = null; }
  function gDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!G.ids[e.pointerId]) { G.ids[e.pointerId] = 1; G.n++; }
    if (G.n > 1) { gStop(); G.dead = true; return; }
    G.dead = false; G.long = false; G.x = e.clientX; G.y = e.clientY;
    gStop();
    G.t = setTimeout(function () { G.t = null; G.long = true; hintGone(); peek(); }, 700);
  }
  function gMove(e) { if (G.t && Math.abs(e.clientX - G.x) + Math.abs(e.clientY - G.y) > 12) { gStop(); G.dead = true; } }
  function gUp(e) {
    if (!G.ids[e.pointerId]) return;
    delete G.ids[e.pointerId]; G.n = Math.max(0, G.n - 1);
    var pending = !!G.t;
    gStop();
    var isTap = e.type === 'pointerup' && pending && !G.dead && !G.long && G.n === 0;
    if (G.n === 0) G.dead = false;
    if (isTap) { hintGone(); tapNext(); }
  }
  function tapNext() {
    if (!V.p || !V.p.enabled || V.p.gestures === false) return;
    var now = Date.now();
    if (now - G.last < 600) return;
    G.last = now;
    fetch('/api/board/tap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ screen: D.deviceId }) })
      .then(function (r) { return r.json(); })
      .then(function (r) { G.lastAction = r && r.action; if (r && r.board && V.el && App.current === 'board') paint(r.board); })
      .catch(function () {});
  }
  function gestures(el) {
    el.addEventListener('pointerdown', gDown);
    el.addEventListener('pointermove', gMove);
    el.addEventListener('pointerup', gUp);
    el.addEventListener('pointercancel', gUp);
    el.addEventListener('touchstart', function (e) { if (e.touches && e.touches.length > 1) { gStop(); G.dead = true; } }, { passive: true });
    el.addEventListener('contextmenu', function (e) { e.preventDefault(); }); // a long-press isn't a right-click here
  }
  // First-run hint (board-hint.js): on up to 3 opens of the Flipboard on this screen, until the first tap or hold here.
  function hint() {
    if (V.hinted || !V.el || App.current !== 'board' || !V.p || !V.p.enabled) return;
    V.hinted = true;
    var txt = V.p.gestures === false ? (V.full ? 'hold for menu' : '') : (V.full ? 'tap for next \u00b7 hold for menu' : 'tap for next');
    if (!txt || !hintShouldShow(window.localStorage, D.deviceId)) return;
    var d = document.createElement('div');
    d.className = 'bd-hint'; d.textContent = txt;
    V.el.appendChild(d); V.hintEl = d;
    setTimeout(function () { if (d.parentNode) d.className += ' is-in'; }, 30);
    setTimeout(function () { hintOut(d); }, 5000);
  }
  function hintOut(d) {
    if (!d || !d.parentNode) return;
    d.className = 'bd-hint';
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 600);
  }
  function hintGone() {
    var store = null;
    try { store = window.localStorage; } catch (e) {}
    if (store) hintDone(store, D.deviceId);
    hintOut(V.hintEl); V.hintEl = null;
  }

  App.register('board', {
    show: function (el) {
      if (!V.el) { V.el = el; el.innerHTML = '<div class="bd-wrap"></div>'; gestures(el); }
      setFull(wantFull());
      measure();
      if (V.p) paint(V.p);
      load();
    },
    resume: function () { setFull(wantFull()); measure(); load(); },
    // app.js idle: the Flipboard never goes back to Today / the slideshow, and in quiet hours it stays (dimmed) unless
    // the screen's "Flipboard is the night screen" is off (then the night clock takes over as before)
    stay: function () { return !!(V.p && V.p.enabled && !(V.p.quiet && !V.p.night)); },
    hide: function () { setFull(false); setNight(false); V.hinted = false; while (V.queue.length) { var j = V.queue.shift(); if (!V.busy[j]) setCell(j, V.want[j]); } }
  });
  App.board = { can3d: CAN3D, state: V, gesture: G };
})();

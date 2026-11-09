// Photo slideshow used by the Photos view, ambient mode and the home tile.
(function () {
  'use strict';
  var D = window.DATA;

  function src(p, big) {
    var w = p.o === 'p' ? 800 : 1600, h = p.o === 'p' ? 1200 : 1000;
    if (!big) { w = Math.round(w / 2); h = Math.round(h / 2); }
    return App.img(p.seed, w, h);
  }
  App.photoSrc = src;

  // null for a missing / invalid / future date ('' or junk, or later than today, e.g. a wrong camera clock): such a photo
  // gets no date, no "x years ago" and is never "on this day". Every photo date on the frame goes through App.photoMeta.
  function parseDate(p) {
    var a = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(p.date || ''));
    var d = a && new Date(+a[1], +a[2] - 1, +a[3]);
    return d && !isNaN(d) && d.getMonth() === +a[2] - 1 && d <= App.now() ? d : null;
  }
  App.photoMeta = function (p) {
    var d = parseDate(p), now = App.now();
    if (!d) return { date: '', monthYear: '', kicker: '', onThisDay: false, place: p.place, from: App.person(p.from) };
    var years = now.getFullYear() - d.getFullYear();
    var onThisDay = years > 0 && d.getMonth() === now.getMonth() && d.getDate() === now.getDate(); // same-year photos aren't "on this day"
    var kicker = onThisDay ? years + (years === 1 ? ' year' : ' years') + ' ago today' : (years > 0 ? years + (years === 1 ? ' year ago' : ' years ago') : 'This year');
    return {
      date: App.fmt.month(d) + ' ' + d.getDate() + ', ' + d.getFullYear(),
      monthYear: App.fmt.month(d) + ' ' + d.getFullYear(),
      kicker: kicker, onThisDay: onThisDay, place: p.place, from: App.person(p.from)
    };
  };

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // Join only the parts that are there (no ", October 2023" when a photo has no place).
  function join(parts, sep) { return parts.filter(function (x) { return x != null && String(x).trim() !== ''; }).join(sep); }
  function caption(ps, size) {
    var m = App.photoMeta(ps[0]);
    return '<div class="cap cap--' + (size || 'l') + '">' +
      '<div class="cap-kicker">' + (m.onThisDay ? '<b>On this day</b> · ' : '') + join([m.kicker, App.esc(m.place || '')], ' · ') + '</div>' +
      ((ps.length > 1 ? m.monthYear : m.date) ? '<div class="cap-date serif">' + (ps.length > 1 ? m.monthYear : m.date) + '</div>' : '') +
      '</div>';
  }
  function kb(p, still) {
    var dx = (Math.random() > 0.5 ? 1 : -1) * (1 + Math.random() * 2.5) + '%';
    var dy = (Math.random() > 0.5 ? 1 : -1) * (0.5 + Math.random() * 1.5) + '%';
    return '<div class="kb' + (still ? ' kb--still' : '') + '" style="--dx:' + dx + ';--dy:' + dy + '"><img src="' + src(p, true) + '" alt=""></div>';
  }

  // Size a framed slide's photo so the whole mat (polaroid caption strip / torn bottom edge included) fits the slide
  // minus 48px, keeping the photo's aspect ratio. The mat's own size (padding + caption) is measured with the photo at 0×0.
  function fitFrame(node, p) {
    var fr = node.querySelector('.fr'), im = fr && fr.querySelector('img');
    if (!im) return;
    im.style.width = '0px'; im.style.height = '0px';
    var cw = fr.offsetWidth, ch = fr.offsetHeight;
    var W = node.clientWidth - 48 - cw, H = node.clientHeight - 48 - ch;
    var nw = im.naturalWidth || (p.o === 'p' ? 3 : 4), nh = im.naturalHeight || (p.o === 'p' ? 4 : 3);
    var k = Math.min(W / nw, H / nh, im.naturalWidth ? 2 : Infinity); // never blow a small picture up past 2× (the mat shrinks round it)
    im.style.width = Math.max(1, Math.floor(nw * k)) + 'px';
    im.style.height = Math.max(1, Math.floor(nh * k)) + 'px';
    fr.classList.add('is-fit');
  }

  // Small pictures (e.g. 40×40): at most 2× their real size, centred in their box, instead of stretched to fill it.
  function capUp(im) {
    var nw = im.naturalWidth, nh = im.naturalHeight, box = im.parentNode;
    if (!nw || !nh || !box || im.classList.contains('blurfill') || (im.closest && im.closest('.fr'))) return;
    var bw = box.clientWidth, bh = box.clientHeight;
    if (!bw || !bh) return;
    var used = im.classList.contains('fitimg') ? bh / nh : Math.max(bw / nw, bh / nh); // fitimg: height 100%; others: cover
    if (used <= 2) return;
    var k = Math.min(2, bw / nw, bh / nh), w = Math.round(nw * k), h = Math.round(nh * k);
    im.classList.add('is-small');
    im.style.width = w + 'px'; im.style.height = h + 'px';
    im.style.marginLeft = -Math.round(w / 2) + 'px'; im.style.marginTop = -Math.round(h / 2) + 'px';
  }

  var BUILD = {
    cover: function (ps, o) {
      var p = ps[0];
      if (p.o === 'p') {
        return '<div class="slide slide--fit"><img class="blurfill" src="' + src(p) + '" alt=""><img class="fitimg" src="' + src(p, true) + '" alt="">' + (o.captions ? caption(ps) : '') + '</div>';
      }
      return '<div class="slide slide--cover">' + kb(p) + (o.captions ? caption(ps) : '') + '</div>';
    },
    pair: function (ps, o) {
      return '<div class="slide slide--pair"><div class="pane">' + kb(ps[0], true) + '</div><div class="pane">' + kb(ps[1], true) + '</div>' + (o.captions ? caption(ps, 'm') : '') + '</div>';
    },
    collage: function (ps, o) {
      return '<div class="slide slide--collage"><div class="pane pane--a">' + kb(ps[0], true) + '</div><div class="pane pane--b">' + kb(ps[1], true) + '</div><div class="pane pane--c">' + kb(ps[2], true) + '</div>' + (o.captions ? caption(ps, 'm') : '') + '</div>';
    },
    polaroid: function (ps) {
      var p = ps[0], m = App.photoMeta(p), rot = (Math.random() * 5 - 2.5).toFixed(1);
      return '<div class="slide slide--polaroid"><img class="blurfill" src="' + src(p) + '" alt="">' +
        '<figure class="polaroid polaroid--' + p.o + '" style="transform:rotate(' + rot + 'deg)"><div class="polaroid-img"><img src="' + src(p, true) + '" alt=""></div>' +
        '<figcaption class="serif"><i>' + App.esc(join([m.place, m.monthYear], ', ')) + '</i></figcaption></figure></div>';
    },
    // One photo in its source's frame style (admin Photos › Frame styles): 'polaroid' or 'torn' paper mat.
    // Static: the tilt is a fixed rotate(), the torn edge a mask on the mat's ::before (not on the photo); no new animation.
    framed: function (ps, o) {
      var p = ps[0], m = App.photoMeta(p), torn = p.frame === 'torn';
      var label = p.place || p.album || m.monthYear;
      var cap = torn ? (o.captions && label) : label; // polaroids always carry their name; torn mats only where captions show
      var tilt = (Math.random() > 0.5 ? 1 : -1) * (torn ? 1 : 1.5);
      return '<div class="slide slide--framed"><div class="fr fr--' + (torn ? 'torn' : 'polaroid') + ' fr--' + p.o + (torn ? ' fr--t' + (1 + Math.floor(Math.random() * 3)) : '') + (cap ? ' fr--cap' : '') + '"' +
        ' style="transform:rotate(' + tilt + 'deg)' + (torn ? ';--mat:' + App.esc(p.mat || '#F7CF4D') : '') + '"><img src="' + src(p, true) + '" alt="">' +
        (cap ? '<div class="fr-cap">' + App.esc(cap) + '</div>' : '') + '</div></div>';
    }
  };

  App.Slideshow = function (el, opts) {
    this.el = el;
    this.o = Object.assign({ layout: 'auto', interval: 15000, captions: true }, opts || {});
    this.queue = [];
    this.history = [];
    this.count = 0;
    // The frame starts on demo pictures before /api/state arrives. When the real photo list lands,
    // drop the demo queue and show a real (on-this-day first) photo right away.
    var self = this;
    App.on('data', function () {
      if (self.src !== D.photos) { self.queue = []; self.history = []; if (self.wanted) self.next(); else self.current = null; } // paused: start() shows the new list
      else if (self.current && D.photos.length && self.o.onChange) self.o.onChange(self.current); // same pictures, maybe new album labels
      if (!D.photos.length) self.clear(); // every source turned off: blank now, even while paused
    });
    this.timer = null;
    this.current = null;
  };
  var S = App.Slideshow.prototype;

  S.refill = function () {
    var q = [];
    this.src = D.photos;
    D.photos.forEach(function (p) { q.push(p); if (p.fav) q.push(p); });
    // On-this-day photos always come first in a fresh cycle
    shuffle(q).sort(function (a, b) { return (App.photoMeta(b).onThisDay ? 1 : 0) - (App.photoMeta(a).onThisDay ? 1 : 0); });
    this.queue = q;
    this.pairs = {}; // pairs shown this cycle (see pick)
  };
  // from what's left of this cycle only (no refill); null when nothing there matches
  S.fromQueue = function (pred) {
    if (this.src !== D.photos) return null;
    for (var i = 0; i < this.queue.length; i++) if (pred(this.queue[i])) return this.queue.splice(i, 1)[0];
    return null;
  };
  S.take = function (pred) {
    if (!this.queue.length || this.src !== D.photos) this.refill();
    for (var i = 0; i < this.queue.length; i++) if (!pred || pred(this.queue[i])) return this.queue.splice(i, 1)[0];
    return null;
  };
  S.pick = function () {
    var layout = this.o.layout === 'polaroid' ? 'auto' : this.o.layout, n = this.count++; // 'polaroid' mode was dropped
    var first = this.take();
    if (!first) return null;
    // A photo whose source has a polaroid / torn-paper frame style shows alone in that frame (auto / cover slides only;
    // an explicitly picked layout wins). frames: false (the small Today tile) keeps the plain look.
    if (this.o.frames !== false && (layout === 'auto' || layout === 'cover') && (first.frame === 'polaroid' || first.frame === 'torn')) return { layout: 'framed', photos: [first] };
    var self = this, frames = this.o.frames !== false;
    function sibling(pred) { // collage: the rest of this cycle first, then any other photo at random
      var any = D.photos.filter(function (x) { return x !== first && pred(x); });
      return self.fromQueue(pred) || any[Math.floor(Math.random() * any.length)];
    }
    function key(p) { return String(p.id != null ? p.id : p.file); }
    function pairKey(a, b) { return [key(a), key(b)].sort().join('|'); }
    // portraits pair within their source (album / uploads / picker); the server's tag is unique per photo
    function grp(p) { return p.src || p.tag; }
    // one photo on its own: its frame style when it has one, else cover (portraits show as a fitted cover)
    function single(p) { return frames && (p.frame === 'polaroid' || p.frame === 'torn') ? 'framed' : 'cover'; }
    if (layout === 'auto' && D.photos.length === 1) layout = single(first); // one photo: cover (or its source's frame), not a polaroid every few turns
    if (layout === 'auto') {
      // a source set to Plain (admin Photos › Frame styles) never gets the polaroid look; Auto on a Default screen still mixes
      var mat = first.style === 'plain' ? 'cover' : 'polaroid';
      if (first.o === 'p') layout = D.photos.some(function (x) { return x !== first && x.o === 'p' && grp(x) === grp(first); }) ? 'pair' : mat;
      else layout = n % 5 === 3 ? 'collage' : n % 5 === 4 ? mat : 'cover';
    }
    var ps = [first];
    if (layout === 'pair') { // no second portrait (e.g. only one in the library): show it alone instead
      // Partners come from this cycle's queue (and leave it), so each portrait pairs once per cycle. When the queue
      // has no portrait left: a random portrait that makes a pair not yet shown this cycle and isn't in the last pair,
      // else the photo shows on its own. (It used to fall back to the first portraits in the library: the same pair
      // over and over until the cycle refilled.)
      if (first.o !== 'p') first = this.fromQueue(function (x) { return x.o === 'p'; }) || first; // a Pair screen: a landscape shows alone once the cycle's portraits are used up
      var last = this.lastPair || [], seen = this.pairs || {}, lastKey = last.length === 2 ? pairKey(last[0], last[1]) : '';
      var prevKey = this.prevPair || '';
      // from the queue: not the last pair shown (e.g. across a refill); if that's the only partner left, still fine
      // unless that pair was the slide right before
      var ok = function (x) { return x !== first && x.o === 'p' && pairKey(first, x) !== lastKey && !seen[pairKey(first, x)]; }; // favourites are queued twice: no pair twice a cycle
      var mate = first.o === 'p' && (this.fromQueue(function (x) { return ok(x) && grp(x) === grp(first); }) || this.fromQueue(ok) ||
        this.fromQueue(function (x) { return x !== first && x.o === 'p' && pairKey(first, x) !== prevKey && !seen[pairKey(first, x)]; }));
      if (first.o === 'p' && !mate) {
        var pool = D.photos.filter(function (x) { return x !== first && x.o === 'p' && last.indexOf(x) < 0 && !seen[pairKey(first, x)]; });
        var same = pool.filter(function (x) { return grp(x) === grp(first); });
        if (same.length) pool = same;
        mate = pool[Math.floor(Math.random() * pool.length)] || null;
      }
      ps = mate ? [first, mate] : [first];
      if (mate) { this.lastPair = ps.slice(); this.pairs = seen; seen[pairKey(first, mate)] = 1; }
      else layout = single(first);
    }
    this.prevPair = layout === 'pair' ? pairKey(ps[0], ps[1]) : '';
    if (layout === 'collage') {
      ps.push(sibling(function (x) { return x !== first; }));
      ps.push(sibling(function (x) { return ps.indexOf(x) < 0; }));
      if (!ps[1] || !ps[2]) { ps = [first]; layout = single(first); } // fewer than 3 photos
    }
    return { layout: layout, photos: ps };
  };

  S.render = function (slide) {
    var self = this;
    var html = BUILD[slide.layout](slide.photos, this.o); // throws on a bad slide: next() skips it, nothing on screen changes
    this.current = slide;
    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    var node = wrap.firstChild;
    node.style.opacity = '0';
    // Fallback look if images can't load (offline)
    Array.prototype.forEach.call(node.querySelectorAll('img'), function (im) {
      im.addEventListener('error', function () { im.classList.add('is-broken'); });
      if (im.complete) setTimeout(function () { capUp(im); }); else im.addEventListener('load', function () { capUp(im); });
    });
    var old = Array.prototype.slice.call(this.el.children);
    this.el.appendChild(node);
    if (slide.layout === 'framed') {
      var fim = node.querySelector('.fr img'), fit = function () { fitFrame(node, slide.photos[0]); };
      fit(); // orientation guess first, the real aspect once the photo has loaded
      if (fim && !fim.complete) { fim.addEventListener('load', fit); fim.addEventListener('error', fit); }
    }
    var first = node.querySelector('img:not(.blurfill)');
    var shown = false;
    function show() {
      if (shown) return; shown = true;
      node.classList.add('is-in');
      node.style.opacity = '';
      old.forEach(function (o) { o.remove(); });
    }
    if (first && !first.complete) { first.addEventListener('load', show); first.addEventListener('error', show); setTimeout(show, 2500); }
    else show();
    if (this.o.onChange) this.o.onChange(slide);
  };

  S.next = function () {
    // a slide that fails to build is skipped (up to 3 tries); the timer always restarts, so the show keeps going
    for (var i = 0; i < 3; i++) {
      var prev = this.current, s = null;
      try { // pick() can refill the cycle (photo dates are read there); a throw there is skipped like a bad slide
        s = this.pick();
        if (!s) { if (!D.photos.length) this.clear(); break; }
        this.render(s); if (prev) this.history.push(prev); break;
      } catch (e) { if (window.console) console.warn('[slideshow] skipped a slide:', e && e.message); }
    }
    if (D.photos.length) this.restart();
  };
  S.clear = function () {
    var had = this.current || (this.el.children.length && !this.el.querySelector('.ss-empty'));
    this.current = null; this.history = [];
    // no photos (none yet, or every source off for this screen): a quiet note instead of demo pictures (the frame is local-only)
    this.el.innerHTML = '<div class="ss-empty"><b>No photos yet</b><span>Add photos in the admin</span></div>';
    if (had && this.o.onChange) this.o.onChange(null);
  };
  S.prev = function () {
    if (!this.history.length) return;
    try { this.render(this.history.pop()); } catch (e) { if (window.console) console.warn('[slideshow] skipped a slide:', e && e.message); }
    this.restart();
  };
  S.setLayout = function (l) { this.o.layout = l; this.next(); };
  S.restart = function () {
    var self = this;
    clearInterval(this.timer);
    this.timer = setInterval(function () { self.next(); }, this.o.interval);
  };
  S.start = function () { this.wanted = true; if (!this.current) this.next(); else this.restart(); };
  S.stop = function () { this.wanted = false; clearInterval(this.timer); this.timer = null; };
})();

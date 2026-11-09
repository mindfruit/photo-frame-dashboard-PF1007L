// Per-person tabs ("Maya", …): a big-button, kid-friendly page made of the widgets a parent
// ticked for that person in /admin. Tabs appear/disappear live as the settings change.
// Also hides the Home tab when no Home Assistant devices are enabled.
(function () {
  'use strict';
  var D = window.DATA;
  var DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  var startHash = location.hash.slice(1); // person tabs exist only once data loads; reopen the one in the URL

  function me(id) { return D.people.filter(function (p) { return p.id === id; })[0]; }
  function has(p, w) { return p.widgets.indexOf(w) > -1; }
  function hm(s) { var x = (s || '').split(':'); return x.length === 2 ? +x[0] * 60 + +x[1] : null; }
  function fmtHM(s) { var m = hm(s); return m == null ? '' : App.fmt.time(new Date(2000, 0, 1, Math.floor(m / 60), m % 60)); }

  // ---------------------------------------------------------------- widgets
  function wChores(p) {
    var r = App.currentRoutine();
    var list = D.chores.filter(function (c) { return c.who === p.id && c.r === r.id; });
    var done = list.filter(function (c) { return c.done; }).length;
    return '<section class="pv-card pv-chores"><div class="pv-h"><span class="label">' + App.esc(r.name) + ' jobs</span><b class="num">' + done + ' / ' + list.length + '</b></div>' +
      (list.length ? '<div class="pv-chore-list">' + list.map(function (c) {
        return '<button class="pv-chore' + (c.done ? ' is-done' : '') + (c.done && c.pending ? ' is-pending' : '') + '" data-pchore="' + c.id + '">' +
          '<span class="pv-emoji">' + App.esc(c.emoji || '⭐') + '</span><span class="pv-chore-t">' + App.esc(c.title) + '</span>' +
          (c.stars ? '<span class="pv-chore-s">' + App.icon('star', 20, 'i--fill') + c.stars + '</span>' : '') +
          '<span class="pv-tick">' + (c.done ? (c.pending ? '⏳' : '✓') : '') + '</span></button>';
      }).join('') + '</div>' : '<p class="pv-empty serif"><i>Nothing to do right now!</i></p>') +
      (list.length && done === list.length ? '<div class="pv-yay serif">All done<i>!</i> 🎉</div>' : '') + '</section>';
  }
  function wStars(p) {
    var bal = D.stars[p.id] || 0, pend = D.pendingStars[p.id] || 0, w = D.week[p.id] || [];
    var today = (App.now().getDay() + 6) % 7;
    return '<section class="pv-card pv-stars"><span class="label">My stars</span>' +
      '<div class="pv-bigstar">' + App.icon('star', 64, 'i--fill') + '<b class="num">' + bal + '</b></div>' +
      (pend ? '<div class="pv-pend">+' + pend + ' waiting for OK</div>' : '') +
      '<div class="pv-week">' + DAYS.map(function (d, i) {
        var cls = i > today ? 'is-future' : w[i] ? 'is-hit' : i === today ? 'is-today' : 'is-miss';
        return '<span class="' + cls + '"><i>' + (w[i] ? '★' : '') + '</i>' + d + '</span>';
      }).join('') + '</div></section>';
  }
  function wRewards(p) {
    var bal = D.stars[p.id] || 0;
    var asked = D.rewardRequests.filter(function (r) { return r.person_id === p.id; });
    return '<section class="pv-card pv-rewards"><span class="label">Rewards</span>' +
      (D.rewards.length ? '<div class="pv-reward-list">' + D.rewards.map(function (r) {
        var pct = Math.min(100, Math.round(bal / r.cost * 100)), wait = asked.some(function (a) { return a.reward_id === r.id; });
        return '<button class="pv-reward' + (bal >= r.cost ? ' is-ready' : '') + (wait ? ' is-pending' : '') + '" data-reward="' + r.id + '">' +
          '<span class="pv-emoji">' + App.esc(r.emoji) + '</span><span class="pv-reward-t">' + App.esc(r.title) + '<small>' +
          (wait ? 'Asked! Waiting for OK' : bal >= r.cost ? 'You can get this!' : (r.cost - bal) + ' more ★') + '</small></span>' +
          '<span class="pv-bar"><i style="width:' + pct + '%"></i></span><span class="pv-cost">' + r.cost + '★</span></button>';
      }).join('') + '</div>' : '<p class="pv-empty serif"><i>No rewards yet</i></p>') + '</section>';
  }
  function wCountdowns(p) {
    var list = D.countdowns.filter(function (c) { return c.who === p.id || c.who === 'family'; }).slice(0, 4);
    return '<section class="pv-card pv-count"><span class="label">Coming up</span>' + (list.length ? list.map(function (c) {
      return '<div class="pv-count-row"><span class="pv-emoji">' + App.esc(c.emoji) + '</span><span class="pv-count-t">' + App.esc(c.title) + '</span>' +
        '<b class="num">' + (c.days === 0 ? 'Today!' : c.days) + '</b>' + (c.days ? '<small>' + (c.days === 1 ? 'sleep' : 'sleeps') + '</small>' : '') + '</div>';
    }).join('') : '<p class="pv-empty serif"><i>Nothing counting down</i></p>') + '</section>';
  }
  function wToday(p) {
    var n = App.now();
    var list = App.events().filter(function (e) { return App.sameDay(e.start, n) && e.people.indexOf(p.id) > -1; })
      .sort(function (a, b) { return a.start - b.start; });
    return '<section class="pv-card pv-today"><span class="label">Today</span>' + (list.length ? list.slice(0, 5).map(function (e) {
      var past = !e.allDay && e.end < n;
      return '<div class="pv-ev' + (past ? ' is-past' : '') + '"><b>' + (e.allDay ? 'All day' : App.fmt.time(e.start)) + '</b><span>' + App.esc(e.title) + '</span></div>';
    }).join('') : '<p class="pv-empty serif"><i>A free day!</i></p>') + '</section>';
  }
  function wWeather() {
    var w = App.weatherNow();
    return '<section class="pv-card pv-wx"><span class="label">Outside</span><div class="pv-wx-main">' + App.icon(w.cond || 'cloud', 64) +
      '<b class="num">' + w.temp + '°</b></div><div class="pv-wear">' + App.esc(w.advice) + '</div></section>';
  }
  function wSleep(p) {
    var bed = hm(p.bedtime), wake = hm(p.wake);
    if (bed == null && wake == null) return '<section class="pv-card pv-sleep"><span class="label">Sleep</span><p class="pv-empty serif"><i>Bedtime not set</i></p></section>';
    var n = App.now(), m = n.getHours() * 60 + n.getMinutes();
    var asleep = bed != null && wake != null && (bed > wake ? (m >= bed || m < wake) : (m >= bed && m < wake));
    var soon = !asleep && bed != null && bed - m > 0 && bed - m <= 30;
    return '<section class="pv-card pv-sleep' + (asleep ? ' is-night' : ' is-day') + '"><span class="label">' + (asleep ? 'Not time to get up yet' : 'OK to wake!') + '</span>' +
      '<div class="pv-sleep-main">' + (asleep ? '🌙' : soon ? '🪥' : '☀️') + '<b>' + (asleep ? 'Sleepy time' : soon ? 'Bedtime soon' : 'Awake') + '</b></div>' +
      '<small>' + (asleep ? (wake != null ? 'Wake up at ' + fmtHM(p.wake) : '') : (bed != null ? 'Bedtime ' + fmtHM(p.bedtime) : '')) + '</small></section>';
  }

  // Feelings check-in
  var FEEL = [['happy', '😀', 'Happy'], ['sad', '😢', 'Sad'], ['mad', '😠', 'Mad'], ['tired', '😴', 'Tired'], ['silly', '🤪', 'Silly']];
  function wFeelings(p) {
    return '<section class="pv-card pv-feel"><span class="label">How do you feel?</span><div class="pv-faces">' + FEEL.map(function (f) {
      return '<button class="pv-face' + (p.feeling === f[0] ? ' is-on' : '') + '" data-feel="' + f[0] + '"><span>' + f[1] + '</span><small>' + f[2] + '</small></button>';
    }).join('') + '</div></section>';
  }
  // Star jar toward a reward the kid picked
  function wJar(p) {
    var bal = D.stars[p.id] || 0;
    var goal = D.rewards.filter(function (r) { return r.id === p.goalRewardId; })[0];
    if (!goal || p._pickGoal) {
      return '<section class="pv-card pv-jar"><span class="label">Pick what to save for</span>' + (D.rewards.length ? '<div class="pv-goals">' + D.rewards.map(function (r) {
        return '<button class="pv-goal" data-goal="' + r.id + '"><span>' + App.esc(r.emoji) + '</span><small>' + App.esc(r.title) + '</small></button>';
      }).join('') + '</div>' : '<p class="pv-empty serif"><i>No rewards yet</i></p>') + '</section>';
    }
    var pct = Math.min(100, Math.round(bal / goal.cost * 100)), full = bal >= goal.cost;
    return '<section class="pv-card pv-jar' + (full ? ' is-full' : '') + '"><div class="pv-h"><span class="label">Star jar</span><button class="pv-link" data-repick>change</button></div>' +
      '<div class="pv-jar-row"><div class="jar"><div class="jar-fill" style="height:' + pct + '%"></div><div class="jar-stars">' + Array(Math.min(bal, 30) + 1).join('★') + '</div></div>' +
      '<div class="pv-jar-goal"><span class="pv-jar-emoji">' + App.esc(goal.emoji) + '</span><b>' + App.esc(goal.title) + '</b><small>' + bal + ' / ' + goal.cost + ' ★</small>' +
      (full ? '<button class="btn btn--solid pv-jar-get" data-reward="' + goal.id + '">🎉 Full! Get it</button>' : '') + '</div></div></section>';
  }
  // Today in pictures: events + chores on one emoji timeline
  function pic(title, fallback) {
    var t = String(title).toLowerCase();
    for (var i = 0; i < D.icons.length; i++) if (t.indexOf(D.icons[i][0]) > -1) return D.icons[i][1];
    return fallback;
  }
  function wPictures(p) {
    var n = App.now(), items = [];
    App.events().forEach(function (e) {
      if (!App.sameDay(e.start, n) || e.people.indexOf(p.id) < 0) return;
      items.push({ at: e.allDay ? -1 : e.start.getHours() * 60 + e.start.getMinutes(), emoji: pic(e.title, '📅'), label: e.allDay ? 'All day' : App.fmt.hour(e.start), title: e.title, past: !e.allDay && e.end < n });
    });
    D.chores.forEach(function (c) {
      if (c.who !== p.id) return;
      var r = D.routines.filter(function (x) { return x.id === c.r; })[0];
      items.push({ at: (r ? r.from : 0) * 60 + 1, emoji: c.emoji || pic(c.title, '⭐'), label: r ? r.name : '', title: c.title, past: c.done, done: c.done });
    });
    items.sort(function (a, b) { return a.at - b.at; });
    return '<section class="pv-card pv-pics"><span class="label">My day</span>' + (items.length ? '<div class="pv-timeline">' + items.map(function (x) {
      return '<div class="pv-pic' + (x.past ? ' is-past' : '') + '"><span class="pv-pic-e">' + App.esc(x.emoji) + (x.done ? '<i>✓</i>' : '') + '</span><small>' + App.esc(x.label) + '</small><b>' + App.esc(x.title) + '</b></div>';
    }).join('') + '</div>' : '<p class="pv-empty serif"><i>Nothing planned</i></p>') + '</section>';
  }
  // Notes from parents
  function wNotes(p) {
    var list = D.notes.filter(function (x) { return x.person_id === p.id; }).slice(0, 3);
    return '<section class="pv-card pv-notes"><span class="label">Notes for you</span>' + (list.length ? list.map(function (x) {
      return '<div class="pv-note">' + (x.photo ? '<img src="' + x.photo + '" alt="">' : '') + '<div class="pv-note-t">' + (x.emoji ? '<span class="pv-note-e">' + App.esc(x.emoji) + '</span>' : '') + App.esc(x.text) + '</div>' +
        '<button class="pv-heart' + (x.hearted ? ' is-on' : '') + '" data-heart="' + x.id + '">' + (x.hearted ? '❤️' : '🤍') + '</button></div>';
    }).join('') : '<p class="pv-empty serif"><i>No notes yet</i></p>') + '</section>';
  }
  // Learning corner: letter / number / shape of the day
  function wLearning() {
    if (!D.learning) return '';
    var parts = D.learning.split(' '), big = parts.shift();
    return '<section class="pv-card pv-learn"><span class="label">Today’s ' + (/^\d+$/.test(big) ? 'number' : /^[A-Za-z]$/.test(big) ? 'letter' : 'shape') + '</span>' +
      '<div class="pv-learn-big">' + App.esc(big) + '</div><div class="pv-learn-sub">' + App.esc(parts.join(' ')) + '</div></section>';
  }
  // Family scoreboard
  function wFamily() {
    var f = D.family, pct = f.goal ? Math.min(100, Math.round(f.stars / f.goal * 100)) : 0;
    return '<section class="pv-card pv-fam"><span class="label">Family stars this week</span>' +
      '<div class="pv-fam-row"><span class="pv-fam-e">' + App.esc(f.emoji || '🏆') + '</span><b class="num">' + f.stars + (f.goal ? '<small> / ' + f.goal + '</small>' : '') + '</b></div>' +
      (f.goal ? '<div class="pv-bar pv-bar--big"><i style="width:' + pct + '%"></i></div><div class="pv-fam-t">' + (pct >= 100 ? '🎉 We did it! ' : 'Together for: ') + App.esc(f.title) + '</div>' : '') + '</section>';
  }

  // Weather dress-up: pick outfit pieces from the next 12 hours (°F; °C converted)
  function wDress() {
    var W = D.weather, h = App.now().getHours(), temps = [], rain = 0;
    for (var i = h; i < Math.min(24, h + 12); i++) { if (typeof W.t[i] === 'number') temps.push(W.t[i]); rain = Math.max(rain, W.p[i] || 0); }
    if (!temps.length) return '<section class="pv-card pv-dress"><span class="label">What to wear</span><p class="pv-empty serif"><i>No weather yet</i></p></section>';
    var toF = function (t) { return W.unit === 'C' ? t * 9 / 5 + 32 : t; };
    var lo = toF(Math.min.apply(null, temps)), hi = toF(Math.max.apply(null, temps));
    var hat = hi >= 85 ? '🧢' : lo < 45 ? '🧶' : '', top = lo < 50 ? '🧥' : lo < 65 ? '🧥' : '👕', bottom = hi >= 75 ? '🩳' : '👖';
    var feet = rain >= 50 ? '🥾' : '👟', extras = [];
    if (lo < 40) extras.push('🧤', '🧣');
    if (rain >= 50) extras.push('☂️');
    if (hi >= 85) extras.push('🕶️', '🧴');
    var say = rain >= 50 ? 'Rain boots and umbrella!' : lo < 50 ? 'Warm coat today!' : lo < 65 ? 'Bring a jacket' : hi >= 85 ? 'Hot! Shorts and a hat' : 'T-shirt weather';
    return '<section class="pv-card pv-dress"><span class="label">What to wear</span><div class="pv-dress-row"><div class="kid">' +
      '<span class="kid-hat">' + hat + '</span><span class="kid-head">🙂</span><span class="kid-top">' + top + '</span><span class="kid-bottom">' + bottom + '</span><span class="kid-feet">' + feet + feet + '</span></div>' +
      '<div class="pv-dress-side"><b>' + App.esc(say) + '</b><div class="pv-extras">' + extras.join(' ') + '</div><small>' + Math.round(lo) + '° – ' + Math.round(hi) + '°F' + (rain ? ' · ' + rain + '% rain' : '') + '</small></div></div></section>';
  }

  var WIDGETS = { dress: wDress, feelings: wFeelings, jar: wJar, pictures: wPictures, notes: wNotes, learning: wLearning, family: wFamily, chores: wChores, stars: wStars, rewards: wRewards, countdowns: wCountdowns, today: wToday, weather: wWeather, sleep: wSleep };

  function render(el, id) {
    var p = me(id);
    if (!p) { el.innerHTML = ''; return; }
    var cards = p.widgets.filter(function (w) { return WIDGETS[w]; }).map(function (w) { return WIDGETS[w](p); }).join('');
    el.innerHTML = '<div class="pv" style="' + App.pstyle(p) + '"><header class="pv-top">' + App.avatar(p, 72) +
      '<h1 class="serif">Hi, ' + App.esc(p.name) + '<i>!</i></h1>' +
      (D.stars[p.id] != null && !has(p, 'stars') ? '<span class="pv-mini">' + App.icon('star', 28, 'i--fill') + '<b class="num">' + D.stars[p.id] + '</b></span>' : '') +
      '</header><div class="pv-grid">' + (cards || '<p class="pv-empty serif"><i>A parent can pick what shows here in the parent page.</i></p>') + '</div></div>';
  }

  // ---------------------------------------------------------------- taps
  function onClick(id, e) {
    var p = me(id), t;
    if (!p) return;
    if ((t = e.target.closest('[data-pchore]'))) {
      var c = D.chores.filter(function (x) { return x.id === t.dataset.pchore; })[0];
      if (!c) return;
      if (c.done && !c.pending && c.stars && p.approval) return App.toast('Already OK’d — ask a grown-up to undo', { icon: 'star' });
      if (c.done) {
        c.done = false; c.pending = false;
        D.api('DELETE', 'chores/' + c.id + '/complete').catch(function (err) { App.toast(App.esc(err.message), { tone: 'error' }); D.reload(); });
      } else {
        c.done = true; c.pending = !!(c.stars && p.approval);
        App.sound(D.chores.filter(function (x) { return x.who === p.id && x.r === c.r; }).every(function (x) { return x.done; }) ? 'cheer' : 'ding');
        D.api('POST', 'chores/' + c.id + '/complete', {}).catch(function () { App.toast('Could not save', { tone: 'error' }); D.reload(); });
        App.toast('<b>' + App.esc(c.title) + '</b> done!' + (c.stars ? ' +' + c.stars + '★' + (c.pending ? ' when a grown-up says OK' : '') : ''), { icon: 'star', ms: 3000 });
      }
      return App.rerender();
    }
    if ((t = e.target.closest('[data-feel]'))) {
      p.feeling = t.dataset.feel; App.sound('pop'); App.rerender();
      return D.api('POST', 'feelings', { person_id: p.id, feeling: t.dataset.feel }).then(function () { App.toast('Thanks for telling us 💛', { icon: 'heart', ms: 2500 }); });
    }
    if (e.target.closest('[data-repick]')) { p._pickGoal = true; return App.rerender(); }
    if ((t = e.target.closest('[data-goal]'))) {
      p._pickGoal = false; p.goalRewardId = t.dataset.goal; App.rerender();
      return D.api('POST', 'people/' + p.id + '/goal', { reward_id: t.dataset.goal });
    }
    if ((t = e.target.closest('[data-heart]'))) {
      var nt = D.notes.filter(function (x) { return x.id === t.dataset.heart; })[0];
      if (nt && !nt.hearted) { nt.hearted = true; App.sound('pop'); App.rerender(); D.api('POST', 'notes/' + nt.id + '/heart'); }
      return;
    }
    if ((t = e.target.closest('[data-reward]'))) {
      var r = D.rewards.filter(function (x) { return x.id === t.dataset.reward; })[0], bal = D.stars[p.id] || 0;
      if (!r) return;
      if (bal < r.cost) return App.toast('You need <b>' + (r.cost - bal) + ' more ★</b> for ' + App.esc(r.title), { icon: 'star', ms: 3000 });
      App.sheet('<div class="sheet-pad pv-confirm"><div class="pv-confirm-emoji">' + App.esc(r.emoji) + '</div><h2 class="serif sheet-h">Get ' + App.esc(r.title) + '?</h2>' +
        '<p class="sheet-p">It costs ' + r.cost + ' of your ' + bal + ' stars.</p><div class="sheet-actions"><button class="btn" data-close>Not now</button><button class="btn btn--solid" data-yes>Yes please!</button></div></div>', {
        onMount: function (s, close) {
          s.querySelector('[data-yes]').onclick = function () {
            close();
            D.api('POST', 'rewards/' + r.id + '/request', { person_id: p.id }).then(function (res) {
              App.sound('cheer');
              App.toast(res.status === 'requested' ? 'Asked for <b>' + App.esc(r.title) + '</b> — waiting for a grown-up' : 'Yay! <b>' + App.esc(r.title) + '</b> 🎉', { icon: 'star', ms: 4000 });
            }).catch(function (err) { App.toast(App.esc(err.message), { tone: 'error' }); });
          };
        }
      });
    }
  }

  // ---------------------------------------------------------------- tabs
  var views = {};
  function sync() {
    var rail = App.$('#rail'), main = App.$('.views'), before = rail.querySelector('[data-go="control"]');
    var want = D.people.filter(function (p) { return p.showTab; });
    var ids = want.map(function (p) { return p.id; });
    Object.keys(views).forEach(function (id) {
      if (ids.indexOf(id) > -1) return;
      views[id].btn.remove(); views[id].sec.remove();
      delete App.views['person-' + id]; delete views[id];
      if (App.current === 'person-' + id) App.go('home');
    });
    want.forEach(function (p) {
      var v = views[p.id];
      if (!v) {
        var name = 'person-' + p.id;
        var btn = document.createElement('button');
        btn.className = 'rail-item rail-person'; btn.dataset.go = name;
        var sec = document.createElement('section');
        sec.className = 'view'; sec.id = 'view-' + name; sec.dataset.view = name;
        sec.addEventListener('click', function (e) { onClick(p.id, e); });
        rail.insertBefore(btn, before); main.appendChild(sec);
        v = views[p.id] = { btn: btn, sec: sec };
        App.register(name, { minutely: true, show: function (el) { render(el, p.id); } });
        if (startHash === name) { startHash = ''; App.go(name); }
      }
      v.btn.innerHTML = App.avatar(p, 30) + '<span>' + App.esc(p.name) + '</span>';
      v.btn.classList.toggle('is-active', App.current === 'person-' + p.id);
    });
    var home = rail.querySelector('[data-go="control"]');
    if (home) home.style.display = D.homeEnabled ? '' : 'none';
    if (!D.homeEnabled && App.current === 'control' && D.loaded) App.go('home');
  }
  App.on('data', sync);
})();

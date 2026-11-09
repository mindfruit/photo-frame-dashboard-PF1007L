// Home control: the Home Assistant entities a parent enabled in /admin.
// Grouped by Home Assistant area (with admin overrides). Sensors can share a multi-value card.
// "control" entities are tappable; "sensor" entities just show a value.
// Locks, garage doors and alarms ask for the parent PIN first.
(function () {
  'use strict';
  var D = window.DATA;
  var V = { el: null, busy: {} };

  var ICON = { light: 'bulb', switch: 'bolt', fan: 'bolt', input_boolean: 'check', lock: 'lock', cover: 'blinds', climate: 'thermo',
    media_player: 'music', scene: 'sunrise', script: 'play', button: 'play', input_button: 'play', alarm_control_panel: 'bell',
    sensor: 'clock', binary_sensor: 'door', person: 'person', automation: 'bolt' };
  function icon(x) {
    if (x.domain === 'cover' && x.deviceClass === 'garage') return 'garage';
    if (x.domain === 'lock' && x.state !== 'locked') return 'unlock';
    if (x.deviceClass === 'temperature') return 'thermo';
    if (x.deviceClass === 'humidity' || x.deviceClass === 'moisture') return 'drop';
    if (/door|window|opening|garage_door/.test(x.deviceClass)) return 'door';
    if (x.deviceClass === 'motion' || x.deviceClass === 'occupancy' || x.deviceClass === 'presence') return 'person';
    return ICON[x.domain] || 'sliders';
  }
  function cap(s) { s = String(s || '').replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); }
  function isOn(x) { return ['on', 'open', 'opening', 'playing', 'unlocked', 'heat', 'cool', 'heat_cool', 'auto', 'home'].indexOf(x.state) > -1; }

  function stateText(x) {
    if (x.state === 'unavailable' || x.state === 'unknown') return 'Unavailable';
    if (x.domain === 'sensor' || x.domain === 'input_number' || x.domain === 'number') {
      var n = parseFloat(x.state);
      return (isNaN(n) ? cap(x.state) : (Math.round(n * 10) / 10)) + (x.unit ? (x.unit === '°F' || x.unit === '°C' ? '°' : ' ' + x.unit) : '');
    }
    if (x.domain === 'binary_sensor') {
      var on = x.state === 'on';
      var dc = x.deviceClass;
      if (/door|window|opening|garage_door/.test(dc)) return on ? 'Open' : 'Closed';
      if (dc === 'motion' || dc === 'occupancy' || dc === 'presence') return on ? 'Someone there' : 'Clear';
      if (dc === 'moisture') return on ? 'Wet!' : 'Dry';
      return on ? 'On' : 'Off';
    }
    if (x.domain === 'light') return x.state === 'on' ? (x.level ? x.level + '%' : 'On') : 'Off';
    if (x.domain === 'cover') return x.pos != null && x.state === 'open' && x.pos < 100 ? x.pos + '% open' : cap(x.state);
    if (x.domain === 'climate') return (x.current != null ? x.current + '° now · ' : '') + (x.target != null ? 'set ' + x.target + '°' : cap(x.state));
    if (x.domain === 'media_player') return x.title ? x.title + (x.artist ? ' · ' + x.artist : '') : cap(x.state);
    if (x.domain === 'scene' || x.domain === 'script' || x.domain === 'button' || x.domain === 'input_button') return 'Tap to run';
    return cap(x.state);
  }
  function shortLabel(x) {
    if (x.deviceClass === 'temperature') return 'Temp';
    if (x.deviceClass === 'humidity' || x.deviceClass === 'moisture') return 'Humidity';
    if (x.deviceClass === 'motion' || x.deviceClass === 'occupancy' || x.deviceClass === 'presence') return 'Motion';
    if (/door|window|opening|garage_door/.test(x.deviceClass)) return 'Door';
    if (x.deviceClass === 'battery') return 'Battery';
    var n = x.name || '';
    // Drop leading area words already shown in the section header
    return n.length > 18 ? n.slice(0, 16) + '…' : n;
  }
  function warn(x) {
    return (x.domain === 'lock' && x.state === 'unlocked') || (x.domain === 'cover' && x.deviceClass === 'garage' && x.state !== 'closed') ||
      (x.domain === 'binary_sensor' && x.state === 'on' && /door|window|opening|garage_door|moisture|smoke|gas/.test(x.deviceClass));
  }

  function tile(x) {
    var ctl = x.mode === 'control';
    var cls = 'tile hx' + (isOn(x) ? ' is-on' : '') + (warn(x) ? ' is-warn' : '') + (ctl ? '' : ' hx--sensor') + (V.busy[x.id] ? ' is-busy' : '');
    var extra = '';
    if (ctl && x.domain === 'climate' && x.target != null) {
      extra = '<span class="hx-temp"><button data-temp="-1" aria-label="Cooler">' + App.icon('minus', 24) + '</button><button data-temp="1" aria-label="Warmer">' + App.icon('plus', 24) + '</button></span>';
    }
    return '<div class="' + cls + '" data-ent="' + App.esc(x.id) + '"' + (ctl ? ' role="button"' : '') + '>' +
      '<span class="tile-icon">' + App.icon(icon(x), 28) + (x.secure ? '<small class="hx-pin">PIN</small>' : '') + '</span>' +
      '<span class="tile-name">' + App.esc(x.name) + '</span>' +
      '<span class="tile-state">' + App.esc(stateText(x)) + '</span>' + extra + '</div>';
  }

  // Multi-sensor card: primary value large, others as compact rows.
  function multiCard(members) {
    var primary = members.filter(function (x) { return x.cardPrimary; })[0] || members[0];
    var rest = members.filter(function (x) { return x !== primary; });
    var anyWarn = members.some(warn);
    var title = primary.name;
    // If names share a prefix (e.g. "Outside Temp" / "Outside Humidity"), use that as the card title.
    if (members.length > 1) {
      var parts = members.map(function (x) { return x.name.split(/[\s·\-_]+/); });
      var shared = parts[0].filter(function (w, i) {
        return w && parts.every(function (p) { return p[i] && p[i].toLowerCase() === w.toLowerCase(); });
      });
      if (shared.length) title = shared.join(' ');
    }
    return '<div class="tile hx hx--multi hx--sensor' + (anyWarn ? ' is-warn' : '') + '" data-card="' + App.esc(primary.cardId || '') + '">' +
      '<span class="tile-icon">' + App.icon(icon(primary), 28) + '</span>' +
      '<span class="tile-name">' + App.esc(title) + '</span>' +
      '<span class="tile-state hx-multi-primary">' + App.esc(stateText(primary)) + '</span>' +
      (rest.length ? '<ul class="hx-multi-list">' + rest.map(function (x) {
        return '<li><span>' + App.esc(shortLabel(x)) + '</span><b>' + App.esc(stateText(x)) + '</b></li>';
      }).join('') + '</ul>' : '') +
      '</div>';
  }

  function orderedGroups() {
    var items = D.ha || [];
    var byId = {};
    (D.haGroups || []).forEach(function (g) { byId[g.id] = g; });
    // Fall back if older state without haGroups
    items.forEach(function (x) {
      if (!byId[x.groupId]) byId[x.groupId] = { id: x.groupId, name: x.groupName || x.groupId, sort: 1000 };
    });
    return Object.keys(byId).map(function (id) { return byId[id]; }).sort(function (a, b) {
      var sa = a.sort != null ? a.sort : 1000, sb = b.sort != null ? b.sort : 1000;
      if (sa !== sb) return sa - sb;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  function renderGroup(g) {
    var items = (D.ha || []).filter(function (x) { return x.groupId === g.id; })
      .sort(function (a, b) { return (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name); });
    if (!items.length) return '';

    var cards = {}, solo = [];
    items.forEach(function (x) {
      if (x.cardId && x.mode === 'sensor') {
        if (!cards[x.cardId]) cards[x.cardId] = [];
        cards[x.cardId].push(x);
      } else solo.push(x);
    });

    var tiles = '';
    // Emit multi-cards first (stable by card id), then solo controls/sensors
    Object.keys(cards).sort().forEach(function (cid) {
      var m = cards[cid];
      tiles += m.length > 1 ? multiCard(m) : tile(m[0]);
    });
    tiles += solo.map(tile).join('');
    return '<section class="room" data-group="' + App.esc(g.id) + '"><div class="room-h"><h3 class="serif">' + App.esc(g.name) + '</h3></div><div class="tiles">' + tiles + '</div></section>';
  }

  function groups() {
    var html = '';
    if (!D.connected) html += '<p class="hx-note">Home Assistant isn’t reachable right now — showing the last known state.</p>';
    if (!(D.ha && D.ha.length)) {
      html += '<p class="hx-note">Nothing here yet. A parent can pick devices in the parent page (/admin → Home).</p>';
      return html;
    }
    orderedGroups().forEach(function (g) { html += renderGroup(g); });
    return html;
  }

  function paint() { if (V.el) V.el.querySelector('.hx-wrap').innerHTML = groups(); }

  App.askPin = function (title, cb) {
    var pin = '';
    App.sheet('<div class="sheet-pad pinpad"><div class="label">Grown-ups only</div><h2 class="serif sheet-h">' + App.esc(title) + '</h2>' +
      '<div class="pin-dots"></div><div class="pin-keys">' + [1, 2, 3, 4, 5, 6, 7, 8, 9, 'x', 0, 'ok'].map(function (k) {
        return '<button data-k="' + k + '">' + (k === 'x' ? '⌫' : k === 'ok' ? 'OK' : k) + '</button>';
      }).join('') + '</div></div>', {
      onMount: function (s, close) {
        var dots = s.querySelector('.pin-dots');
        s.addEventListener('click', function (e) {
          var b = e.target.closest('[data-k]');
          if (!b) return;
          var k = b.dataset.k;
          if (k === 'x') pin = pin.slice(0, -1);
          else if (k === 'ok') { if (pin.length >= 4) { close(); cb(pin); } return; }
          else if (pin.length < 8) pin += k;
          dots.textContent = pin.replace(/./g, '●');
        });
      }
    });
  };

  function act(x, action, value, pin) {
    V.busy[x.id] = true; paint();
    D.api('POST', 'ha/act', { entity_id: x.id, action: action, value: value }, pin).then(function () {
      setTimeout(function () { delete V.busy[x.id]; paint(); }, 1500);
    }).catch(function (err) {
      delete V.busy[x.id]; paint();
      App.toast(err.status === 401 ? 'Wrong PIN' : 'Couldn’t reach <b>' + App.esc(x.name) + '</b> · ' + App.esc(err.message), { tone: 'error', icon: 'bolt' });
    });
  }

  function tap(x, e) {
    var t = e.target.closest('[data-temp]');
    if (t && x.domain === 'climate') return act(x, 'temp', (+x.target || 0) + +t.dataset.temp);
    if (x.domain === 'climate') return;
    var action = 'toggle';
    if (x.domain === 'lock') action = x.state === 'locked' ? 'unlock' : 'lock';
    if (x.domain === 'cover') action = x.state === 'closed' ? 'open' : 'close';
    if (x.domain === 'alarm_control_panel') action = x.state === 'disarmed' ? 'arm_away' : 'disarm';
    if (!x.secure) return act(x, action);
    var verb = { unlock: 'Unlock', lock: 'Lock', open: 'Open', close: 'Close', arm_away: 'Arm', disarm: 'Disarm' }[action] || 'Change';
    App.askPin(verb + ' ' + x.name + '?', function (pin) { act(x, action, null, pin); });
  }

  function onClick(e) {
    var el = e.target.closest('[data-ent]');
    if (!el) return;
    var x = D.ha.filter(function (h) { return h.id === el.dataset.ent; })[0];
    if (x && x.mode === 'control' && !V.busy[x.id]) tap(x, e);
  }

  App.setDevice = function () {};
  App.openGarageSheet = function () { App.go('control'); };
  App.cameraSheet = function () { App.toast('No cameras connected yet', { icon: 'camera' }); };

  App.register('control', {
    show: function (el) {
      if (!V.el) {
        V.el = el;
        el.innerHTML = '<div class="hc hc--ha"><div class="hc-rooms hx-wrap"></div></div>';
        el.addEventListener('click', onClick);
      }
      paint();
    }
  });
})();

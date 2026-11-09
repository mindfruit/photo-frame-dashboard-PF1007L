// Per-screen setup from the parent page (Devices): which tabs show and in what order, the start
// tab, kid-lock (no menu rail, one tab), and how dim the night screen is. Runs after every data load.
(function () {
  'use strict';
  var D = window.DATA;
  var lastKey = '';

  function kidTabs() {
    return D.people.filter(function (p) { return p.showTab && p.role === 'kid'; }).map(function (p) { return 'person-' + p.id; });
  }
  function resolve(list) {
    var out = [];
    list.forEach(function (t) { (t === 'kids' ? kidTabs() : [t]).forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); }); });
    return out;
  }

  function apply() {
    var dev = D.device, rail = App.$('#rail'), stage = App.$('#stage'), clock = App.$('#railClock');
    if (!rail || !stage) return;
    var buttons = App.$$('.rail-item', rail);
    var all = buttons.map(function (b) { return b.dataset.go; });
    var want = dev && dev.tabs && dev.tabs.length ? resolve(dev.tabs).filter(function (t) { return all.indexOf(t) > -1; }) : all;
    if (!want.length) want = ['home'];
    // order + visibility (the Home-control tab also needs Home Assistant devices picked)
    buttons.forEach(function (b) {
      var i = want.indexOf(b.dataset.go);
      b.hidden = i < 0 || (b.dataset.go === 'control' && !D.homeEnabled);
    });
    want.forEach(function (t) { var b = rail.querySelector('[data-go="' + t + '"]'); if (b) rail.insertBefore(b, clock); });

    var def = dev ? (dev.defaultTab === 'kids' ? kidTabs()[0] : dev.defaultTab) : 'home';
    if (!def || want.indexOf(def) < 0) def = want[0];
    App.homeTab = def;

    var lock = !!(dev && dev.kidLock);
    stage.classList.toggle('kid-lock', lock);
    stage.style.setProperty('--night-dim', ((dev ? dev.dim : 40) / 100).toFixed(2));
    // Look: <html data-theme="paper"> switches on css/themes/paper.css (live: a theme change arrives with the next SSE reload)
    var theme = dev && dev.theme === 'paper' ? 'paper' : 'default';
    if (document.documentElement.getAttribute('data-theme') !== theme) document.documentElement.setAttribute('data-theme', theme);
    // At night (css/night.css): dim = muted natural colours, red = amber/red for bedrooms
    var night = dev && dev.nightStyle === 'red' ? 'red' : 'dim';
    if (document.documentElement.getAttribute('data-night') !== night) document.documentElement.setAttribute('data-night', night);

    // jump to the start tab when the setup changes, or if this tab is no longer allowed
    var key = JSON.stringify(Object.assign({}, dev, { theme: null, nightStyle: null })) + want.join(); // a new look alone doesn't jump tabs
    if (key !== lastKey || (App.current && want.indexOf(App.current) < 0)) {
      lastKey = key;
      if (App.current !== def && (want.indexOf(App.current) < 0 || lock || App.current === 'home')) App.go(def);
    }
  }
  App.on('data', apply);
})();

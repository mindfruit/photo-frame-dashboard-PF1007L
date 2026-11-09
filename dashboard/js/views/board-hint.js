// First-run gesture hint for the Flipboard ("tap for next · hold for menu"), remembered per screen in localStorage.
// It shows on up to HINT_MAX opens of the Flipboard, and never again once someone taps or holds on that screen.
// Pure (the store is passed in), so server/board/test.js can test it.
export var HINT_MAX = 3;
export function hintKey(screen) { return 'pf.flipHint.' + (screen || 'default'); }
// Call once per Flipboard open: true = show the hint now (and count this showing).
export function hintShouldShow(store, screen) {
  try {
    var k = hintKey(screen), v = store.getItem(k);
    if (v === 'done') return false;
    var n = parseInt(v || '0', 10);
    if (!(n >= 0)) n = 0;
    if (n >= HINT_MAX) return false;
    store.setItem(k, String(n + 1));
    return true;
  } catch (e) { return false; } // no storage: no hint rather than a hint on every load
}
// The first tap or hold on this screen: never show the hint here again.
export function hintDone(store, screen) { try { store.setItem(hintKey(screen), 'done'); } catch (e) {} }

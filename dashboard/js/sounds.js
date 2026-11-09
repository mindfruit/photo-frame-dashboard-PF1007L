// Tiny sound effects made with WebAudio (no audio files). App.sound('ding' | 'cheer' | 'pop' | 'timer').
// Respects the "mute sounds" setting and quiet hours.
(function () {
  'use strict';
  var ctx = null;
  function ac() {
    if (!ctx) { var C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, start, dur, type, vol) {
    var c = ac(); if (!c) return;
    var o = c.createOscillator(), g = c.createGain(), t = c.currentTime + start;
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(c.destination);
    o.start(t); o.stop(t + dur + 0.05);
  }
  var SOUNDS = {
    pop: function () { tone(660, 0, 0.12, 'triangle', 0.2); },
    ding: function () { tone(880, 0, 0.25, 'sine'); tone(1320, 0.08, 0.35, 'sine', 0.18); },
    cheer: function () { [523, 659, 784, 1047].forEach(function (f, i) { tone(f, i * 0.11, 0.3, 'triangle', 0.22); }); tone(1047, 0.5, 0.6, 'sine', 0.2); },
    timer: function () { for (var i = 0; i < 3; i++) { tone(988, i * 0.4, 0.18, 'square', 0.12); tone(988, i * 0.4 + 0.2, 0.15, 'square', 0.12); } }
  };
  App.sound = function (name) {
    var D = window.DATA;
    if (D && D.soundsOn === false) return;
    if (App.isQuiet && App.isQuiet()) return;
    try { (SOUNDS[name] || SOUNDS.pop)(); } catch (e) {}
  };
  // A simple countdown timer with an alarm sound: App.timer(minutes)
  App.timer = function (min) {
    clearTimeout(App._timer);
    App._timer = setTimeout(function () { App.sound('timer'); App.toast('<b>Time’s up!</b>', { icon: 'clock', ms: 8000 }); }, min * 60000);
    App.toast('Timer set for <b>' + min + ' min</b>', { icon: 'clock', ms: 2500 });
  };
})();

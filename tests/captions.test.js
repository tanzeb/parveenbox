/* Run: node --test tests/  The TV player script keeps YouTube's subtitles off unless switched on in the Up menu. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'tv-app', 'webOSUserScripts', 'userScript.js'), 'utf8');

/* a fake YouTube player page; returns the calls the script made on the player, and its key handler */
function load(stored) {
  const calls = [], timers = [], ticks = [], keys = [], store = Object.assign({}, stored);
  const video = { duration: 1800, currentTime: 10, paused: false };
  const el = () => ({ style: {}, appendChild() {}, remove() {}, firstChild: null, parentNode: null });
  const p = {
    classList: { contains: () => false }, querySelector: () => video,
    getVideoData: () => ({ video_id: 'aaaaaaaaaaa' }),
    getAvailableQualityLevels: () => ['hd1080', 'hd720', 'auto'], getPlaybackQuality: () => 'hd1080',
    setPlaybackQualityRange() {}, setPlaybackQuality() {},
    setOption: (...a) => calls.push(['setOption'].concat(a)), getOption: () => [{ languageCode: 'en' }],
    loadModule: (m) => calls.push(['loadModule', m]), unloadModule: (m) => calls.push(['unloadModule', m])
  };
  const document = {
    readyState: 'complete', body: el(), documentElement: el(),
    querySelector: (s) => (/movie_player|html5-video-player/.test(s) ? p : s === 'video' ? video : null),
    createElement: el, addEventListener() {}
  };
  const st = { ret: 'https://tanzeb.github.io/parveenbox/', pl: 'PLtest', eps: ['aaaaaaaaaaa'], i: 0, w: [] };
  const window = {
    location: { hostname: 'www.youtube.com', href: 'https://www.youtube.com/embed/aaaaaaaaaaa#pb=' + encodeURIComponent(JSON.stringify(st)), replace() {} },
    document, history: { replaceState() {} },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    addEventListener: (t, f) => { if (t === 'keydown') keys.push(f); },
    setInterval: (f) => ticks.push(f), setTimeout: (f) => timers.push(f), clearTimeout() {},
    Date, JSON, Array, Object, Math, isFinite, encodeURIComponent, decodeURIComponent
  };
  window.window = window.top = window.parent = window;
  vm.runInNewContext(SRC, window);
  ticks[0]();                                       // the first watch-loop pass sees the video start
  timers.splice(0).forEach((f) => f());             // the later checks
  const press = (code) => keys.forEach((f) => f({ keyCode: code, preventDefault() {}, stopImmediatePropagation() {} }));
  return { calls, store, press };
}

test('subtitles are switched off when an episode starts', () => {
  const { calls } = load({});
  assert.ok(calls.some((c) => c[0] === 'unloadModule' && c[1] === 'captions'));
  assert.ok(calls.some((c) => c[0] === 'setOption' && c[1] === 'captions' && c[2] === 'track'));
  assert.ok(!calls.some((c) => c[0] === 'loadModule'));
});

test('Up then OK switches subtitles on, and the choice is remembered', () => {
  const t = load({});
  t.calls.length = 0;
  t.press(38); t.press(13);                         // Up opens the menu on "Subtitles", OK switches
  assert.strictEqual(t.store.pb_cc, 'on');
  assert.ok(t.calls.some((c) => c[0] === 'loadModule' && c[1] === 'captions'));
  const again = load({ pb_cc: 'on' });              // the next episode keeps them on
  assert.ok(!again.calls.some((c) => c[0] === 'unloadModule'));
});

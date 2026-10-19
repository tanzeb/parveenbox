/* Run: node --test (no install needed). Runs the TV player script on a fake YouTube page: failed episodes. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'tv-app', 'webOSUserScripts', 'userScript.js'), 'utf8');

/* load the script on a player page with this #pb state; `error` puts YouTube's error box on the page,
   `ended` a video that has played to the end. Returns where the page went next. */
function run(st, opts) {
  let now = 1e12, went = null;
  const timers = [], ticks = [];
  const video = opts.ended ? { duration: 1800, currentTime: 1800, ended: true, paused: true } : null;
  const el = () => ({ style: {}, appendChild() {}, remove() {}, firstChild: null, parentNode: null });
  const document = {
    readyState: 'complete', body: el(), documentElement: el(),
    querySelector: (s) => (opts.error && /ytp-error/.test(s) ? {} : s === 'video' ? video : null),
    createElement: el, addEventListener() {}
  };
  const href = 'https://www.youtube.com/embed/' + st.eps[st.i] + '#pb=' + encodeURIComponent(JSON.stringify(st));
  const window = {
    location: { hostname: 'www.youtube.com', href, replace: (u) => { went = u; } },
    document, history: { replaceState() {} }, localStorage: { getItem: () => null, setItem() {} },
    addEventListener() {}, setInterval: (f) => ticks.push(f), setTimeout: (f) => timers.push(f), clearTimeout() {},
    Date: { now: () => now }, JSON, Array, Object, Math, isFinite, encodeURIComponent, decodeURIComponent
  };
  window.window = window.top = window.parent = window;
  vm.runInNewContext(SRC, window);
  now += 7000;                                      // past the script's start-up wait
  ticks.forEach((f) => f());
  for (let i = 0; i < 5 && timers.length; i++) timers.shift()();
  return went;
}
const state = (url) => JSON.parse(decodeURIComponent(/#pb=(.+)$/.exec(url)[1]));
const ST = { ret: 'https://tanzeb.github.io/parveenbox/', pl: 'PLtest', eps: ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc'], i: 0, w: [] };

test('a failed episode moves on but is not counted as watched', () => {
  const went = run(ST, { error: true });
  assert.match(went, /\/embed\/bbbbbbbbbbb/);
  assert.deepStrictEqual(state(went).w, []);
  assert.strictEqual(state(went).f, 1);
});

test('a second failure in a row goes back to ParveenBox, with nothing marked watched', () => {
  const went = run(Object.assign({}, ST, { i: 1, f: 1 }), { error: true });
  assert.match(went, /^https:\/\/tanzeb\.github\.io\/parveenbox\/#\/p\/PLtest\?last=bbbbbbbbbbb&w=&pbok=1/);
});

test('an episode that played to the end still counts as watched', () => {
  const went = run(ST, { ended: true });
  assert.deepStrictEqual(state(went).w, ['aaaaaaaaaaa']);
});

/* Run: node --test  (no install needed). Loads data.js with a fake browser and checks the title logic. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const window = {
  PB_CONFIG: { youtubeKey: 'test', region: 'IN' },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, key: (i) => Object.keys(store)[i], get length() { return Object.keys(store).length; } }
};
window.window = window;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8'), window);
const PB = window.PB;

test('showTitle keeps only the drama name', () => {
  assert.strictEqual(PB.showTitle('Dhoop Kinare | Episode 01 - 27 | HUM TV'), 'Dhoop Kinare');
  assert.strictEqual(PB.showTitle('Mere Paas Tum Ho - All Episodes'), 'Mere Paas Tum Ho');
  assert.strictEqual(PB.showTitle('Humsafar Full Drama HD'), 'Humsafar');
  assert.strictEqual(PB.showTitle('Zindagi Gulzar Hai'), 'Zindagi Gulzar Hai');
});

test('search matching allows typos and spellings, not other dramas', () => {
  assert.strictEqual(PB.sim('dhoop kinare', 'Dhoop Kinaray Episode 1'), 1);   // transliteration
  assert.strictEqual(PB.sim('humsafr', 'Humsafar | HUM TV'), 1);            // typo
  assert.ok(PB.sim('dhoop kinare', 'Mere Paas Tum Ho') < 0.75);
  assert.ok(PB.phrase('kabhi main kabhi tum', 'Kabhi Main Kabhi Tum Episode 3'));
  assert.ok(!PB.phrase('kabhi main kabhi tum', 'Tum kabhi main song'));
});

test('episodes are ordered by the number in their title', () => {
  const titles = ['Drama Ep 3', 'Drama Episode 1', 'Drama Ep 10', 'Drama Ep 2'];
  assert.deepStrictEqual(PB.order(titles.map((t, i) => ({ t, pos: i }))).map((e) => e.n), [1, 2, 3, 10]);
  /* titles without numbers keep the playlist order */
  assert.deepStrictEqual(PB.order([{ t: 'Part B', pos: 0 }, { t: 'Part A', pos: 1 }]).map((e) => e.t), ['Part B', 'Part A']);
  /* "Sinf e Aahan": the Urdu "e" must not be read as an episode marker */
  assert.deepStrictEqual(PB.order([{ t: 'Sinf e Aahan Episode 2', pos: 0 }, { t: 'Sinf e Aahan Episode 1', pos: 1 }]).map((e) => e.n), [1, 2]);
});

test('the front page keeps out Indian and Turkish channels', () => {
  const ok = (title, channel, count) => PB.eligible({ title, channel, count }, { minEps: 8 });
  assert.ok(ok('Habs | All Episodes', 'ARY Zindagi', 33));
  assert.ok(!ok('Maddam Sir | Full Episodes Here', 'Sony SAB', 741));
  assert.ok(!ok('Katha Ankahee | Full Episodes Here', 'SET India', 271));
  assert.ok(!ok('Kurulus Osman Season 06', 'HAR PAL GEO', 245));
  assert.ok(!ok('Tumm Se Tumm Tak', 'Priya Artika Devi', 1420));
});

test('Turkish uploads are kept out too', () => {
  assert.ok(!PB.eligible({ title: 'Mutlu Ol', channel: 'Kanal 7 Pakistan Dizileri', count: 54 }, { minEps: 8 }));
});

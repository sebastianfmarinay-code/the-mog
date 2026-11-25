'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Matchmaker, normalizeInterests } = require('../src/matchmaker');
const { Moderation } = require('../src/moderation');

/** Manual timers so fallback behaviour can be tested without waiting. */
function fakeTimers() {
  const timers = new Set();
  return {
    setTimer(fn) {
      const t = { fn };
      timers.add(t);
      return t;
    },
    clearTimer(t) {
      timers.delete(t);
    },
    runAll() {
      for (const t of [...timers]) {
        timers.delete(t);
        t.fn();
      }
    },
    get size() {
      return timers.size;
    },
  };
}

function setup(opts = {}) {
  const matches = [];
  const timers = fakeTimers();
  const mm = new Matchmaker({
    onMatch: (a, b, common, mode) => matches.push({ a, b, common, mode }),
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...opts,
  });
  return { mm, matches, timers };
}

test('normalizeInterests cleans, dedupes and caps', () => {
  assert.deepEqual(normalizeInterests(['  Music ', 'music', 'Video   Games', '', 42, null]), ['music', 'video games']);
  assert.deepEqual(normalizeInterests('music'), []);
  assert.equal(normalizeInterests(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 10);
  assert.equal(normalizeInterests(['x'.repeat(100)])[0].length, 32);
  assert.deepEqual(normalizeInterests(['a\u0000b']), ['ab']);
});

test('two people without interests are paired immediately', () => {
  const { mm, matches } = setup();
  assert.equal(mm.enqueue('a', { mode: 'text' }), null);
  assert.deepEqual(mm.enqueue('b', { mode: 'text' }), { partnerId: 'a', common: [] });
  assert.deepEqual(matches, [{ a: 'b', b: 'a', common: [], mode: 'text' }]);
  assert.equal(mm.waitingCount(), 0);
});

test('text and video queues are separate', () => {
  const { mm, matches } = setup();
  mm.enqueue('a', { mode: 'text' });
  mm.enqueue('b', { mode: 'video' });
  assert.equal(matches.length, 0);
  mm.enqueue('c', { mode: 'video' });
  assert.deepEqual(matches.map((m) => [m.a, m.b, m.mode]), [['c', 'b', 'video']]);
});

test('prefers the person sharing the most interests', () => {
  const { mm, matches } = setup();
  mm.enqueue('one', { interests: ['music'] });
  mm.enqueue('two', { interests: ['anime', 'chess'] });
  mm.enqueue('none', {});
  assert.equal(matches.length, 0);
  mm.enqueue('me', { interests: ['music', 'anime', 'chess'] });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].b, 'two');
  assert.deepEqual(matches[0].common.sort(), ['anime', 'chess']);
});

test('people with interests wait, then fall back to random', () => {
  const { mm, matches, timers } = setup();
  mm.enqueue('a', { interests: ['cats'] });
  mm.enqueue('b', {});
  assert.equal(matches.length, 0, 'should not pair immediately without a shared interest');
  timers.runAll();
  assert.deepEqual(matches.map((m) => [m.a, m.b]), [['a', 'b']]);
});

test('opting out of the random fallback keeps waiting for a shared interest', () => {
  const { mm, matches, timers } = setup();
  mm.enqueue('a', { interests: ['cats'], randomFallback: false });
  assert.equal(timers.size, 0);
  mm.enqueue('b', {});
  timers.runAll();
  assert.equal(matches.length, 0);
  mm.enqueue('c', { interests: ['cats', 'dogs'] });
  assert.deepEqual(matches.map((m) => [m.a, m.b, m.common]), [['c', 'a', ['cats']]]);
});

test('dequeue removes someone and cancels their fallback timer', () => {
  const { mm, matches, timers } = setup();
  mm.enqueue('a', { interests: ['cats'] });
  assert.equal(timers.size, 1);
  assert.equal(mm.dequeue('a'), true);
  assert.equal(timers.size, 0);
  assert.equal(mm.dequeue('a'), false);
  mm.enqueue('b', {});
  assert.equal(matches.length, 0);
});

test('re-enqueueing replaces the previous entry', () => {
  const { mm } = setup();
  mm.enqueue('a', { mode: 'text' });
  mm.enqueue('a', { mode: 'video' });
  assert.equal(mm.waitingCount('text'), 0);
  assert.equal(mm.waitingCount('video'), 1);
});

test('canPair blocks specific pairs', () => {
  const { mm, matches } = setup({ canPair: (x, y) => !(x === 'b' && y === 'a') });
  mm.enqueue('a', {});
  mm.enqueue('b', {});
  assert.equal(matches.length, 0);
  mm.enqueue('c', {});
  assert.equal(matches.length, 1);
  assert.equal(new Set([matches[0].a, matches[0].b]).has('c'), true);
});

test('moderation bans after enough distinct reporters', () => {
  let now = 1000;
  const mod = new Moderation({ threshold: 2, banMs: 500, windowMs: 10_000, now: () => now });
  assert.equal(mod.report('bad', 'r1'), false);
  assert.equal(mod.report('bad', 'r1'), false, 'the same reporter only counts once');
  assert.equal(mod.banRemaining('bad'), 0);
  assert.equal(mod.report('bad', 'r2'), true);
  assert.equal(mod.banRemaining('bad'), 500);
  now += 501;
  assert.equal(mod.banRemaining('bad'), 0);
});

test('moderation forgets reports outside the window', () => {
  let now = 0;
  const mod = new Moderation({ threshold: 2, windowMs: 100, now: () => now });
  mod.report('bad', 'r1');
  now = 200;
  assert.equal(mod.report('bad', 'r2'), false);
  mod.prune();
  assert.equal(mod.reports.get('bad').size, 1);
});

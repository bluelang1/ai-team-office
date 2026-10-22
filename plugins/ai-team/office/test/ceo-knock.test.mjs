import './home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ceoEntry, CEO_KNOCK, CEO_PLAN, HoverHold } from '../public/ceo.js';
import { ROOMS } from '../public/world.js';

test('대표실 knock: only a live newcomer knocks; reload/replay and reduced motion appear in place', () => {
  const known = new Set(['S|main']);
  assert.deepEqual(ceoEntry('S|a1', { known: null, sameFloor: true, reduced: false }), { anim: null, knock: false }, 'first live render (reload/replay): already waiting -> in place');
  assert.deepEqual(ceoEntry('S|a1', { known, sameFloor: true, reduced: false }), { anim: 'arrive', knock: true }, 'same floor newcomer walks in and knocks');
  assert.deepEqual(ceoEntry('T|main', { known, sameFloor: false, reduced: false }), { anim: 'warp', knock: true }, 'other floor newcomer warps in and knocks');
  assert.deepEqual(ceoEntry('S|main', { known, sameFloor: true, reduced: false }), { anim: 'arrive', knock: false }, 'was already queued (+N) -> slides in, no second knock');
  assert.deepEqual(ceoEntry('S|a1', { known, sameFloor: true, reduced: true }), { anim: null, knock: false }, 'reduced motion: no knock, no bubble');
  const x = r => ROOMS.ceo.x + ROOMS.ceo.w - r;
  assert.equal(x(CEO_PLAN.door), ROOMS.ceo.door.x, 'they knock at the real door');
  assert.ok(CEO_KNOCK.bubbleAt < CEO_KNOCK.ms && CEO_KNOCK.ms - CEO_KNOCK.bubbleAt >= 800 && CEO_KNOCK.ms - CEO_KNOCK.bubbleAt <= 1000, '"똑똑" shows ~0.8-1s');
});

test('hover card: stays open on the character or the card, closes only after a grace with the pointer on neither', () => {
  let now = 0, closed = 0; const timers = new Map(); let n = 0;
  const fake = { set: (f, t) => { timers.set(++n, { f, at: now + t }); return n; }, clear: id => timers.delete(id) };
  const run = ms => { now += ms; for (const [id, t] of [...timers]) if (t.at <= now) { timers.delete(id); t.f(); } };
  const h = new HoverHold(() => closed++, 300, fake);
  h.enter('anchor'); h.leave('anchor'); run(120); h.enter('card'); run(1000);
  assert.equal(closed, 0, 'moved from the character onto the card within the grace -> stays open');
  h.leave('card'); run(299); assert.equal(closed, 0, 'still within the grace');
  run(1); assert.equal(closed, 1, 'left both -> closes');
  h.enter('anchor'); h.leave('anchor'); h.enter('anchor'); run(1000); assert.equal(closed, 1, 'back on the character -> stays');
  h.leave('anchor'); h.reset(); run(1000); assert.equal(closed, 1, 'reset (closed/pinned elsewhere) cancels the pending close');
});

test('hover switching: passing through another person on the way to the card never swaps it; resting 150ms does', () => {
  let now = 0, closed = 0; const timers = new Map(); let n = 0;
  const fake = { set: (f, t) => { timers.set(++n, { f, at: now + t }); return n; }, clear: id => timers.delete(id) };
  const run = ms => { const end = now + ms; for (;;) { const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!due) break; now = due[1].at; timers.delete(due[0]); due[1].f(); } now = end; };
  const shown = []; const open = k => () => shown.push(k);
  const h = new HoverHold(() => closed++, 300, fake, 150);
  h.over('front', open('front'));
  assert.deepEqual(shown, ['front'], 'first hover opens at once');
  h.out('front'); run(20); h.over('back', open('back')); run(40);
  assert.deepEqual(shown, ['front'], 'moving to the back person does not switch before the dwell');
  run(120);
  assert.deepEqual(shown, ['front', 'back'], 'resting on the back person ≥150ms switches');
  // the bug path: back card open, pointer heads for the card and crosses the front person on the way
  h.out('back'); run(16); h.over('front', open('front')); run(60); h.out('front'); run(16); h.enter('card'); run(1000);
  assert.deepEqual(shown, ['front', 'back'], 'crossing the front person (76ms) does not bring its card back');
  assert.equal(closed, 0, 'and the back card stayed open');
  h.over('front', open('front')); run(500);
  assert.deepEqual(shown, ['front', 'back'], 'while the pointer is on the card, a person under it never takes over');
  h.leave('card'); run(10); h.over('front', open('front')); run(149);
  assert.deepEqual(shown, ['front', 'back'], '149ms is still passing through');
  h.over('front', open('front')); run(1);
  assert.deepEqual(shown, ['front', 'back', 'front'], 'repeated pointerover on the same person keeps one timer; 150ms switches');
  h.out('front'); run(300); assert.equal(closed, 1, 'leaving everything closes after the grace');
  h.reset(); h.over('x', open('x')); assert.deepEqual(shown.at(-1), 'x', 'after reset (closed / pinned) the next hover opens at once');
});

// v3 office scene: seat book (seats, overflow spots, promotion), the main's model from usage, 실장 title, clock midnight.
import './home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeatBook } from '../public/seats.js';
import { SEATS } from '../public/world.js';
import { Usage } from '../public/charts.js';
import { mainTitle, displayName } from '../public/roles.js';
import { mountClock, ymd } from '../public/clock.js';

const book = () => new SeatBook({ library: 7, floor: 14 }, room => (room === 'floor' ? [0, 1, 2, 3, 4, 5] : []));

test('seats: library seats fill first, then overflow spots; a freed spot is reused, never stacked', () => {
  const b = book();
  for (let i = 0; i < 10; i++) b.claim(`a${i}`, 'library');
  assert.deepEqual([...Array(7)].map((_, i) => b.get(`a${i}`).i), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(['a7', 'a8', 'a9'].map(id => b.get(id).over), [0, 1, 2]);
  b.release('a7');                                     // spot 0 leaves while 1 and 2 stay
  b.claim('a10', 'library');
  assert.equal(b.get('a10').over, 0, 'takes the freed spot 0, not 3 or a duplicate 2');
  const spots = ['a8', 'a9', 'a10'].map(id => b.get(id).over);
  assert.equal(new Set(spots).size, spots.length, `no two agents on one spot: ${spots}`);
});

test('seats: a freed seat promotes the longest-waiting stander in that room', () => {
  const b = book();
  for (let i = 0; i < 9; i++) b.claim(`a${i}`, 'library');        // a7, a8 stand (a7 first)
  const promoted = b.release('a3');
  assert.equal(promoted, 'a7');
  assert.deepEqual(b.get('a7'), { room: 'library', i: 3 });
  assert.equal(b.get('a8').over, 1);
  b.claim('a0', 'pantry');                                          // moving rooms frees seat 0 -> a8 sits
  assert.deepEqual(b.get('a8'), { room: 'library', i: 0 });
  assert.equal(b.release('a1'), null, 'nobody left waiting');
});

test('seats: reducer desks are forced and reserved; overflow uses the other office seats', () => {
  const b = book();
  assert.deepEqual(b.claim('d2', 'floor', { force: 2 }), { room: 'floor', i: 2 });
  assert.deepEqual(b.claim('x', 'floor'), { room: 'floor', i: 6 }, 'non-desk agents never take seats 0..5');
  for (let i = 0; i < 7; i++) b.claim(`y${i}`, 'floor');            // seats 7..13 full
  assert.equal(b.claim('z', 'floor').over, 0);
  assert.equal(b.release('d2'), null, 'a reserved desk does not promote a stander');
  assert.equal(b.claim('d2b', 'floor', { force: 2 }).i, 2);
  assert.equal(SEATS.library.length, 7);
});

test('Usage.mainFamily: most recent known family wins; unknown and subagent records never overwrite it', () => {
  const u = new Usage();
  const rec = (id, ts, o) => u.add({ id, ts, sid: 's1', proj: 'p', in: 1, out: 10, ...o });
  assert.equal(u.mainFamily('s1'), null);
  rec('1', '2026-10-21T01:00:00Z', { model: 'claude-fable-5', family: 'fable' });
  assert.equal(u.mainFamily('s1'), 'fable');
  rec('2', '2026-10-21T02:00:00Z', { model: 'claude-opus-5-5', family: 'opus' });
  assert.equal(u.mainFamily('s1'), 'opus', 'switch fable -> opus');
  rec('3', '2026-10-21T03:00:00Z', { model: 'arn:aws:bedrock:us-east-1:123:inference-profile/xyz', family: 'unknown' });
  assert.equal(u.mainFamily('s1'), 'opus', 'unknown model string keeps the known family');
  rec('4', '2026-10-21T04:00:00Z', { model: 'claude-haiku-5-5', family: 'haiku', aid: 'sub1' });
  assert.equal(u.mainFamily('s1'), 'opus', 'subagent records are not the main');
  rec('5', '2026-10-21T05:00:00Z', { model: 'claude-sonnet-5', family: 'sonnet', isSidechain: true });
  assert.equal(u.mainFamily('s1'), 'opus', 'sidechain messages are skipped');
  rec('6', '2026-10-21T00:30:00Z', { model: 'claude-sonnet-5', family: 'sonnet' });
  assert.equal(u.mainFamily('s1'), 'opus', 'an older record does not win');
  u.reset();
  assert.equal(u.mainFamily('s1'), null);
});

test('mainTitle / displayName: model + 실장, fallback 실장', () => {
  assert.equal(mainTitle('opus'), 'Opus 실장');
  assert.equal(mainTitle('fable'), 'Fable 실장');
  assert.equal(mainTitle('unknown'), '실장');
  assert.equal(mainTitle(null), '실장');
  assert.equal(displayName({ aid: null, model: 'opus' }), 'Opus 실장');
  assert.equal(displayName({ aid: null, model: 'unknown' }), '실장');
});

test('clock: calendar rolls over at local midnight (injected clock)', () => {
  const node = () => ({ textContent: '', className: '' });
  const parts = { '.cal-ymd': node(), '.cal-d': node(), '.cal-w': node() };
  const cal = { querySelector: q => parts[q], setAttribute(k, v) { this[k] = v; } };
  const compact = { innerHTML: '' };
  let t = new Date(2026, 9, 21, 23, 59, 59, 500).getTime();       // Wed 2026-10-21 23:59:59.5 local
  const timers = [];
  const { tick } = mountClock({ cal, clocks: [], compact }, { now: () => new Date(t), setTimer: (fn, ms) => timers.push(ms) });
  assert.equal(parts['.cal-ymd'].textContent, '2026년 10월 21일');
  assert.equal(parts['.cal-d'].textContent, '21');
  assert.equal(parts['.cal-w'].textContent, '수요일');
  assert.ok(timers[0] > 0 && timers[0] <= 1008, 'next tick aligned to the next second');
  t += 1000; tick();                                                // 00:00:00.5 next day
  assert.equal(parts['.cal-ymd'].textContent, '2026년 10월 22일');
  assert.equal(parts['.cal-w'].textContent, '목요일');
  t = new Date(2026, 9, 25, 9, 0, 0).getTime(); tick();             // Sunday: red
  assert.equal(parts['.cal-d'].className, 'cal-d sun');
  assert.match(compact.innerHTML, /2026년 10월 25일 <b class="sun">\(일\)<\/b>/);
  assert.equal(ymd(new Date(2026, 0, 5)), '2026년 01월 05일', 'zero-padded month and day');
});

import { ceoStep, ceoQueue, ceoResolve, ceoExpire, HIGH, LOW } from '../public/ceo.js';
import { applyFrame, mergeQueue, decidedKey, keyOfRelay, resetRelay, relay } from '../public/ceocard.js';
import { route, chainOf, ROOMS, SEATS as W_SEATS } from '../public/world.js';

const SID = 's-ceo', ts = n => `2026-10-21T10:00:${String(n).padStart(2, '0')}Z`;
test('ceoQueue: resolved by the next tool event, UserPromptSubmit on the sid, SubagentStop; LOW report expires', () => {
  const ask = { ev: 'PreToolUse', sid: SID, aid: 'a1', tool: 'AskUserQuestion', ask: '배포할까요?', ts: ts(1) };
  assert.equal(ceoQueue([ask]).length, 1);
  assert.equal(ceoQueue([ask, { ev: 'PostToolUse', sid: SID, aid: 'a1', tool: 'AskUserQuestion', ts: ts(2) }]).length, 0, 'next tool event');
  assert.equal(ceoQueue([ask, { ev: 'SubagentStop', sid: SID, aid: 'a1', ts: ts(2) }]).length, 0, 'SubagentStop');
  const perm = { ev: 'PermissionRequest', sid: SID, tool: 'Bash', target: 'git push', ts: ts(1) };
  assert.equal(ceoQueue([perm, ask, { ev: 'UserPromptSubmit', sid: SID, ts: ts(3) }]).length, 0, 'UserPromptSubmit clears the sid');
  const m = new Map();
  ceoStep(m, perm);
  assert.deepEqual(ceoResolve(m, `${SID}|main`), [`${SID}|main`], 'a dashboard/sim decision resolves locally');
  assert.deepEqual(ceoResolve(m, `${SID}|main`), []);
  ceoStep(m, { ev: 'Stop', sid: SID, ts: ts(5) });
  assert.equal([...m.values()][0].prio, LOW);
  assert.deepEqual(ceoExpire(m, Date.parse(ts(5)) + 10000), [], 'a fresh report stays');
  assert.deepEqual(ceoExpire(m, Date.parse(ts(5)) + 91000), [`${SID}|main`], 'an old report expires');
  ceoStep(m, perm);
  assert.deepEqual(ceoExpire(m, Date.parse(ts(1)) + 3600000), [], 'HIGH requests never expire on their own');
});

test('relay: decided frames name the character; closed cards never keep anyone in line', () => {
  resetRelay();
  const item = { id: 'r1', kind: 'permission', sid: SID, proj: 'p', tool: 'Bash', target: 'ls', createdAt: 1 };
  applyFrame({ type: 'ask', item });
  assert.equal(mergeQueue([]).length, 1, 'a pending relay item queues its character');
  assert.equal(keyOfRelay(relay.items.get('r1')), `${SID}|main`);
  assert.equal(decidedKey({ type: 'resolved', id: 'r1', reason: 'timeout' }), null, 'a timeout is not a decision');
  assert.equal(decidedKey({ type: 'answered', id: 'r1', by: 'dashboard' }), `${SID}|main`);
  assert.equal(decidedKey({ type: 'withdrawn', id: 'r1' }), `${SID}|main`);
  applyFrame({ type: 'answered', id: 'r1', by: 'dashboard' });
  assert.equal(mergeQueue([]).length, 0, 'answered: leaves the line right away');
  const q = mergeQueue([{ key: `${SID}|main`, sid: SID, since: 0, prio: HIGH, text: 'x' }]);
  assert.equal(q.length, 1, 'still waiting in ceo.js (e.g. terminal prompt after expiry) -> stays');
  resetRelay();
});

test('return path: from the 대표실 door back to the same seat via the aisles', () => {
  const b = new SeatBook({ library: W_SEATS.library.length });
  const s = b.claim('a1', 'library');                    // seated, then called to the 대표실: the seat stays claimed
  b.claim('a2', 'library');
  assert.deepEqual(b.get('a1'), s, 'seat kept while away');
  const door = { x: ROOMS.ceo.door.x, y: ROOMS.ceo.door.inY, kind: 'stand' }, seat = { ...W_SEATS.library[s.i] };
  const pts = route(door, chainOf('ceo', door), 'library', seat);
  assert.deepEqual(pts[0], { x: ROOMS.ceo.door.x, y: ROOMS.ceo.door.outY }, 'leaves through the 대표실 door');
  assert.deepEqual(pts.at(-1), { x: seat.x, y: seat.y }, 'ends on its own seat');
  assert.ok(pts.some(p => p.y === ROOMS.library.door.inY && p.x === ROOMS.library.door.x), 'enters through the library door');
});

import { levelOf, fmtLeft, tokKo, limitsHTML, ctxHTML, ctxOf } from '../public/limits.js';
test('limits card: levels, countdown, null data, context rows (max 5 + 더보기), desk monitor', () => {
  assert.deepEqual([59.9, 60, 85, 85.1, null].map(levelOf), ['green', 'amber', 'amber', 'red', 'none']);
  assert.equal(fmtLeft((2 * 60 + 13) * 60000 + 5000), '2시간 13분');
  assert.equal(fmtLeft(3 * 86400000 + 4 * 3600000), '3일 4시간');
  assert.equal(tokKo(410000), '41만'); assert.equal(tokKo(1000000), '100만');
  assert.match(limitsHTML(null), /데이터 없음 \(Pro\/Max 로그인 세션에서 응답 후 표시\)/);
  const now = Date.parse('2026-10-21T10:00:00Z'), s = now / 1000;
  const snap = { account: { five_hour: { pct: 91, resetsAt: s + 2 * 3600 + 13 * 60, capturedAt: s }, seven_day: { pct: 40, resetsAt: s + 86400, capturedAt: s }, stale: false },
    sessions: Array.from({ length: 7 }, (_, i) => ({ sid: `s${i}`, proj: `p${i}`, model: 'claude-opus-5-5', family: 'opus', ctx: { size: 1000000, pct: 41, inTokens: 410000 }, capturedAt: s, stale: i === 1 })) };
  const h = limitsHTML(snap, now);
  assert.match(h, /lv-red[\s\S]*91%[\s\S]*리셋까지 2시간 13분/);
  assert.match(h, /lv-green[\s\S]*40%/);
  const c = ctxHTML(snap);
  assert.equal((c.match(/class="ctx-row/g) || []).length, 5);
  assert.match(c, /41만\/100만 토큰/); assert.match(c, /더보기 \(2\)/); assert.match(c, /ctx-row lv-green stale/);
  assert.equal((ctxHTML(snap, { all: true }).match(/class="ctx-row/g) || []).length, 7);
  assert.deepEqual(ctxOf(snap, 's0'), { pct: 41, lv: 'green', size: 1000000, used: 410000, stale: false });
  assert.equal(ctxOf(snap, 'nope'), null);
});

import * as sec from '../public/secretary.js';
test('secretary: Hangul vowels -> mouth shapes, bilabials close the lips, punctuation and emoji pause', () => {
  assert.deepEqual(sec.hangul('가'), { cho: 0, jung: 0, jong: 0 });
  assert.equal(sec.hangul('a'), null);
  assert.deepEqual(['가', '네', '요', '우', '이', '의', '와'].map(ch => sec.mouthOfVowel(sec.hangul(ch).jung)), ['A', 'I', 'O', 'O', 'I', 'I', 'A']);
  const t = sec.timeline([{ text: '맘, 요~ 🌙' }]);
  assert.deepEqual(t.steps.map(s => s.mouth), ['M', 'A', 'M', 'rest', 'rest', 'O', 'I', 'rest', 'rest']);
  assert.equal(t.chars, 7, 'emoji counts as one character (code points)');
  const dur = i => (t.steps[i + 1]?.at ?? t.total) - t.steps[i].at;
  assert.equal(dur(0) + dur(1) + dur(2), 70, '~70ms per syllable');
  assert.ok(dur(3) >= 200 && dur(8) >= 300, 'comma and emoji pause with the mouth closed');
  assert.ok(t.steps.every((s, i) => i === 0 || s.at >= t.steps[i - 1].at));
});

test('secretary: cues from words; first segment bows; expressions follow cues', () => {
  assert.equal(sec.cueOf('대표님, 7시예요!', true), 'bow');
  assert.equal(sec.cueOf(' 오늘도 수고 많으셨어요.'), 'clap');
  assert.equal(sec.cueOf(' 정말 잘하셨어요!'), 'thumbs');
  assert.equal(sec.cueOf(' 이제 퇴근하세요~ 🌙'), 'wave', '퇴근 beats 🌙');
  assert.equal(sec.cueOf(' 커피는 내일 아침에 ☕'), 'coffee', 'coffee beats 내일');
  assert.equal(sec.cueOf(' 밤에는 제가 지킬게요 🌙'), 'cheek');
  assert.equal(sec.cueOf(' 내일 또 화이팅해요!'), 'fist');
  assert.equal(sec.cueOf(' 남은 일은 맡기고'), 'idle');
  assert.equal(sec.EXPR.coffee, 'playful');
  assert.ok(sec.MESSAGES.length >= 8 && sec.MESSAGES.some(m => m.some(seg => seg[2])), 'one variant winks');
  for (const m of sec.MESSAGES) for (const [text] of m) assert.match(text, /요|님|고|!|~|☕|🌙|,/);
});

test('secretary: the day decides fur, accessories and line; the line differs from yesterday; previews are deterministic', () => {
  assert.equal(sec.prevDay('2026-11-01'), '2026-10-31');
  assert.equal(sec.prevDay('2027-01-01'), '2026-12-31');
  for (const [a, b] of [['2025-12-31', '2025-12-30'], ['2026-01-01', '2025-12-31'], ['2030-03-01', '2030-02-28']]) assert.notEqual(sec.messageIndex(a), sec.messageIndex(b));
  assert.deepEqual(sec.pickLook('2026-10-24'), sec.pickLook('2026-10-24'));
  assert.ok(sec.FURS.length >= 6 && sec.ACCESSORIES.length >= 8);
  const furs = new Set(), accs = new Set(), combos = new Set();
  let k = '2026-10-21';
  for (let i = 0; i < 800; i++) {
    const L = sec.pickLook(k), m = sec.pickMessage(k), y = sec.pickMessage(sec.prevDay(k));
    assert.notEqual(m.idx, y.idx, `line on ${k} repeats yesterday`);
    assert.ok(L.acc.length >= 1 && L.acc.length <= 2, '1–2 accessories a day');
    assert.equal(new Set(L.acc.map(a => a.group)).size, L.acc.length, 'never two of the same kind (e.g. two neckties)');
    furs.add(L.fur.id); L.acc.forEach(a => accs.add(a.id)); combos.add(`${L.fur.id}|${L.acc.map(a => a.id).join('+')}`);
    const [y4, mo, d] = k.split('-').map(Number); k = sec.dayKey(new Date(y4, mo - 1, d + 1));
  }
  assert.equal(furs.size, sec.FURS.length); assert.equal(accs.size, sec.ACCESSORIES.length);
  assert.ok(combos.size > 100, 'fur and accessories vary independently');
  for (const m of sec.MESSAGES) { const last = m.at(-1)[0]; assert.match(last, /냥/, `cute ending: ${last}`); assert.ok(m.slice(0, -1).every(([t]) => !/냥/.test(t)), 'only the last segment'); }
});

test('secretary: the cat renderer draws every fur × accessory and every pose frame; face, ears and tail change per state', () => {
  const opaque = f => { let n = 0; for (let i = 3; i < f.data.length; i += 4) if (f.data[i] === 255) n++; return n; };
  const diff = (a, b) => { let n = 0; for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) n++; return n; };
  for (const fur of sec.FURS) for (const a of sec.ACCESSORIES) {
    const f = sec.renderFrame({ fur, acc: [{ ...a, color: '#d9454f' }] }, {});
    assert.equal(f.w, 96); assert.equal(f.h, 112); assert.equal(f.data.length, 96 * 112 * 4);
    assert.ok(opaque(f) > 3000, `${fur.id}/${a.id}: cat drawn`);
    assert.ok(diff(f, sec.renderFrame({ fur, acc: [] }, {})) > 8, `${fur.id}/${a.id}: accessory visible`);
  }
  const L = sec.pickLook('2026-10-24'), base = sec.renderFrame(L, {});
  for (const [pose, frames] of Object.entries(sec.PIXEL_POSES)) frames.forEach((_, frame) => {
    const f = sec.renderFrame(L, { pose, frame });
    if (pose !== 'idle') assert.ok(diff(f, base) > 20, `${pose}#${frame} differs from idle`);
  });
  assert.equal(sec.PIXEL_POSES.wave.length, 3); assert.equal(sec.PIXEL_POSES.clap.length, 2);
  assert.ok(diff(sec.renderFrame(L, { pose: 'clap', frame: 0 }), sec.renderFrame(L, { pose: 'clap', frame: 1 })) > 4, 'clap pats');
  assert.doesNotThrow(() => sec.renderFrame(L, { pose: 'clap', frame: -1 }), 'a negative frame index (rAF time behind the cue) still draws');
  for (const mouth of ['A', 'I', 'O']) { const d = diff(sec.renderFrame(L, { mouth }), base); assert.ok(d >= 3 && d < 40, `mouth ${mouth}: ${d} px`); }
  assert.equal(diff(sec.renderFrame(L, { mouth: 'M' }), base), 0, 'M/B/P closes to the ω mouth');
  for (const eyeL of ['half', 'shut', 'happy']) assert.ok(diff(sec.renderFrame(L, { eyeL }), base) >= 6, `eye ${eyeL}`);
  assert.ok(diff(sec.renderFrame(L, { expr: 'happy' }), base) > 4, 'ears perk when happy');
  assert.ok(diff(sec.renderFrame(L, { pose: 'bow' }), sec.renderFrame(L, { pose: 'clasp' })) > 20, 'bow: head down, ears flat');
  assert.ok(diff(sec.renderFrame(L, { twitch: 'L' }), base) > 2, 'ear twitch');
  assert.ok(diff(sec.renderFrame(L, { tail: 1 }), base) > 6, 'tail swish');
  assert.ok(diff(sec.renderFrame(L, { sparkle: 1 }), base) > 4, 'sparkle');
  assert.ok(diff(sec.renderFrame(L, { breath: 1 }), base) > 50, '1-px breathing');
});

import { dismissKey, visibleQueue, releasePlan, DismissStore, ceoList } from '../public/ceo.js';
test('돌려보내기: local dismissal hides only that occurrence (survives reload), a new occurrence comes back; bulk plan', () => {
  const mem = new Map(), storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const m = new Map();
  ceoStep(m, { ev: 'Stop', sid: 'S', ts: '2026-10-21T10:00:00Z' });                      // "보고 드렸어요" (no relay item)
  ceoStep(m, { ev: 'Notification', sid: 'S', aid: 'a1', ntype: 'idle_prompt', ts: '2026-10-21T10:00:05Z' });
  let list = ceoList(m, Date.parse('2026-10-21T10:01:00Z'));
  assert.equal(list.length, 2);
  const d = new DismissStore(storage);
  d.add(dismissKey(list[0]));
  assert.deepEqual(visibleQueue(list, d).map(q => q.key), ['S|a1']);
  const reloaded = new DismissStore(storage);                                              // a reload replays the same events
  assert.deepEqual(visibleQueue(ceoList(m, Date.now()), reloaded).map(q => q.key), ['S|a1'], 'still gone after reload');
  ceoStep(m, { ev: 'UserPromptSubmit', sid: 'S', ts: '2026-10-21T10:05:00Z' });
  ceoStep(m, { ev: 'Stop', sid: 'S', ts: '2026-10-21T10:09:00Z' });                        // a NEW report later
  assert.deepEqual(visibleQueue(ceoList(m, Date.now()), reloaded).map(q => q.key), ['S|main'], 'a new occurrence comes back');
  const broken = new DismissStore({ getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } });
  broken.add('x'); assert.ok(broken.has('x'), 'storage failures fall back to memory');
  const plan = releasePlan([{ key: 'S|main', since: 1 }, { key: 'S|a2', since: 2, relay: { status: 'pending', item: { id: 'r9' } } }, { key: 'S|a3', since: 3, relay: { status: 'answered', item: { id: 'r8' } } }]);
  assert.deepEqual(plan, [{ key: 'S|main', dkey: 'S|main|1', relayId: null }, { key: 'S|a2', dkey: 'S|a2|2', relayId: 'r9' }, { key: 'S|a3', dkey: 'S|a3|3', relayId: null }]);
  resetRelay();
  applyFrame({ type: 'ask', item: { id: 'r7', kind: 'permission', sid: 'S', tool: 'Bash', createdAt: 1 } });
  applyFrame({ type: 'resolved', id: 'r7', by: 'dashboard', reason: 'released' });
  assert.equal(relay.items.get('r7').status, 'released');
  assert.equal(decidedKey({ type: 'resolved', id: 'r7', by: 'dashboard', reason: 'released' }), 'S|main', 'a release sends the character back');
  assert.equal(mergeQueue([]).length, 0);
  resetRelay();
});

import { ceoSpots, CEO_PLAN } from '../public/ceo.js';
import { Ambient, coupleAt, PARK_SEGMENTS } from '../public/ambient.js';
test('대표실: the 대표 faces left from the right wall; the queue stands left of the desk and faces right', () => {
  const W = 134, P = CEO_PLAN, x = r => W - r;                         // r = distance from the right wall
  assert.equal(P.boss.face, 'left');
  assert.ok(x(P.desk.r1) < x(P.boss.r) && x(P.boss.r) < x(P.chair.r0), 'door … desk … 대표 … chair … right wall');
  const s = ceoSpots(2, W);
  assert.equal(s.length, 2);
  for (const sp of s) { assert.equal(sp.face, 'right'); assert.ok(x(sp.r) + 12 <= x(P.desk.r1), `spot ${sp.r} left of the desk`); }
  assert.ok(x(s[0].r) > x(s[1].r), 'the first in line stands closest to the desk');
  assert.equal(ceoSpots(9, W).length, 3, 'as many as fit between the door and the desk (+N for the rest)');
  assert.equal(ceoSpots(9, 400).length, 4, 'never more than 4');
  assert.ok(ceoSpots(9, 110).length < 3, 'a narrower room fits fewer');
  assert.deepEqual(ceoSpots(0, W), []);
});

test('night life: shooting stars and park couples only at night, never under reduced motion; timing and counts', () => {
  let seed = 7; const rng = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const run = (env, ms, opts = {}) => { const a = new Ambient({ rng, ...opts }); const seen = { stars: 0, maxCouples: 0, maxStars: 0, starGaps: [], visits: [] }; let last = null, lastEnd = null;
    for (let t = 0; t <= ms; t += 50) { a.step(t, env);
      if (a.star && a.star !== last) { seen.stars++; if (lastEnd != null) seen.starGaps.push(a.star.t0 - lastEnd); last = a.star; assert.ok(a.star.dur >= 600 && a.star.dur <= 1000); assert.ok(a.star.x1 < a.star.x0 && a.star.y1 > a.star.y0, 'diagonal, downwards'); }
      if (!a.star && last && lastEnd == null) lastEnd = t;
      if (!a.star && last) lastEnd = lastEnd ?? t;
      if (a.star) lastEnd = null;
      seen.maxCouples = Math.max(seen.maxCouples, a.couples.length);
      for (const c of a.couples) { if (!seen.visits.includes(c.dur)) seen.visits.push(c.dur); const p = coupleAt(c, t); assert.ok(p.x >= c.min && p.x <= c.max, 'stays on the park path'); }
    }
    return seen; };
  for (const sky of ['morning', 'day', 'evening']) { const s = run({ sky, reduced: false }, 300000); assert.equal(s.stars + s.maxCouples, 0, `${sky}: nothing`); }
  assert.equal(run({ sky: 'night', reduced: true }, 300000).stars, 0, 'reduced motion: no stars');
  assert.equal(run({ sky: 'night', reduced: true }, 300000).maxCouples, 0, 'reduced motion: no couples');
  const n = run({ sky: 'night', reduced: false }, 600000);
  assert.ok(n.stars >= 600000 / 26000 && n.stars <= 600000 / 8000 + 1, `stars in 10 min: ${n.stars}`);
  assert.ok(n.starGaps.every(g => g >= 7950 && g <= 25100), `gaps ${n.starGaps}`);
  assert.ok(n.maxCouples >= 1 && n.maxCouples <= 2, `couples at once: ${n.maxCouples}`);
  assert.ok(n.visits.every(d => d >= 8000 && d <= 20000));
  const f = new Ambient({ rng, force: 'star,couple' }); f.step(0, { sky: 'night', reduced: false }); f.step(300, { sky: 'night', reduced: false });
  assert.ok(f.star && f.couples.length === 1, '?fx=star,couple forces both at once');
  f.step(400, { sky: 'day', reduced: false }); assert.ok(!f.on, 'daylight clears them');
  const c = { t0: 0, dur: 15000, x0: 300, dir: 1, speed: 0.006, min: PARK_SEGMENTS[1][0], max: PARK_SEGMENTS[1][1], stop: { x: 322, len: 2000, kind: 'kiss' } };
  assert.equal(coupleAt(c, 0).alpha, 0, 'fades in');
  const at = (322 - 300) / 0.006;
  assert.deepEqual([coupleAt(c, at + 500).moment, coupleAt(c, at + 500).walking, coupleAt(c, at + 500).x], ['kiss', false, 322], 'stops under the lamp');
  assert.ok(coupleAt(c, at + 2500).walking && coupleAt(c, at + 2500).x > 322, 'then walks on');
});

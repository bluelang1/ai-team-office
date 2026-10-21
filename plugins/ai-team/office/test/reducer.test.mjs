import './home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reduce, reduceAll, tick, classify, compliance, parseLine, initState, T, family } from '../public/reducer.js';

const FIX = new URL('./fixtures/sample.jsonl', import.meta.url);
const lines = fs.readFileSync(FIX, 'utf8').split('\n').filter(Boolean);
const events = lines.map(parseLine).filter(Boolean);
const SID = '5f1e2d3c-7a6b-4c5d-9e8f-0a1b2c3d4e5f';
const LOOKUP = 'a0b024e14b34b9fca', REVIEWER = 'ac0de7e1e2e3e4e5f';
const room = s => s.floors.AI_Team.rooms[SID];
const at = sec => Date.parse('2026-10-21T05:00:00.000Z') + sec * 1000;
const iso = sec => new Date(at(sec)).toISOString();
/** Fold events with ts <= sec through reduce, then tick at that moment. */
const until = sec => tick(events.filter(e => Date.parse(e.ts) <= at(sec)).reduce(reduce, initState()), at(sec));

// Real lines from ~/.claude/logs (shape reference from the brief).
const REAL = [
  { ts: '2026-10-21T04:37:58.000Z', ev: 'PostToolUse', sid: '5b0c7e2a-1d3f-4e6a-9b8c-0d1e2f3a4b5c', proj: 'AI_Team', cwd: '/Users/x/Documents/AI_Team', tool: 'Bash', effort: 'high', mode: 'bypassPermissions', dur: 101, target: 'mkdir -p /Users/x/Documents/AI_Team/office' },
  { ts: '2026-10-21T04:37:59.000Z', ev: 'PostToolUse', sid: '5b0c7e2a-1d3f-4e6a-9b8c-0d1e2f3a4b5c', proj: 'AI_Team', aid: 'ae38e93fb3aa8ec5e', atype: 'general-purpose', tool: 'WebFetch', effort: 'medium', mode: 'bypassPermissions', dur: 4021, target: 'https://github.com/x/y' },
  { ts: '2026-10-21T04:38:00.000Z', ev: 'PreToolUse', sid: '5b0c7e2a-1d3f-4e6a-9b8c-0d1e2f3a4b5c', proj: 'AI_Team', tool: 'Agent', effort: 'high', sub: { type: 'lookup', model: 'haiku', effort: 'low', desc: '훅 페이로드 프로브용 조회', prompt: '다음을 순서대로...' } },
  { ts: '2026-10-21T04:38:00.000Z', ev: 'PostToolUse', sid: '5b0c7e2a-1d3f-4e6a-9b8c-0d1e2f3a4b5c', proj: 'AI_Team', tool: 'Agent', dur: 6, sub: { type: 'lookup', model: 'haiku', effort: 'low', desc: '훅 페이로드 프로브용 조회' }, child: 'a0b024e14b34b9fca', resolved: 'claude-haiku-5-5' },
  { ts: '2026-10-21T04:38:01.000Z', ev: 'SubagentStart', sid: '5b0c7e2a-1d3f-4e6a-9b8c-0d1e2f3a4b5c', proj: 'AI_Team', aid: 'a0b024e14b34b9fca', atype: 'lookup' },
  { ts: '2026-10-21T04:38:03.000Z', ev: 'SubagentStop', sid: '5b0c7e2a-1d3f-4e6a-9b8c-0d1e2f3a4b5c', proj: 'AI_Team', aid: 'a0b024e14b34b9fca', atype: 'lookup', effort: 'low', msg: '1) lookup.md 읽음: ...' },
  { ts: '2026-10-21T04:38:04Z', event: 'verdict', session_id: '5b0c7e2a-1d3f-4e6a-9b8c-0d1e2f3a4b5c', ref: 'a0b024e14b34b9fca', verdict: 'ok', note: '훅 검증' },
];

test('classify: tool and bash sub-classification', () => {
  assert.equal(classify('Read', '/a/b'), 'library');
  assert.equal(classify('WebFetch', 'https://x'), 'library');
  assert.equal(classify('Edit', '/a.js'), 'bench');
  assert.equal(classify('Agent', 'x'), 'meeting');
  assert.equal(classify('mcp__claude_ai_Slack__send', ''), 'external');
  assert.equal(classify('Bash', 'rg -n foo src'), 'library');
  assert.equal(classify('Bash', 'cd /x && cat a.txt | head'), 'library');
  assert.equal(classify('Bash', "sed -i '' s/a/b/ f"), 'bench');
  assert.equal(classify('Bash', 'echo hi > out.txt'), 'bench');
  assert.equal(classify('Bash', 'ls 2>/dev/null'), 'library');
  assert.equal(classify('Bash', 'curl -s https://x'), 'external');
  assert.equal(classify('Bash', 'gh pr list'), 'external');
  assert.equal(classify('Bash', 'git push origin main'), 'external');
  assert.equal(classify('Bash', 'git status'), 'library');
  assert.equal(classify('Bash', './gradlew test'), 'server');
  assert.equal(classify('Bash', 'FOO=1 npm test'), 'server');
  assert.equal(classify('Bash', 'mkdir -p /x'), 'bench');
  assert.equal(classify('Bash', 'cd /x && SP=/tmp; pkill -f node'), 'server', 'skips cd and bare assignments');
  assert.equal(classify(undefined, undefined), 'desk');
});

test('bad lines are ignored', () => {
  assert.equal(lines.length - events.length, 1, 'fixture has exactly one malformed line');
  const s0 = initState();
  for (const bad of [null, 42, 'str', [], {}, { ev: 'PreToolUse' }, { ev: 'PreToolUse', sid: 'x', ts: 'nope' }, { ts: iso(0), ev: 'Stop' }, { ts: iso(0), sid: 'x' }])
    assert.equal(reduce(s0, bad), s0);
  assert.equal(parseLine('{oops'), null);
  assert.equal(parseLine('[1,2]'), null);
  const s1 = reduceAll(s0, [null, { nope: 1 }, events[0]]);
  assert.equal(s1.stats.events, 1);
});

test('reduce is pure', () => {
  const s0 = initState();
  const snap = JSON.stringify(s0);
  const s1 = reduce(s0, events[1]);
  assert.notEqual(s1, s0);
  assert.equal(JSON.stringify(s0), snap);
  const s2 = tick(s1, at(100));
  assert.notEqual(s2, s1);
  assert.equal(room(s1).chars.main.act, 'running');
});

test('fixture: main Bash goes to the server room, then thinks after silence', () => {
  let s = until(0);
  assert.equal(room(s).chars.main.act, 'thinking');
  assert.equal(room(s).chars.main.obs, 'inferred');
  s = until(2);
  assert.equal(room(s).chars.main.room, 'server');
  assert.equal(room(s).chars.main.act, 'running');
  assert.equal(room(s).chars.main.target, 'npm test --prefix office');
  s = until(6);
  assert.equal(room(s).chars.main.room, 'server', 'within THINK_MS stays put');
  s = until(7.5);
  assert.equal(room(s).chars.main.room, 'server', 'only 1.5s quiet: not thinking yet');
  s = tick(until(6), at(6) + T.THINK_MS);       // no next PreToolUse for THINK_MS -> thinking at desk
  assert.equal(room(s).chars.main.act, 'thinking');
  assert.equal(room(s).chars.main.room, 'desk');
});

test('fixture: delegation -> meeting room, elevator arrival, library, leave with verdict', () => {
  let s = until(8);
  assert.equal(room(s).chars.main.room, 'meeting');
  assert.equal(room(s).chars.main.act, 'delegating');
  s = until(9);
  const kid = room(s).chars[LOOKUP];
  assert.equal(kid.room, 'elevator');
  assert.equal(kid.act, 'arriving');
  assert.equal(kid.model, 'haiku');
  assert.equal(kid.desk, 0);
  s = until(10);
  assert.equal(room(s).chars[LOOKUP].room, 'library');
  assert.equal(room(s).chars[LOOKUP].target.endsWith('DESIGN.md'), true);
  s = until(15);
  assert.equal(room(s).chars[LOOKUP].room, 'library', 'rg in Bash is reading');
  s = until(18);
  const gone = room(s).chars[LOOKUP];
  assert.equal(gone.act, 'leaving');
  assert.equal(gone.room, 'elevator');
  assert.deepEqual(gone.visits.map(v => v.room), ['elevator', 'library', 'elevator']);
  s = until(18 + T.LEAVE_MS / 1000 + 1);
  assert.equal(room(s).chars[LOOKUP], undefined, 'removed after leave animation');
  assert.equal(room(s).desks[0] === LOOKUP, false, 'desk freed');
  s = until(22);
  assert.equal(s.verdicts[LOOKUP].v, 'ok');
});

test('fixture: code-reviewer works in the review room and gets a rework stamp', () => {
  let s = until(23);
  assert.equal(room(s).chars[REVIEWER].room, 'review');
  assert.equal(room(s).chars[REVIEWER].act, 'reviewing');
  s = until(25);
  assert.equal(room(s).chars[REVIEWER].room, 'review', 'reviewer Bash stays in review');
  s = until(30);
  assert.equal(room(s).chars.main.room, 'bench');
  s = until(36);
  assert.equal(room(s).chars[REVIEWER].act, 'leaving');
  assert.equal(room(s).chars[REVIEWER].verdict, null, 'verdict not known yet at 36s');
  s = until(38);
  assert.equal(room(s).chars[REVIEWER].verdict, 'rework', 'stamp arrives while still walking out');
});

test('fixture: permission blocks with hand raised, cleared by the next tool event', () => {
  let s = until(40);
  assert.equal(room(s).chars.main.blocked, true);
  assert.equal(room(s).chars.main.act, 'blocked');
  assert.equal(room(s).chars.main.room, 'desk');
  s = until(45);
  assert.equal(room(s).chars.main.blocked, true, 'blocked is not overridden by thinking timer');
  s = until(47);
  assert.equal(room(s).chars.main.blocked, false);
  assert.equal(room(s).chars.main.flash, true);
  assert.equal(room(s).chars.main.failCount, 1);
  s = until(47 + T.FAIL_MS / 1000 + 0.5);
  assert.equal(room(s).chars.main.flash, false);
  s = until(50);
  assert.equal(room(s).chars.main.room, 'external', 'curl goes to 외부창구');
  s = until(60);
  assert.equal(room(s).chars.main.act, 'idle');
  assert.equal(s.stats.permissions, 2);
});

test('compliance: intended vs resolved ✓/✗, direct vs delegated, verdicts, rework rate', () => {
  const c = compliance(until(60));
  assert.equal(c.rows.length, 2);
  assert.equal(c.rows[0].match, 'yes');      // haiku -> claude-haiku-5-5
  assert.equal(c.rows[1].match, 'no');       // opus  -> claude-sonnet-5-5
  assert.equal(c.rows[0].durMs, 10000);      // 8s Pre -> 18s SubagentStop
  assert.equal(c.yes, 1); assert.equal(c.no, 1); assert.equal(c.matchRate, 0.5);
  assert.equal(c.delegated, 2);
  assert.equal(c.direct, 6);                 // Bash npm, Read, Edit, Bash push, Bash curl, Write
  assert.deepEqual(c.verdicts, { ok: 1, rework: 1, fail: 0 });
  assert.equal(c.byModel.haiku.reworkRate, 0);
  assert.equal(c.byModel.sonnet.reworkRate, 1);
  assert.equal(c.byModel.haiku.avgMs, 10000);
});

test('compliance: unspecified model resolving to fable is ✗, pending until Post', () => {
  const base = { sid: 's1', proj: 'P' };
  let s = reduce(initState(), { ...base, ts: iso(0), ev: 'PreToolUse', tool: 'Agent', sub: { type: 'Explore', desc: 'd' } });
  assert.equal(compliance(s).rows[0].match, 'pending');
  s = reduce(s, { ...base, ts: iso(1), ev: 'PostToolUse', tool: 'Agent', sub: { type: 'Explore', desc: 'd' }, child: 'k1', resolved: 'claude-fable-5' });
  assert.equal(compliance(s).rows[0].match, 'no');
  assert.equal(family('claude-opus-5-5'), 'opus');
});

test('real sample lines: lazy subagent, model from Post, verdict stamp, main has no aid', () => {
  let s = initState();
  for (const e of REAL.slice(0, 5)) s = reduce(s, e);
  const r = s.floors.AI_Team.rooms['5b0c7e2a-1d3f-4e6a-9b8c-0d1e2f3a4b5c'];
  assert.ok(r.chars.main && r.chars.main.aid === null);
  assert.equal(r.chars.ae38e93fb3aa8ec5e.atype, 'general-purpose', 'created lazily from a PostToolUse');
  assert.equal(r.chars.a0b024e14b34b9fca.model, 'haiku');
  s = reduce(s, REAL[5]);
  s = reduce(s, REAL[6]);
  const k = s.floors.AI_Team.rooms['5b0c7e2a-1d3f-4e6a-9b8c-0d1e2f3a4b5c'].chars.a0b024e14b34b9fca;
  assert.equal(k.act, 'leaving'); assert.equal(k.verdict, 'ok');
  assert.equal(compliance(s).rows[0].match, 'yes');
});

test('stuck after 60s on one tool, dozing after 3min, stale after 5min', () => {
  const base = { sid: 's2', proj: 'P' };
  let s = reduce(initState(), { ...base, ts: iso(0), ev: 'PreToolUse', tool: 'Bash', target: './gradlew test' });
  assert.equal(tick(s, at(59)).floors.P.rooms.s2.chars.main.stuck, false);
  const c = tick(s, at(61)).floors.P.rooms.s2.chars.main;
  assert.equal(c.stuck, true); assert.equal(c.room, 'server');
  assert.equal(tick(s, at(179)).floors.P.rooms.s2.chars.main.dozing, false);
  assert.equal(tick(s, at(181)).floors.P.rooms.s2.chars.main.dozing, true);
  assert.equal(tick(s, at(299)).floors.P.rooms.s2.chars.main.obs, 'observed');
  assert.equal(tick(s, at(301)).floors.P.rooms.s2.chars.main.obs, 'stale');
  s = reduce(s, { ...base, ts: iso(400), ev: 'PostToolUse', tool: 'Bash' });
  assert.equal(tick(s, at(400)).floors.P.rooms.s2.chars.main.obs, 'observed', 'fresh event clears stale');
});

test('late (out-of-order) lines count but never move a character backwards', () => {
  const base = { sid: 's3', proj: 'P' };
  let s = reduce(initState(), { ...base, ts: iso(10), ev: 'PreToolUse', tool: 'Edit', target: '/a.js' });
  s = reduce(s, { ...base, ts: iso(9), ev: 'PreToolUse', tool: 'Read', target: '/b.js' });
  assert.equal(s.floors.P.rooms.s3.chars.main.room, 'bench');
  assert.equal(s.stats.direct, 2);
});

test('sessions are floors by proj and rooms by sid; desks fill and free', () => {
  let s = initState();
  for (let i = 0; i < 7; i++) s = reduce(s, { ts: iso(i), ev: 'SubagentStart', sid: 'sx', proj: 'Q', aid: `agent${i}xxxx`, atype: 'Explore' });
  s = reduce(s, { ts: iso(1), ev: 'Stop', sid: 'sy', proj: 'R' });
  assert.deepEqual(Object.keys(s.floors).sort(), ['Q', 'R']);
  const r = s.floors.Q.rooms.sx;
  assert.equal(r.desks.filter(Boolean).length, 6);
  assert.equal(r.chars.agent6xxxx.desk, null, 'seventh agent has no desk');
  s = reduce(s, { ts: iso(8), ev: 'SubagentStop', sid: 'sx', proj: 'Q', aid: 'agent0xxxx' });
  s = tick(s, at(8) + T.LEAVE_MS + 1);
  assert.equal(s.floors.Q.rooms.sx.desks[0], null);
});

// ---------- review fixes ----------
const ch = (s, sid, key) => s.floors.P?.rooms[sid]?.chars[key];

test('norm: non-string fields never throw; identity fields coerced or the event dropped', () => {
  const b = { sid: 'n1', proj: 'P' };
  let s = initState();
  s = reduce(s, { ...b, ts: iso(0), ev: 'PreToolUse', tool: 123, target: { cmd: 'x'.repeat(300) } });
  const m = ch(s, 'n1', 'main');
  assert.equal(m.tool, '123'); assert.equal(m.room, 'desk');
  assert.equal(typeof m.target, 'string'); assert.equal(m.target.length, 120);
  s = reduce(s, { ...b, ts: iso(1), ev: 'PreToolUse', aid: 123, atype: 7, tool: 'Read', target: '/a' });
  assert.equal(ch(s, 'n1', '123').atype, '7');
  s = reduce(s, { ts: iso(2), event: 'verdict', ref: 123, verdict: 'ok' });
  assert.equal(s.verdicts['123'].v, 'ok');
  s = reduce(s, { ...b, ts: iso(3), ev: 'PreToolUse', tool: 'Bash', target: ['rm', '-rf'] });
  assert.equal(ch(s, 'n1', 'main').target, '["rm","-rf"]');
  s = reduce(s, { ...b, ts: iso(4), ev: 'PreToolUse', tool: 'Agent', sub: 'oops' });
  assert.equal(s.deleg.at(-1).type, 'general-purpose');
  s = reduce(s, { ...b, ts: iso(5), ev: 'PostToolUse', tool: 'Read', dur: 'slow', msg: { a: 1 } });
  for (const bad of [{ ...b, ts: iso(6), ev: { x: 1 } }, { ...b, ts: iso(6), ev: 'Stop', sid: { x: 1 } },
    { ...b, ts: iso(6), ev: 'Stop', aid: ['a'] }, { ts: iso(6), event: 'verdict', ref: { x: 1 }, verdict: 'ok' }])
    assert.equal(reduce(s, bad), s, JSON.stringify(bad));
  assert.doesNotThrow(() => reduceAll(s, [{ ...b, ts: iso(7), ev: 'PreToolUse', tool: null, target: 5 }, { ...b, ts: iso(8), ev: 'Stop', sid: 9 }]));
  assert.equal(classify(123, {}), 'desk');
  assert.equal(classify('Bash', { a: 1 }), 'server');
  assert.equal(classify('Bash', 42), 'server');
});

test('late SubagentStop (whole-second ts) still sends the character home', () => {
  const b = { sid: 'l1', proj: 'P', aid: 'a1zzzz', atype: 'lookup' };
  let s = reduce(initState(), { ...b, ts: iso(10), ev: 'PreToolUse', tool: 'Read', target: '/x' });
  s = reduce(s, { ...b, ts: iso(9), ev: 'SubagentStop', msg: 'done' });
  const c = ch(s, 'l1', 'a1zzzz');
  assert.equal(c.act, 'leaving'); assert.equal(c.room, 'elevator'); assert.equal(c.leaveAt, at(10));
  s = tick(s, at(10) + T.LEAVE_MS + 1);
  assert.equal(ch(s, 'l1', 'a1zzzz'), undefined);
  assert.equal(s.floors.P.rooms.l1.desks.includes('a1zzzz'), false);
  // ...but a late tool line still never moves a room backwards
  s = reduce(initState(), { ...b, ts: iso(10), ev: 'PreToolUse', tool: 'Edit', target: '/a' });
  s = reduce(s, { ...b, ts: iso(9), ev: 'PreToolUse', tool: 'Read', target: '/b' });
  assert.equal(ch(s, 'l1', 'a1zzzz').room, 'bench');
});

test('subagent without SubagentStop goes home after 5 min idle (10 min inside a tool)', () => {
  const b = { sid: 'h1', proj: 'P', atype: 'Explore' };
  let s = reduce(initState(), { ...b, aid: 'a1home', ts: iso(0), ev: 'SubagentStart' });
  s = reduce(s, { ...b, aid: 'a1home', ts: iso(1), ev: 'PostToolUse', tool: 'Read' });
  s = reduce(s, { ...b, aid: 'a2tool', ts: iso(1), ev: 'PreToolUse', tool: 'Bash', target: './gradlew test' });
  assert.equal(s.floors.P.rooms.h1.desks[0], 'a1home');
  const s5 = tick(s, at(1) + T.HOME_MS + 1000);
  assert.equal(ch(s5, 'h1', 'a1home').act, 'leaving', 'walks to the elevator');
  assert.equal(s5.ticker[0].kind, 'home');
  const s6 = tick(s, at(6 * 60));
  assert.equal(ch(s6, 'h1', 'a1home'), undefined, 'gone after +6min');
  assert.equal(s6.floors.P.rooms.h1.desks[0], null, 'desk freed');
  assert.equal(ch(s6, 'h1', 'a2tool').act, 'running', 'a long tool call is not idle yet');
  assert.equal(ch(tick(s, at(11 * 60)), 'h1', 'a2tool'), undefined);
});

test('main waiting on a synchronous Agent call is 위임 대기, not stuck/dozing/stale', () => {
  const b = { sid: 'w1', proj: 'P' };
  let s = reduce(initState(), { ...b, ts: iso(0), ev: 'PreToolUse', tool: 'Agent', sub: { type: 'Explore', desc: 'd' } });
  assert.equal(ch(tick(s, at(30)), 'w1', 'main').label, null);
  let m = ch(tick(s, at(61)), 'w1', 'main');
  assert.equal(m.stuck, false); assert.equal(m.label, '위임 대기'); assert.equal(m.act, 'delegating');
  m = ch(tick(s, at(400)), 'w1', 'main');
  assert.equal(m.dozing, false); assert.equal(m.obs, 'observed');
  m = ch(tick(s, at(601) + T.PENDING_MS), 'w1', 'main');
  assert.equal(m.stuck, true, 'after the pending row expires the wait is no longer trusted');
  s = reduce(s, { ...b, ts: iso(90), ev: 'PostToolUse', tool: 'Agent', sub: { desc: 'd' }, child: 'k1', resolved: 'claude-opus-5-5' });
  m = ch(tick(s, at(95)), 'w1', 'main');
  assert.equal(m.label, null); assert.equal(m.act, 'thinking');
});

test('Agent pairing: Failure closes pending, expiry, FIFO by desc, tuid preferred', () => {
  const b = { sid: 'p1', proj: 'P' };
  const pre = (sec, desc, extra = {}) => ({ ...b, ts: iso(sec), ev: 'PreToolUse', tool: 'Agent', sub: { type: 'lookup', model: 'haiku', desc }, ...extra });
  const post = (sec, desc, child, extra = {}) => ({ ...b, ts: iso(sec), ev: 'PostToolUse', tool: 'Agent', sub: { desc }, child, resolved: 'claude-haiku-5-5', ...extra });
  let s = reduceAll(initState(), [pre(0, 'd'), { ...b, ts: iso(1), ev: 'PostToolUseFailure', tool: 'Agent', sub: { desc: 'd' } }, pre(2, 'd'), post(3, 'd', 'k2')]);
  assert.deepEqual(s.deleg.map(d => [d.status, d.child]), [['failed', null], ['done', 'k2']]);
  assert.deepEqual(compliance(s).rows.map(r => r.match), ['failed', 'yes']);
  s = reduceAll(initState(), [pre(0, 'd'), pre(700, 'd'), post(701, 'd', 'k2')]);
  assert.deepEqual(s.deleg.map(d => [d.status, d.child]), [['expired', null], ['done', 'k2']]);
  assert.equal(tick(reduce(initState(), pre(0, 'x')), at(601)).deleg[0].status, 'expired');
  s = reduceAll(initState(), [pre(0, 'a'), pre(1, 'b'), post(2, 'b', 'kb'), post(3, 'a', 'ka')]);
  assert.deepEqual(s.deleg.map(d => d.child), ['ka', 'kb'], 'desc must match; no cross-desc fallback');
  s = reduceAll(initState(), [pre(0, 'd', { tuid: 't1' }), pre(1, 'd', { tuid: 't2' }), post(2, 'd', 'k2', { tuid: 't2' })]);
  assert.deepEqual(s.deleg.map(d => [d.tuid, d.status, d.child]), [['t1', 'pending', null], ['t2', 'done', 'k2']]);
  s = reduce(s, { ...b, ts: iso(3), ev: 'PostToolUseFailure', tool: 'Agent', sub: { desc: 'd' }, tuid: 't1' });
  assert.equal(s.deleg[0].status, 'failed');
});

test('ticker durations are seconds like the rest of the UI', () => {
  const b = { sid: 'd1', proj: 'P', ev: 'PostToolUse', tool: 'Read' };
  assert.equal(reduce(initState(), { ...b, ts: iso(0), dur: 11 }).ticker[0].text, 'Read 완료 0.0초');
  assert.equal(reduce(initState(), { ...b, ts: iso(0), dur: 4021 }).ticker[0].text, 'Read 완료 4.0초');
});

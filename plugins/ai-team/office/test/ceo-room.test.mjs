// 대표실: the 실장's final report (hook -> queue -> card text), no empty-state note, the 대표 seated in his executive chair.
import './home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ceoStep, ceoList, ceoResolve, ceoExpire, reportText, releasePlan, CEO_PLAN, LOW, visibleQueue, DismissStore } from '../public/ceo.js';
import { applyFrame, mergeQueue, decidedKey, resetRelay, staleBoot } from '../public/ceocard.js';
import { drawChar, EXEC, SW, SH } from '../public/sprites.js';
import { redact } from '../server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = f => fs.readFileSync(path.join(here, '..', 'public', f), 'utf8');
const HOOK = path.join(here, '..', '..', 'hooks', 'office-events.sh');
const hasJq = spawnSync('jq', ['--version']).status === 0;

test('office-events.sh: Stop/SubagentStop keep the report up to 4000 chars, other events 300', { skip: !hasJq && 'jq not installed' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hook-'));
  try {
    const run = o => assert.equal(spawnSync('bash', [HOOK], { input: JSON.stringify(o), env: { ...process.env, HOME: home } }).status, 0);
    run({ hook_event_name: 'Stop', session_id: 's', cwd: '/x/p', last_assistant_message: '가'.repeat(5000) });
    run({ hook_event_name: 'SubagentStop', session_id: 's', agent_id: 'a1', cwd: '/x/p', last_assistant_message: 'line 1\nline 2' });
    run({ hook_event_name: 'Notification', session_id: 's', cwd: '/x/p', message: 'n'.repeat(500), notification_type: 'idle_prompt' });
    const rows = fs.readFileSync(path.join(home, '.claude', 'logs', 'office-events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(rows[0].msg.length, 4001, 'Stop: 4000 chars + …');
    assert.equal(rows[1].msg, 'line 1\nline 2', 'SubagentStop: line breaks survive');
    assert.equal(rows[2].msg.length, 301, 'Notification stays at 300 + …');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('report: Stop carries the final message into the queue entry; --redact drops it; display cleanup keeps lines', () => {
  const long = `첫 줄\n\n${'x'.repeat(5000)}`;
  const m = new Map();
  ceoStep(m, { ev: 'Stop', sid: 'S', ts: '2026-10-21T10:00:00Z', msg: long });
  const q = ceoList(m, Date.parse('2026-10-21T10:00:05Z'))[0];
  assert.equal(q.kind, 'report'); assert.equal(q.prio, LOW);
  assert.equal(q.text, '보고 드렸어요', 'the bubble stays short');
  assert.ok(q.body.startsWith('첫 줄\n\n') && q.body.length <= 4001, 'body keeps line breaks, capped');
  const r = new Map();
  ceoStep(r, redact({ ev: 'Stop', sid: 'S', ts: '2026-10-21T10:00:00Z', msg: 'secret report' }));
  assert.equal([...r.values()][0].body, undefined, 'under --redact the server already dropped msg: no body');
  ceoStep(m, { ev: 'Notification', sid: 'S', aid: 'a', ntype: 'idle_prompt', msg: '입력을 기다려요', ts: '2026-10-21T10:00:01Z' });
  assert.equal(m.get('S|a').body, undefined, 'notification cards keep their own text only');

  const md = '# 제목\n\n\n\n**굵게** 와 `code`\n- 하나\n  * 둘\n1. 셋\n```js\nconst a = 1;\n```\n<b>tag</b>\n\n';
  assert.equal(reportText(md), '제목\n\n굵게 와 code\n• 하나\n  • 둘\n1. 셋\nconst a = 1;\n<b>tag</b>');
  assert.equal(reportText(null), '');
});

test('대표실: no empty-state note in markup, styles or renderer; the line empties through answer, release and 모두 돌려보내기', () => {
  for (const f of ['index.html', 'app.js', 'style.css']) {
    const src = pub(f);
    assert.equal(/ceo-empty|요청이 없어요/.test(src), false, `${f} has no "대표님께 온 요청이 없어요" note`);
  }
  resetRelay();
  const m = new Map(), ts = n => `2026-10-21T10:00:0${n}Z`;
  ceoStep(m, { ev: 'Stop', sid: 'S', ts: ts(1), msg: '보고' });
  ceoStep(m, { ev: 'PreToolUse', sid: 'S', aid: 'a1', tool: 'AskUserQuestion', ask: '할까요?', ts: ts(2) });
  ceoStep(m, { ev: 'PermissionRequest', sid: 'T', tool: 'Bash', target: 'ls', ts: ts(3) });
  applyFrame({ type: 'ask', item: { id: 'r1', kind: 'permission', sid: 'T', tool: 'Bash', target: 'ls', createdAt: 3 } });
  assert.equal(mergeQueue(ceoList(m, 0)).length, 3);
  applyFrame({ type: 'answered', id: 'r1', by: 'dashboard' });                       // answered in the 대표실
  ceoResolve(m, decidedKey({ type: 'answered', id: 'r1', by: 'dashboard' }));
  assert.equal(mergeQueue(ceoList(m, 0)).length, 2);
  for (const p of releasePlan(mergeQueue(ceoList(m, 0)))) ceoResolve(m, p.key);     // 모두 돌려보내기
  assert.deepEqual(mergeQueue(ceoList(m, 0)), [], 'nobody left in line (and nothing else to render)');
  resetRelay();
});

// Records fillRect calls in painter units (the sprite canvas adds a 4px side / 8px top margin).
function recorder() {
  const calls = [];
  const ctx = { fillStyle: '', fillRect(x, y, w, h) { calls.push({ x: x - 4, y: y - 8, w, h, c: this.fillStyle }); },
    getImageData: () => ({ data: new Uint8ClampedArray(SW * SH * 4) }) };
  return { ctx, calls };
}
test('대표 in the executive chair: backrest behind him, armrest in front, hips on the seat, desk right at his knees', () => {
  const { ctx, calls } = recorder();
  drawChar(ctx, { look: 'ceo', view: 'side', pose: 'sit', seat: 'exec', frame: 0 });
  const E = EXEC, idx = pred => calls.findIndex(pred);
  const back = idx(c => c.x === E.backX[0] && c.w === E.backX[1] - E.backX[0] + 1 && c.h >= 12);
  const torso = idx(c => c.x === E.torsoX && c.w === 6 && c.h === 8 && c.c === '#2c3e70');
  const thigh = idx(c => c.x === E.torsoX && c.y === E.thighY[0] && c.w === E.knee - E.torsoX + 1);
  const arm = idx(c => c.y === 11 && c.w === 7 && c.h === 2 && c.x === 3);
  const hand = idx(c => c.x === E.hand[0] && c.c === '#f2c6a0');
  assert.ok(back >= 0 && torso > back, 'the backrest is drawn first (behind his body)');
  assert.ok(arm > torso && arm > thigh, 'the armrest is drawn over his body (in front)');
  assert.ok(hand > arm, 'his arm rests on the armrest, reaching forward');
  assert.equal(E.backX[1] + 1, E.torsoX, 'back against the backrest: no gap');
  assert.equal(E.thighY[1] + 1, E.seatY, 'hips on the seat');
  assert.equal(E.backY[0] <= -2, true, 'high back: up to his head');
  const empty = recorder();
  drawChar(empty.ctx, { look: 'ceo', view: 'side', pose: 'sit', seat: 'exec', empty: true });
  assert.equal(empty.calls.some(c => c.c === '#2c3e70'), false, 'away: the chair stays, the 대표 is gone');

  // world units: canvas right edge at r 1, painter x -> r 5 + x (mirrored to face the door)
  const P = CEO_PLAN, r = x => 5 + x;
  assert.equal(P.chair.r0, r(E.backX[0]));
  assert.equal(P.boss.knee, r(E.knee) + 1, 'knee edge');
  assert.ok(P.desk.r0 - P.boss.knee <= 1, 'the desk edge is right in front of his knees');
  assert.ok(r(E.hand[0]) >= P.desk.r0, 'his hands are over the desk, not in the air');
  const css = pub('style.css');
  assert.match(css, /\.ceo-boss \{[^}]*right: calc\(1px \* var\(--s\)\)/, 'CSS places the canvas where the plan says');
  assert.match(css, new RegExp(`\\.ceo-desk \\{[^}]*right: calc\\(${P.desk.r0}px \\* var\\(--s\\)\\); [^}]*width: calc\\(${P.desk.r1 - P.desk.r0}px`), 'CSS desk matches the plan');
  assert.equal(/ceo-chair/.test(pub('index.html') + css), false, 'the old detached chair is gone');
});

test('돌려보내기 survives a reconnect: the replayed history keeps a sent-back report gone; a NEW occurrence still shows', () => {
  const mem = new Map(), storage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const history = [
    { ev: 'Stop', sid: 'S', ts: '2026-10-21T10:00:00Z', msg: '보고 1' },
    { ev: 'PreToolUse', sid: 'S', aid: 'a1', tool: 'AskUserQuestion', ask: '할까요?', ts: '2026-10-21T10:00:05Z' },
  ];
  const fold = evs => { const m = new Map(); for (const e of evs) ceoStep(m, e); return m; };
  const shown = (m, d) => visibleQueue(mergeQueue(ceoList(m, 0)), d).map(q => q.key);    // what app.js frame() renders
  resetRelay();
  const d = new DismissStore(storage);
  const live = fold(history);
  for (const p of releasePlan(mergeQueue(ceoList(live, 0)))) { d.add(p.dkey); ceoResolve(live, p.key); }   // 모두 돌려보내기
  assert.deepEqual(shown(live, d), []);
  const replay = fold(history);                                     // SSE reconnect: resetView() + the same history again
  assert.equal(ceoList(replay, 0).length, 2, 'the fold alone would bring both back');
  assert.deepEqual(shown(replay, new DismissStore(storage)), [], 'dismissed occurrences stay gone after the replay');
  const later = fold([...history, { ev: 'UserPromptSubmit', sid: 'S', ts: '2026-10-21T10:01:00Z' }, { ev: 'Stop', sid: 'S', ts: '2026-10-21T10:05:00Z', msg: '보고 2' }]);
  assert.deepEqual(shown(later, new DismissStore(storage)), ['S|main'], 'a genuinely new report appears');
  assert.match(fs.readFileSync(path.join(here, '..', 'public', 'app.js'), 'utf8'), /lastList = visibleQueue\(mergeQueue\(/, 'app.js renders the filtered line');
});

test('office-events.sh: null / non-string msg bounded, invalid JSON logs nothing; the hook never writes to stdout', { skip: !hasJq && 'jq not installed' }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-hook-'));
  try {
    const run = input => { const r = spawnSync('bash', [HOOK], { input, env: { ...process.env, HOME: home } }); assert.equal(r.status, 0); assert.equal(r.stdout.length, 0, 'no stdout (a hook decision channel)'); };
    const log = () => { try { return fs.readFileSync(path.join(home, '.claude', 'logs', 'office-events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
    run('{not json');
    assert.equal(log().length, 0, 'invalid JSON: nothing logged');
    run(JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd: '/x/p', last_assistant_message: null }));
    run(JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd: '/x/p', last_assistant_message: { big: 'y'.repeat(9000) } }));
    run(JSON.stringify({ hook_event_name: 'Notification', session_id: 's', cwd: '/x/p', message: ['z'.repeat(900)] }));
    const [nul, obj, arr] = log();
    assert.equal('msg' in nul, false, 'null msg is omitted');
    assert.equal(typeof obj.msg, 'string'); assert.ok(obj.msg.length <= 4000, 'object msg bounded (Stop limit)');
    assert.ok(arr.msg.length <= 300, 'array msg bounded (300)');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('report block: log text reaches the DOM only through esc(); character card has no per-second innerHTML churn', () => {
  const app = pub('app.js');
  const fn = app.slice(app.indexOf('function reportHTML'), app.indexOf('const popReport'));
  assert.match(fn, /\$\{esc\(t\)\}<\/div>/, 'the report body is escaped');
  assert.equal(/\$\{(?!esc\()[^}]*\b(t|body)\b[^}]*\}/.test(fn.replace(/reportText\(body\)/, '')), false, 'no unescaped interpolation of the text');
  assert.doesNotMatch(app, /<dt>경과<\/dt><dd>\$\{fmtDur/, '경과 is a live span, not part of the card HTML');
  assert.match(app, /<dt>경과<\/dt><dd class="live-elapsed"><\/dd>/);
  assert.match(app, /el\._rep === repBody \?/, 'scroll position kept only for the same report');
});

test('idle_prompt after a Stop keeps the report body (no overwrite)', () => {
  const m = new Map();
  ceoStep(m, { ev: 'Stop', sid: 'R', msg: '## 결과\n- 완료했어요', ts: '2026-10-21T10:00:00Z' });
  ceoStep(m, { ev: 'Notification', sid: 'R', ntype: 'idle_prompt', msg: 'Claude is waiting for your input', ts: '2026-10-21T10:01:00Z' });
  const [q] = ceoList(m, Date.parse('2026-10-21T10:01:00Z'));
  assert.equal(q.kind, 'report'); assert.equal(q.body, '## 결과\n- 완료했어요');
  ceoStep(m, { ev: 'Notification', sid: 'R', ntype: 'permission_prompt', ts: '2026-10-21T10:01:01Z' });
  assert.equal(ceoList(m, 0)[0].kind, 'notify', 'a permission prompt still takes over');
});

test('idle_prompt alone is a LOW courtesy that expires (not "답이 필요해요")', () => {
  const m = new Map();
  ceoStep(m, { ev: 'Notification', sid: 'I', ntype: 'idle_prompt', msg: 'Claude is waiting for your input', ts: '2026-10-21T10:00:00Z' });
  const [q] = ceoList(m, 0);
  assert.equal(q.kind, 'idle'); assert.equal(q.prio, LOW); assert.equal(q.text, '입력을 기다리고 있어요');
  assert.deepEqual(ceoExpire(m, Date.parse('2026-10-21T10:01:31Z')), ['I|main']);
});

test('staleBoot: reload only when both boot ids are known and differ', () => {
  assert.equal(staleBoot('aaaa', 'bbbb'), true, 'server restarted under an open page');
  assert.equal(staleBoot('aaaa', 'aaaa'), false);
  for (const [a, b] of [[undefined, 'bbbb'], ['aaaa', undefined], ['', 'bbbb'], ['aaaa', 7], [null, null]])
    assert.equal(staleBoot(a, b), false, `no reload for ${JSON.stringify([a, b])}`);
});

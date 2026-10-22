// 대표실 reports that ask the 대표 something (reportAsks / reportDecision) and the 크게 보기 drawer's pure helpers.
import './home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ceoStep, ceoList, ceoExpire, reportAsks, reportDecision, reportBlocks, reportText, linkParts, readerSame, ASK_MAX_MS, LOW, HIGH,
  ceoTable, nextSort, rowKind, rowText, ceoMore, ceoGroupPlan, groupTip, groupEntry, ceoSpots, pruneSel, selectRows, selectRange, selState, selHigh, selHidden, selEntries, dismissKey } from '../public/ceo.js';
import { onRelayClick, onRelayInput, relayHTML, applyFrame, resetRelay, relay, mergeQueue, INSTRUCT_CHIPS, whyNoButtons, instructOff } from '../public/ceocard.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = f => fs.readFileSync(path.join(here, '..', 'public', f), 'utf8');
const T0 = Date.parse('2026-10-22T10:00:00Z');
const ts = ms => new Date(T0 + ms).toISOString();

test('reportAsks: questions and decision requests near the end of the report', () => {
  for (const body of [
    '다 끝났어요.\n배포할까요?',
    '정리했어요\n\n다음 결정: PR #23을 머지할지 정해 주세요.',
    '- 한 일: 테스트\n- **다음 결정**: 오늘 배포 여부',
    '** 다음 결정 ** — 롤백 여부',
    '끝\n어느 쪽으로 갈지 알려주세요.',
    '보고\n운영 반영은 대표님이 승인해 주셔야 해요.',
    '보고\n이대로 진행해도 될까요',
    '완료했어요\n괜찮으세요？',
    '요약\n둘 중 하나로 결정해 주세요.',
    '다음 결정: 없음 — push 만 승인해 주시면 돼요',
    '다음 결정 - 롤백 여부',
  ]) assert.equal(reportAsks(body), true, JSON.stringify(body));
});

test('reportAsks: plain reports, "다음 결정: 없음", and questions far from the end do not ask', () => {
  for (const body of [
    '', null, undefined, 42,
    '테스트 통과했어요. PR 올렸어요.',
    '한 일: 정리\n다음 결정: 없음',
    '- 다음 결정: 없어요.',
    '다음 결정 -',
    '다음 결정: 해당 없음',
    '다음 결정: 없음 (다음 티켓 진행)',
    '다음 결정: 없음, 끝',
    '다음 결정: N/A',
    '다음 결정: none for now',
    '끝났어요\n```js\nconst ok = a ? b : c?\nif (x) return y?\n```',
    '끝났어요\n```\n미닫힌 펜스 안 질문?',
    '검색 링크: https://x.test/search?',
    '- 결과: https://x.test/search?q=1&next?',
    '브라우저에서 확인해 주세요.',
    `사용자가 "왜 느릴까요?" 라고 물었어요.\n${['a', 'b', 'c', 'd', 'e', 'f'].map(x => `- ${x} 완료`).join('\n')}`,
  ]) assert.equal(reportAsks(body), false, JSON.stringify(body));
});

test('reportDecision: returns the asking lines without list / bold marks, in order', () => {
  const body = '## 결과\n- 테스트 통과\n\n**다음 결정**: PR #23을 머지할지 정해 주세요.\n- 그리고 배포는 내일 할까요?';
  assert.deepEqual(reportDecision(body), ['다음 결정: PR #23을 머지할지 정해 주세요.', '그리고 배포는 내일 할까요?']);
  assert.deepEqual(reportDecision('끝났어요'), []);
});

test('Stop that asks: LOW, asks:true, "결정을 기다려요", no 90s expiry; resolved by the next prompt', () => {
  const m = new Map();
  ceoStep(m, { ev: 'Stop', sid: 'A', ts: ts(0), msg: '정리 끝.\n다음 결정: PR #23을 머지할지 정해 주세요.' });
  ceoStep(m, { ev: 'Stop', sid: 'P', ts: ts(0), msg: '정리 끝. 다 했어요.' });
  const a = m.get('A|main'), p = m.get('P|main');
  assert.equal(a.kind, 'report'); assert.equal(a.prio, LOW, 'stays LOW (no bell, no "답이 필요해요")');
  assert.equal(a.asks, true); assert.equal(a.text, '결정을 기다려요');
  assert.equal(p.asks, undefined); assert.equal(p.text, '보고 드렸어요');

  ceoStep(m, { ev: 'Notification', sid: 'A', ntype: 'idle_prompt', ts: ts(60000) });
  assert.equal(m.get('A|main').asks, true, 'the idle ping after Stop keeps the asking report');
  assert.deepEqual(ceoExpire(m, T0 + 270000), ['P|main'], 'after 4.5 min only the plain report expired');
  assert.deepEqual(ceoList(m, T0 + 270000).map(q => q.key), ['A|main']);
  assert.deepEqual(ceoExpire(m, T0 + 2 * 3600000), [], 'asks entries outlast the 90s courtesy (until the 3h cap)');

  ceoStep(m, { ev: 'UserPromptSubmit', sid: 'A', ts: ts(280000), prompt: '머지해' });
  assert.equal(m.size, 0, 'the answer (next prompt) resolves it');
  ceoStep(m, { ev: 'Stop', sid: 'A', ts: ts(290000), msg: '배포할까요?' });
  ceoStep(m, { ev: 'PreToolUse', sid: 'A', tool: 'Bash', ts: ts(291000) });
  assert.equal(m.size, 0, 'so does its next tool event');
  ceoStep(m, { ev: 'Stop', sid: 'A', ts: ts(292000), msg: '배포할까요?' });
  ceoStep(m, { ev: 'SessionEnd', sid: 'A', ts: ts(293000) });
  assert.equal(m.size, 0, 'and SessionEnd');
});

test('asks entries are capped: after 3h they expire like any LOW entry', () => {
  const m = new Map();
  ceoStep(m, { ev: 'Stop', sid: 'A', ts: ts(0), msg: '배포할까요?' });
  assert.equal(ASK_MAX_MS, 3 * 3600000);
  assert.deepEqual(ceoExpire(m, T0 + ASK_MAX_MS), [], 'exactly 3h: still waiting');
  assert.deepEqual(ceoExpire(m, T0 + ASK_MAX_MS + 1), ['A|main'], 'past 3h: gone');
  ceoStep(m, { ev: 'Stop', sid: 'B', ts: ts(0), msg: '배포할까요?' });
  assert.deepEqual(ceoExpire(m, T0 + 60001, 90000, 60000), ['B|main'], 'the cap is a parameter');
});

test('readerSame: the drawer follows the same session and wait occurrence; anything else freezes it', () => {
  assert.equal(readerSame({ sid: 'S1', since: 5 }, { sid: 'S1', since: 5 }), true, 'same entry: live');
  assert.equal(readerSame({ sid: 'S1', since: 5 }, { sid: 'S1', since: 9 }), false, 'a new wait of the same character: frozen');
  assert.equal(readerSame({ sid: 'S1', since: null }, { sid: 'S1', since: null }), true, 'character card: same session');
  assert.equal(readerSame({ sid: 'S1' }, { sid: 'S2' }), false, 'same key, another session (floor switched): frozen');
  assert.equal(readerSame({ sid: 'S1' }, null), false, 'entry / sprite gone: frozen');
  assert.equal(readerSame({ sid: null }, { sid: null }), false, 'no session known at open: never follows');
  assert.equal(readerSame(null, { sid: 'S1' }), false);
});

const Q = (key, since, extra = {}) => ({ key, sid: key.split('|')[0], proj: 'p', aid: null, kind: 'perm', prio: HIGH, text: `t-${key}`, since, ...extra });
const LIST = [
  Q('c|main', 3000, { kind: 'report', prio: LOW, body: '정리했어요\n다음 결정: 머지할지 정해 주세요.', asks: true, proj: 'b-floor' }),
  Q('a|main', 1000, { kind: 'perm', proj: 'c-floor', text: 'Bash git push' }),
  Q('b|x1', 2000, { kind: 'ask', proj: 'a-floor', aid: 'x1', text: '배포 범위?' }),
  Q('d|main', 4000, { kind: 'idle', prio: LOW, text: '입력을 기다리고 있어요' }),
  Q('e|main', 5000, { kind: 'report', prio: LOW, body: '## 끝\n- 테스트 통과', proj: 'a-floor' }),
];

test('ceoTable: default = arrival oldest first; kinds, labels, one-line text, wait', () => {
  const { rows, fresh } = ceoTable(LIST, { now: 6000 });
  assert.equal(fresh, 0);
  assert.deepEqual(rows.map(r => r.key), ['a|main', 'b|x1', 'c|main', 'd|main', 'e|main']);
  assert.deepEqual(rows.map(r => r.label), ['승인', '질문', '결정(추정)', '대기', '보고']);
  assert.equal(rows[0].wait, 5000);
  assert.equal(rows[2].text, '다음 결정: 머지할지 정해 주세요.', 'an asking report shows its decision line');
  assert.equal(rows[4].text, '끝', 'a plain report shows its first line');
  assert.equal(rowKind({ kind: 'notify' }), 'perm');
  assert.equal(rowText({ kind: 'ask', text: 'x', relay: { item: { kind: 'question', questions: [{ question: '첫 질문' }, { question: '둘' }] } } }), '첫 질문 외 1개');
});

test('ceoTable: sort by any column asc/desc (ties by arrival); nextSort toggles; filter 답 필요만', () => {
  const keys = opts => ceoTable(LIST, { now: 6000, ...opts }).rows.map(r => r.key);
  assert.deepEqual(keys({ sort: { col: 'at', dir: 'desc' } }), ['e|main', 'd|main', 'c|main', 'b|x1', 'a|main']);
  assert.deepEqual(keys({ sort: { col: 'wait', dir: 'desc' } }), ['a|main', 'b|x1', 'c|main', 'd|main', 'e|main'], 'longest wait first');
  assert.deepEqual(keys({ sort: { col: 'kind', dir: 'asc' } }), ['a|main', 'b|x1', 'c|main', 'e|main', 'd|main'], '승인 질문 결정 보고 대기');
  assert.deepEqual(keys({ sort: { col: 'proj', dir: 'asc' } }), ['b|x1', 'e|main', 'c|main', 'a|main', 'd|main'], 'a-floor (arrival tie), b, c, p');
  assert.deepEqual(keys({ sort: { col: 'bogus', dir: 'asc' } }), keys({}), 'unknown column falls back to arrival');
  assert.deepEqual(nextSort({ col: 'at', dir: 'asc' }, 'at'), { col: 'at', dir: 'desc' });
  assert.deepEqual(nextSort({ col: 'at', dir: 'desc' }, 'at'), { col: 'at', dir: 'asc' });
  assert.deepEqual(nextSort({ col: 'at', dir: 'desc' }, 'who'), { col: 'who', dir: 'asc' });
  assert.deepEqual(keys({ filter: 'need' }), ['a|main', 'b|x1', 'c|main'], 'HIGH + reports that ask');
});

test('ceoTable: rows not shown yet are counted as fresh (새 요청 N건), not inserted', () => {
  const t = ceoTable(LIST, { shown: new Set(['a|main', 'c|main', 'gone|main']) });
  assert.deepEqual(t.rows.map(r => r.key), ['a|main', 'c|main']);
  assert.equal(t.fresh, 3);
  assert.equal(ceoTable(LIST, { shown: new Set(['a|main']), filter: 'need' }).fresh, 2, 'fresh respects the filter');
});

test('selection: by dismiss key (key|since); select-all of the filtered rows, ranges, state, pruning, hidden, HIGH', () => {
  const D = k => dismissKey(LIST.find(q => q.key === k));
  const need = ceoTable(LIST, { filter: 'need' }).rows, all = ceoTable(LIST).rows;
  assert.equal(all[0].dkey, 'a|main|1000', 'rows carry the DismissStore id');
  let sel = selectRows(new Set([D('e|main')]), need, true);
  assert.deepEqual([...sel].sort(), ['a|main|1000', 'b|x1|2000', 'c|main|3000', 'e|main|5000'], 'select-all adds only the filtered rows; others stay');
  assert.equal(selState(sel, need), 'all'); assert.equal(selState(sel, all), 'some'); assert.equal(selState(new Set(), all), 'none');
  assert.equal(selHidden(sel, need), 1, 'e is selected but filtered out: 숨은 1건');
  assert.equal(selHidden(sel, all), 0);
  sel = selectRows(sel, need, false);
  assert.deepEqual([...sel], ['e|main|5000'], 'unchecking the header clears only the filtered rows');
  assert.deepEqual([...selectRange(new Set(), all, D('b|x1'), D('d|main'))], ['b|x1|2000', 'c|main|3000', 'd|main|4000']);
  assert.deepEqual([...selectRange(new Set(), all, D('d|main'), D('b|x1'))], ['b|x1|2000', 'c|main|3000', 'd|main|4000'], 'either direction');
  assert.deepEqual([...selectRange(new Set([D('c|main')]), all, D('b|x1'), D('d|main'), false)], [], 'shift-uncheck clears the range');
  assert.deepEqual([...selectRange(new Set(), all, 'gone', D('a|main'))], ['a|main|1000'], 'anchor gone: just the clicked row');
  const s2 = pruneSel(new Set([D('a|main'), D('c|main'), 'gone|main|1']), LIST.filter(q => q.key !== 'c|main'));
  assert.deepEqual([...s2], ['a|main|1000'], 'resolved / gone rows drop out; survivors stay');
  const requeued = LIST.map(q => (q.key === 'a|main' ? { ...q, since: 9000 } : q));
  assert.deepEqual([...pruneSel(new Set([D('a|main')]), requeued)], [], 'the same character waiting again later is a new, unselected occurrence');
  assert.deepEqual(selEntries(new Set([D('a|main')]), requeued), [], 'and bulk send back never picks it up');
  assert.deepEqual(selEntries(new Set([D('b|x1')]), LIST).map(q => q.key), ['b|x1']);
  assert.equal(selHigh(new Set([D('a|main'), D('b|x1'), D('c|main'), D('d|main')]), LIST), 2, '승인·질문 among the selection');
});

test('onRelayClick: refuses a button rendered for another relay item, and a second click while sending / closed', () => {
  resetRelay();
  applyFrame({ type: 'ask', item: { id: 'r1', kind: 'permission', sid: 'S', tool: 'Bash', target: 'ls' } });
  const r = relay.items.get('r1');
  const ev = (a, rid) => { const b = { dataset: { a, rid }, disabled: false }; return { target: { closest: () => b } }; };
  let renders = 0; const rr = () => { renders++; };
  assert.match(relayHTML(r), /data-a="allow" data-rid="r1"/, 'relay buttons carry their item id');
  assert.equal(onRelayClick(ev('allow', 'r0'), r, rr, true), true, 'stale button (other item): handled = refused');
  assert.equal(r.status, 'pending'); assert.equal(renders, 0, 'nothing sent, nothing re-rendered');
  assert.equal(onRelayClick(ev('copy', 'r1'), r, rr, true), false, 'not a relay action: falls through to the card handler');
  r.status = 'sending';
  assert.equal(onRelayClick(ev('deny', 'r1'), r, rr, true), true, 'double Enter while sending: refused');
  r.status = 'answered';
  assert.equal(onRelayClick(ev('allow', 'r1'), r, rr, true), true, 'already answered: refused');
  assert.equal(r.status, 'answered'); assert.equal(renders, 0);
  r.status = 'pending';
  const p = onRelayClick(ev('allow', 'r1'), r, rr, true);
  assert.ok(p && typeof p.then === 'function', 'matching, open item: the answer is sent');
  assert.equal(r.status, 'sending', 'status flips to sending synchronously (a second click is refused)');
  assert.equal(onRelayClick(ev('allow', 'r1'), r, rr, true), true);
  resetRelay();
});

test('ceoMore: +N stands a few units clear of the last figure and inside the room; one figure fewer if needed', () => {
  const m = ceoMore(7, 134, 14, 3);
  assert.equal(m.more, 7 - m.spots.length);
  const last = m.spots[m.spots.length - 1].r;
  assert.ok(m.r >= last + 12 + 3, 'gap from the last figure (half width 12)');
  assert.ok(m.r + 14 <= 134 - 1, 'button stays inside the room');
  assert.deepEqual(ceoMore(2, 134), { spots: ceoSpots(2, 134), more: 0, r: null }, 'no overflow: no button');
  const tight = ceoMore(9, 134, 30, 3);
  assert.ok(tight.spots.length < ceoSpots(9, 134).length && tight.spots.length >= 1, 'a wide button pushes one figure into +N');
  assert.equal(ceoMore(9, 30, 40).spots.length, 1, 'never fewer than one figure');
});

test('Stop without a body (--redact) never asks; subagent Stop opens nothing', () => {
  const m = new Map();
  ceoStep(m, { ev: 'Stop', sid: 'R', ts: ts(0) });
  assert.equal(m.get('R|main').asks, undefined);
  assert.deepEqual(ceoExpire(m, T0 + 91000), ['R|main']);
  ceoStep(m, { ev: 'Stop', sid: 'R', aid: 'a1', ts: ts(0), msg: '할까요?' });
  assert.equal(m.size, 0);
});

test('reportBlocks: bullets become list items with depth, blank lines gaps', () => {
  assert.deepEqual(reportBlocks(reportText('제목\n- 하나\n  - 둘\n\n끝')), [
    { t: 'p', text: '제목' }, { t: 'li', text: '하나', depth: 0 }, { t: 'li', text: '둘', depth: 1 }, { t: 'gap' }, { t: 'p', text: '끝' }]);
});

test('linkParts: only http(s) URLs become links; trailing punctuation and unmatched brackets stay text', () => {
  assert.deepEqual(linkParts('PR: https://github.com/example/shop/pull/23.'), [{ t: 'text', v: 'PR: ' }, { t: 'url', v: 'https://github.com/example/shop/pull/23' }, { t: 'text', v: '.' }]);
  assert.deepEqual(linkParts('(http://x.test/a_(b))'), [{ t: 'text', v: '(' }, { t: 'url', v: 'http://x.test/a_(b)' }, { t: 'text', v: ')' }]);
  assert.deepEqual(linkParts('javascript:alert(1) data:text/html,x ftp://h/x'), [{ t: 'text', v: 'javascript:alert(1) data:text/html,x ftp://h/x' }]);
  assert.deepEqual(linkParts('<img src=x onerror=1>'), [{ t: 'text', v: '<img src=x onerror=1>' }], 'markup is plain text (rendered via textContent)');
  assert.deepEqual(linkParts('https://a.test/"onmouseover="x'), [{ t: 'url', v: 'https://a.test/' }, { t: 'text', v: '"onmouseover="x' }], 'quotes end the URL');
  assert.deepEqual(linkParts(''), []);
});

test('drawer: whole card on every card, DOM-only reading, safe links, list mode, dismiss-only bulk send back', () => {
  const app = pub('app.js'), html = pub('index.html');
  const fn = app.slice(app.indexOf('// ---------------- 크게 보기 drawer'), app.indexOf('// Keep Tab inside the drawer'));
  assert.ok(fn.length > 2000, 'drawer block found');
  assert.equal(/\.innerHTML = (?!p\.head|actHTML|body;|th;|html;|COPYALL_BTN)/.test(fn), false, 'innerHTML only for escaped card/list templates');
  assert.match(fn, /a\.rel = 'noopener noreferrer'/); assert.match(fn, /a\.target = '_blank'/);
  assert.match(fn, /store\.set\('office\.readerSize'/, 'font size persisted through the try/catch store');
  assert.match(fn, /cardClick\(ev, \{ kind: reader\.src/, 'drawer actions go through the same handler as the popover');
  assert.match(app, /\$\('pop'\)\.addEventListener\('click', ev => cardClick\(/);
  assert.match(fn, /await sendBack\(picked\)/, 'bulk 돌려보내기 = the per-card sendBack path (release + dismiss)');
  assert.equal(/onRelayClick|\/relay\/answer/.test(fn.slice(fn.indexOf('async function bulkSendBack'), fn.indexOf('function closeReader'))), false, 'bulk never answers');
  const parts = app.slice(app.indexOf('function cardParts'), app.indexOf('function renderPop'));
  assert.equal((parts.match(/\$\{READ_BTN\}/g) || []).length, 2, '크게 보기 in the button row of both card kinds');
  assert.doesNotMatch(app.slice(app.indexOf('function reportHTML'), app.indexOf('const popReport')), /data-a="read"/, 'no header-level 크게 보기');
  assert.match(html, /id="reader"[^>]*role="dialog"[^>]*aria-labelledby="rd-t"/);
  assert.match(html, /<button type="button" class="ceo-boss" id="ceo-boss"/, 'the 대표 is a button (opens the list)');
  assert.match(app, /more = document\.createElement\('button'\)/, '+N is a real button');
  assert.match(pub('style.css'), /\.qmore \{[^}]*min-width: 34px; min-height: 32px;[^}]*cursor: pointer/);
  assert.match(pub('style.css'), /\.reader \{[^}]*animation: rd-in/, 'slide-in is a CSS animation (reduced motion turns it off globally)');
});

test('instruct card: box, chips, send, 터미널에서 할게요, countdown, note; rid + double-submit guards; merge into the report', () => {
  resetRelay();
  assert.equal(relay.seenInstruct, false);
  applyFrame({ type: 'ask', item: { id: 'i1', kind: 'instruct', sid: 'S', tool: 'Stop', asks: true, msg: '다음 결정: 머지할지 정해 주세요.', createdAt: 1000, expiresAt: 301000 } });
  assert.equal(relay.seenInstruct, true, 'the page now knows the Stop hook is installed');
  const r = relay.items.get('i1');
  const html = relayHTML(r);
  for (const a of ['chip', 'instruct', 'handoff']) assert.match(html, new RegExp(`data-a="${a}" data-rid="i1"`), a);
  assert.match(html, /<textarea class="ins"[^>]*maxlength="2000"/); assert.match(html, /live-left pill/);
  assert.match(html, /보낸 글은 대표님이 친 지시처럼 세션에 전달돼요/);
  assert.match(html, /data-a="instruct" data-rid="i1" disabled/, '보내기 disabled while the box is empty');
  assert.deepEqual(INSTRUCT_CHIPS, ['진행해 주세요', '머지해 주세요', '보류해 주세요']);

  const [q] = mergeQueue([]);
  assert.deepEqual([q.kind, q.prio, q.asks, q.body, q.text], ['report', LOW, true, '다음 결정: 머지할지 정해 주세요.', '결정을 기다려요'], 'relay-only instruct = the asking report (LOW, no bell)');
  const [m] = mergeQueue([{ key: 'S|main', sid: 'S', kind: 'report', prio: LOW, asks: true, body: 'b', since: 900 }]);
  assert.equal(m.relay, r, 'attached to the report entry from the Stop event');

  const ev = (a, rid, v) => { const b = { dataset: { a, rid, ...(v ? { v } : {}) }, disabled: false }; return { target: { closest: () => b } }; };
  let opts = null; const rr = o => { opts = o; };
  assert.equal(onRelayClick(ev('chip', 'i1', '머지해 주세요'), r, rr, true), true);
  assert.deepEqual(opts, { focus: '.ins' }, 'a chip fills the box and puts the caret there');
  assert.match(relayHTML(r), />머지해 주세요<\/textarea>/);
  assert.match(relayHTML(r), /data-a="instruct" data-rid="i1" >/, '보내기 enabled once there is text');
  const ta = { classList: { contains: c => c === 'ins' }, value: '<b>"x"</b>', closest: () => null };
  onRelayInput({ target: ta }, r, () => assert.fail('no re-render while typing'));
  assert.match(relayHTML(r), /&lt;b&gt;&quot;x&quot;&lt;\/b&gt;<\/textarea>/, 'the draft is escaped');
  assert.equal(onRelayClick(ev('instruct', 'other'), r, rr, true), true); assert.equal(r.status, 'pending', 'stale button refused');
  const p = onRelayClick(ev('instruct', 'i1'), r, () => {}, true);
  assert.ok(p && typeof p.then === 'function'); assert.equal(r.status, 'sending');
  assert.equal(onRelayClick(ev('instruct', 'i1'), r, rr, true), true, 'Ctrl+Enter twice: second refused while sending');
  assert.equal(onRelayClick(ev('handoff', 'i1'), r, rr, true), true, 'no hand-off while sending');
  resetRelay();
});

test('instruct UI wiring: report card shows the box or an honest muted line; Ctrl/⌘+Enter sends; typing survives repaints', () => {
  const app = pub('app.js');
  assert.match(pub('ceocard.js'), /대시보드 지시는 설치 후 쓸 수 있어요 · 터미널로/);
  assert.match(app, /\$\{esc\(instructOff\(q, relayState\)\)\}/, 'the card uses instructOff (escaped)');
  assert.match(app, /q\.kind === 'report' && q\.asks && q\.relay\?\.item\?\.kind !== 'instruct'/, 'the muted line only when no instruct item is attached');
  assert.match(app, /ev\.target\.classList\.contains\('ins'\) && \(ev\.ctrlKey \|\| ev\.metaKey\)/, 'Ctrl/⌘+Enter = 보내기; plain Enter is a new line');
  assert.match(app, /const TYPING = '\.why, \.ins';/);
  assert.match(app, /el\._h !== html && !\(typingIn\(el\) && el\._st === st\)/, 'small card: no repaint under typing unless the relay status changed');
});

test('whyNoButtons: the card says why it cannot answer (timeout with the real wait, no dashboard, background, hook gone, not installed 추정)', () => {
  const T = 1_000_000, q = { key: 'S|main', sid: 'S', aid: null, tool: 'Bash', since: T, kind: 'perm' };
  const st = ends => ({ ends, seen: new Set(['S']), startedAt: T - 60000 });
  assert.deepEqual(whyNoButtons(q, st([{ sid: 'S', aid: null, tool: 'Bash', reason: 'timeout', wait: 170000, at: T + 170000 }])),
    { text: '2분 50초 동안 대시보드 답을 기다리다 터미널로 넘겼어요 · 터미널에서 답해 주세요', inferred: false });
  assert.equal(whyNoButtons(q, st([{ sid: 'S', tool: 'Bash', reason: 'timeout', wait: 180000, at: T + 180000 }])).text.startsWith('3분 동안'), true);
  assert.equal(whyNoButtons(q, st([{ sid: 'S', tool: 'Bash', reason: 'no-viewer', at: T }])).text, '대시보드가 열려 있지 않아 터미널로 갔어요 · 터미널에서 답해 주세요');
  assert.match(whyNoButtons(q, st([{ sid: 'S', tool: 'Bash', reason: 'hidden', at: T + 500 }])).text, /탭이 뒤에 있어/);
  assert.match(whyNoButtons(q, st([{ sid: 'S', tool: 'Bash', reason: 'withdrawn', at: T + 900 }])).text, /먼저 답했거나 훅이 끝났어요/);
  assert.match(whyNoButtons(q, st([{ sid: 'S', tool: 'Bash', reason: 'no-viewer', at: T - 5000 }, { sid: 'S', tool: 'Bash', reason: 'timeout', wait: 60000, at: T + 60000 }])).text, /^1분 동안/, 'latest ending for this request wins');
  assert.match(whyNoButtons(q, st([{ sid: 'S', tool: 'Bash', reason: 'timeout', wait: 60000, at: T - 5000 }])).text, /지난 요청이거나/, 'an older request\'s ending does not explain this one');
  assert.match(whyNoButtons(q, st([{ sid: 'S', aid: 'a1', tool: 'Bash', reason: 'timeout', wait: 60000, at: T + 1 }])).text, /지난 요청이거나/, 'another character');
  assert.match(whyNoButtons(q, st([{ sid: 'S', tool: 'Read', reason: 'timeout', wait: 60000, at: T + 1 }])).text, /지난 요청이거나/, 'another tool');
  assert.deepEqual(whyNoButtons(q, { ends: [], seen: new Set(), startedAt: T - 1 }), { text: '대표실 중계가 설치되지 않았어요 · 터미널에서 답해 주세요', inferred: true });
  assert.equal(whyNoButtons(q, { ends: [], seen: new Set(), startedAt: T + 1 }).inferred, false, 'a request older than the server: not claimed as "not installed"');

  resetRelay();
  applyFrame({ type: 'snapshot', items: [], ends: [{ sid: 'S', tool: 'Bash', reason: 'no-viewer', at: T }], startedAt: T - 1000 });
  assert.match(whyNoButtons(q).text, /열려 있지 않아/, 'snapshot ends survive a reload');
  applyFrame({ type: 'ask', item: { id: 'p9', kind: 'permission', sid: 'S', tool: 'Bash', createdAt: T + 10, expiresAt: T + 170010 } });
  applyFrame({ type: 'resolved', id: 'p9', by: 'terminal', reason: 'timeout' }, T + 170010);
  assert.match(whyNoButtons(q).text, /^2분 50초 동안/, 'a timeout frame on a held item is remembered with its wait');
  applyFrame({ type: 'ended', end: { sid: 'Z', tool: 'Bash', reason: 'hidden', at: T } });
  assert.equal(relay.seen.has('Z'), true, 'a skipped request still proves the hook is installed');
  resetRelay();
});

test('ceoGroupPlan: individual while the line fits; per-session groups only on overflow; rep = HIGH first, then oldest', () => {
  const E = (key, since, prio, extra = {}) => ({ key, sid: key.split('|')[0], aid: key.endsWith('|main') ? null : key.split('|')[1], since, prio, kind: prio === HIGH ? 'perm' : 'report', text: key, ...extra });
  const L = [E('A|main', 1, LOW, { asks: true }), E('B|main', 2, HIGH), E('A|x', 3, HIGH), E('A|y', 4, HIGH, { kind: 'ask' }), E('C|main', 5, LOW, { kind: 'idle' })];
  const fit = ceoGroupPlan(L, 5);
  assert.equal(fit.grouped, false, 'everyone fits: no grouping');
  assert.deepEqual(fit.figures.map(f => [f.key, f.n]), [['A|main', 1], ['B|main', 1], ['A|x', 1], ['A|y', 1], ['C|main', 1]]);
  const g = ceoGroupPlan(L, 3);
  assert.equal(g.grouped, true);
  assert.deepEqual(g.figures.map(f => [f.key, f.rep.key, f.n, f.high]), [['g:A', 'A|x', 3, true], ['g:B', 'B|main', 1, true], ['g:C', 'C|main', 1, false]],
    'A waited longest (front); its figure is the oldest HIGH member, not always 실장');
  assert.equal(ceoGroupPlan([E('A|main', 1, LOW), E('A|z', 0, LOW)], 1).figures[0].rep.key, 'A|z', 'no HIGH: the oldest');
  assert.equal(groupTip(g.figures[0]), '실장 결정(추정) · 승인 1 · 질문 1');
  assert.equal(groupTip({ members: [E('Q|a', 1, HIGH), E('Q|b', 2, HIGH)] }), '승인 2', 'no main entry: counts only');
  assert.deepEqual(ceoGroupPlan([], 3), { grouped: false, figures: [] });
});

test('groupEntry: only a real newcomer knocks; regrouping or joining an existing group never walks in again', () => {
  const fig = keys => ({ members: keys.map(key => ({ key })) });
  const known = new Set(['A|main', 'A|x']);
  assert.deepEqual(groupEntry(fig(['A|main', 'A|x', 'A|y']), { known, sameFloor: true, reduced: false }), { anim: null, knock: false }, 'joined an existing group / regrouped: appears in place');
  assert.deepEqual(groupEntry(fig(['B|main']), { known, sameFloor: false, reduced: false }), { anim: 'warp', knock: true }, 'a new session knocks');
  assert.deepEqual(groupEntry(fig(['B|main']), { known: null, sameFloor: true, reduced: false }), { anim: null, knock: false }, 'reload / replay');
  assert.deepEqual(groupEntry(fig(['B|main']), { known, sameFloor: true, reduced: true }), { anim: null, knock: false }, 'reduced motion');
});

test('ceoTable sid: the list filtered to one session (opened from a group)', () => {
  assert.deepEqual(ceoTable(LIST, { sid: 'a' }).rows.map(r => r.key), ['a|main']);
  assert.deepEqual(ceoTable(LIST, { sid: 'b', filter: 'need' }).rows.map(r => r.key), ['b|x1']);
  assert.equal(ceoTable(LIST, { sid: 'zzz' }).rows.length, 0);
});

test('터미널에서 답할게요: on every open relay card (perm, question, instruct), releases with no decision, card says so', async () => {
  resetRelay();
  const T = Date.now();
  applyFrame({ type: 'ask', item: { id: 'p1', kind: 'permission', sid: 'S', tool: 'Bash', target: 'ls', createdAt: T, expiresAt: T + 120000 } });
  applyFrame({ type: 'ask', item: { id: 'q1', kind: 'question', sid: 'S', aid: 'a', tool: 'AskUserQuestion', createdAt: T, expiresAt: T + 120000,
    questions: [{ question: 'Q?', header: '', multiSelect: false, options: [{ label: 'A', description: '' }] }] } });
  applyFrame({ type: 'ask', item: { id: 'i1', kind: 'instruct', sid: 'S', tool: 'Stop', createdAt: T, expiresAt: T + 120000 } });
  for (const [id, label] of [['p1', '터미널에서 답할게요'], ['q1', '터미널에서 답할게요'], ['i1', '터미널에서 할게요']])
    assert.match(relayHTML(relay.items.get(id)), new RegExp(`class="chipbtn term" data-a="handoff" data-rid="${id}" [^>]*>${label}<`), id);
  const r = relay.items.get('p1');
  const ev = (a, rid) => { const b = { dataset: { a, rid }, disabled: false }; return { target: { closest: () => b } }; };
  let last = null;
  assert.equal(onRelayClick(ev('handoff', 'zz'), r, () => {}, true), true); assert.equal(r.status, 'pending', 'stale button refused');
  await onRelayClick(ev('handoff', 'p1'), r, o => { last = o; }, true);
  assert.equal(r.status, 'released', 'released: no allow, no deny');
  assert.deepEqual(last, { focus: '[data-a="focus"]' }, 'keyboard focus goes to 터미널로');
  assert.match(relayHTML(r), /터미널로 넘겼어요 · 터미널에서 답해 주세요/);
  assert.equal(whyNoButtons({ key: 'S|main', sid: 'S', tool: 'Bash', since: T }).text, '터미널로 넘겼어요 · 터미널에서 답해 주세요', 'after the card is swept it still says so');
  assert.equal(onRelayClick(ev('handoff', 'p1'), r, () => {}, true), true, 'second hand-off refused (closed)');
  resetRelay();
});

test('instructOff: why an asking report has no box (cap / unchecked / timeout / released / not installed)', () => {
  const T = 1e6, q = { key: 'S|main', sid: 'S', since: T };
  const st = (reason, extra = {}) => ({ ends: [{ sid: 'S', aid: null, tool: 'Stop', reason, at: T + 10, ...extra }], seenInstruct: true });
  assert.equal(instructOff(q, st('cap')), '연속 지시는 8번까지예요 · 터미널에서 이어 주세요');
  assert.match(instructOff(q, st('unchecked')), /이 컴퓨터에서는 대시보드 지시를 쓸 수 없어요/);
  assert.match(instructOff(q, st('timeout', { wait: 120000 })), /^2분 동안 지시를 기다리다 멈췄어요/);
  assert.match(instructOff(q, st('released')), /터미널로 넘겼어요/);
  assert.equal(instructOff(q, { ends: [], seenInstruct: false }), '대시보드 지시는 설치 후 쓸 수 있어요 · 터미널로');
  assert.match(instructOff(q, { ends: [{ sid: 'S', tool: 'Stop', reason: 'cap', at: T - 5000 }], seenInstruct: true }), /받을 수 없어요/, 'an older report\'s cap does not apply');
});

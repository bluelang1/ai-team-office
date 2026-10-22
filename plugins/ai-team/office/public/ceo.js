// AI Team Office v2 — 대표실 대기열. Who needs the human right now, derived only from office events (no guessing).
// Pure: ceoQueue(events, now) folds the stream; ceoStep(map, e) is the same fold one event at a time (app.js uses it
// incrementally). Keys are `${sid}|${aid || 'main'}`; one entry per character.
//
//   PreToolUse tool=AskUserQuestion           -> kind ask     HIGH  text = ask | target
//   PermissionRequest                         -> kind perm    HIGH  text = ask | `${tool} ${target}`
//   PermissionRequest tool=AskUserQuestion    -> kind ask     HIGH  (a question card: answered with the answers)
//   Notification permission_prompt           -> kind notify  HIGH  text = msg (keeps an earlier HIGH entry's text)
//   Notification idle_prompt                 -> kind idle    LOW   '입력을 기다리고 있어요' (keeps any open entry; a LOW
//                                                                      courtesy that expires like a report, never "답이 필요해요")
//   Stop (main)                               -> kind report  LOW   text = '보고 드렸어요', body = msg (the final report,
//                                                                      up to 4000 chars from the hook; absent under --redact)
//   Stop (main), report ends by asking         -> kind report  LOW   asks: true, text = '결정을 기다려요' (INFERRED by
//     (reportAsks: last lines end in ? / 할까요 /                      reportAsks from wording; the card says 추정). Never
//      정해 주세요 / '다음 결정: …' …)                                    90s expiry (ceoExpire: 3h cap); same resolvers below
//   RelayDecided (server, from ceo-decisions.jsonl: answered in the dashboard) -> resolves; the permission_prompt
//                                              Notification that may still follow does not reopen it
//   resolved by: the same character's next PreToolUse/PostToolUse/PostToolUseFailure (an ask entry ignores the
//   AskUserQuestion PreToolUse that opened it), UserPromptSubmit or SessionEnd on that sid, SubagentStop of that aid.

export const HIGH = 'high', LOW = 'low';
const keyOf = e => `${e.sid}|${e.aid || 'main'}`;
const s = v => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'number' ? String(v) : '');
const tsOf = e => { const t = Date.parse(s(e.ts)); return Number.isFinite(t) ? t : 0; };
const decided = new WeakMap();                          // map -> Set of keys answered in the dashboard, until they move on
const decidedOf = map => { let d = decided.get(map); if (!d) decided.set(map, d = new Set()); return d; };

function open(map, e, kind, prio, text, body = '', extra = null) {
  const k = keyOf(e), prev = map.get(k);
  const keepSince = prev && prev.prio === prio;
  map.set(k, { key: k, sid: s(e.sid), proj: s(e.proj) || '(unknown)', aid: s(e.aid) || null, atype: s(e.atype) || null,
    kind, prio, text: text.slice(0, 2000), since: keepSince ? prev.since : tsOf(e), tool: s(e.tool) || null,
    ...(body ? { body: body.slice(0, 4001) } : {}), ...(extra || {}) });
}

/** Apply one event to the waiting map (mutates `map`). Returns the keys resolved by this event. */
export function ceoStep(map, e) {
  if (!e || typeof e !== 'object' || typeof e.ev !== 'string' || !s(e.sid)) return [];
  const k = keyOf(e), resolved = [];
  const drop = key => { if (map.delete(key)) resolved.push(key); };
  const dropSid = () => { for (const key of [...map.keys()]) if (key.startsWith(`${e.sid}|`)) drop(key); };
  const ask = s(e.ask).trim();
  if (e.ev !== 'Notification' && e.ev !== 'RelayDecided') decidedOf(map).delete(k);
  switch (e.ev) {
    case 'RelayDecided': drop(k); decidedOf(map).add(k); break;
    case 'PreToolUse':
      if (e.tool === 'AskUserQuestion') open(map, e, 'ask', HIGH, ask || s(e.target).trim() || '질문이 있어요');
      else drop(k);
      break;
    case 'PostToolUse': case 'PostToolUseFailure': drop(k); break;
    case 'PermissionRequest':                              // a permission prompt for AskUserQuestion is still a question
      if (e.tool === 'AskUserQuestion') open(map, e, 'ask', HIGH, ask || s(e.target).trim() || '질문이 있어요');
      else open(map, e, 'perm', HIGH, ask || `${s(e.tool)} ${s(e.target)}`.trim() || '승인이 필요해요');
      break;
    case 'Notification': {
      if (e.ntype !== 'permission_prompt' && e.ntype !== 'idle_prompt') break;
      const prev = map.get(k);
      if (prev && prev.prio === HIGH) break;              // the PermissionRequest / question already says more
      if (decidedOf(map).has(k) && e.ntype === 'permission_prompt') break;   // already answered in the dashboard
      const msg = s(e.msg).trim();                        // Claude Code's notification text is English; show it only if it is Korean
      if (e.ntype === 'idle_prompt') {                    // "the session sits idle" is not a question to the 대표: never HIGH,
        if (!prev) open(map, e, 'idle', LOW, '입력을 기다리고 있어요');   // and the 60s ping after a Stop keeps the report
        break;
      }
      open(map, e, 'notify', HIGH, /[가-힣]/.test(msg) ? msg : '승인이 필요해요');
      break;
    }
    case 'Stop': if (!e.aid) {
      const body = s(e.msg).trim(), asks = reportAsks(body);
      drop(k); open(map, e, 'report', LOW, asks ? '결정을 기다려요' : '보고 드렸어요', body, asks ? { asks: true } : null);
    } break;
    case 'UserPromptSubmit': case 'SessionEnd': dropSid(); for (const key of [...decidedOf(map)]) if (key.startsWith(`${e.sid}|`)) decidedOf(map).delete(key); break;
    case 'SubagentStop': drop(k); break;
    default: break;
  }
  return resolved;
}

/** The human answered `key` outside the event stream (dashboard relay, or the simulator's local answer): the
 *  character leaves the line now instead of waiting for its next tool event. Returns the resolved keys. */
/** Forget per-map state kept beside the entries (call together with map.clear()). */
export function ceoReset(map) { map.clear(); decidedOf(map).clear(); }

export function ceoResolve(map, key) { return key && map.delete(key) ? [key] : []; }

/** A LOW report ("보고 드렸어요") is a courtesy, not a question: after `ms` the 실장 bows and goes back to work
 *  even if no new prompt came. A report that ends by asking the 대표 something (asks: true) waits for the answer
 *  instead (UserPromptSubmit / SessionEnd / its next tool event), capped at `askMs` (3h) so a forgotten session
 *  does not stand there all day. Returns the resolved keys. */
export const ASK_MAX_MS = 3 * 3600000;
export function ceoExpire(map, now, ms = 90000, askMs = ASK_MAX_MS) {
  const out = [];
  for (const [k, x] of map) if (x.prio === LOW && now - x.since > (x.asks ? askMs : ms)) { map.delete(k); out.push(k); }
  return out;
}

/** Waiting list, oldest first (front of the line), with live wait time. Pure. */
export function ceoList(map, now) {
  return [...map.values()].sort((a, b) => a.since - b.since || (a.key < b.key ? -1 : 1))
    .map(x => ({ ...x, waitMs: Math.max(0, now - x.since) }));
}

/** Pure fold over an event list. */
export function ceoQueue(events, now) {
  const map = new Map();
  for (const e of events || []) ceoStep(map, e);
  return ceoList(map, now);
}

/** The report text for display: line breaks kept, light markdown cleanup (``` fence lines dropped, leading #
 *  removed, **bold** / `code` marks unwrapped, - / * bullets shown as •), runs of blank lines squeezed. Plain text:
 *  the caller still escapes it. */
export function reportText(v) {
  const lines = s(v).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) continue;
    let l = raw.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/^(\s*)[-*+]\s+/, '$1• ');
    l = l.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1').replace(/`([^`\n]+)`/g, '$1').replace(/\s+$/, '');
    if (!l && (!out.length || out[out.length - 1] === '')) continue;
    out.push(l);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

// ---------- does the report ask the 대표 something? (heuristic: wording only, shown as 추정) ----------
// 확인해 주세요 is left out on purpose: reports use it for "check it in the browser", not for a decision.
const ASK_WORDS = /(할까요|될까요|드릴까요|볼까요|정해\s*주세요|알려\s*주세요|골라\s*주세요|결정해\s*주세요|승인해\s*주셔야|승인해\s*주세요|승인해\s*주시면)/;
const DECIDE_HEAD = /^다음\s*결정/;
/** '다음 결정' whose value is empty or STARTS with 없음 / 없어요 / 해당 없음 / none / N/A / '-' (anything may follow). */
const NOTHING_VAL = /^(?:$|[.。]|없음|없어요|없습니다|해당\s*없|none\b|n\/?a\b|[-–—])/i;
const NOTHING = { test: l => NOTHING_VAL.test(l.replace(/^다음\s*결정\s*(?:사항)?\s*[:：\-–—]?\s*/, '')) };   // one separator, then the value
const ENDS_Q = /[?？]\s*[)\]"'”’]*$/;
const noUrls = l => l.replace(/https?:\/\/\S+/gi, '');   // a URL ending in '?' is not a question
/** The body without ``` / ~~~ fenced blocks (fence lines and everything inside; an unclosed fence runs to the end). */
const unfenced = v => {
  let fence = false;
  return s(v).replace(/\r\n?/g, '\n').split('\n').filter(l => { if (/^\s*(```|~~~)/.test(l)) { fence = !fence; return false; } return !fence; }).join('\n');
};
const TAIL = 5;                                         // only the last few non-empty lines count: a question quoted
                                                        // early in the report is not a question to the 대표
/** One report line without list / emphasis marks ('- ', '* ', '• ', '**', '> ', numbering): plain text. */
const bare = l => l.replace(/^\s*(?:[-*+•>]\s*|\d+[.)]\s+|\*\*|__)*/, '').replace(/\*\*|__/g, '').trim();
/** The line(s) near the end of a report that ask the 대표 to decide or answer: a '다음 결정…' line (unless it says
 *  there is none) or a line ending in ? / ？ or using an asking phrase (할까요, 정해 주세요, 알려 주세요, …).
 *  Plain text, in report order. Pure; [] when nothing asks. */
export function reportDecision(body) {
  const lines = reportText(unfenced(body)).split('\n').map(bare).filter(Boolean).slice(-TAIL);
  return lines.filter(l => ASK_WORDS.test(l) || (DECIDE_HEAD.test(l) ? !NOTHING.test(l) : ENDS_Q.test(noUrls(l))));
}
/** Does the report end by asking the 대표 something? (inferred from wording, not observed) */
export const reportAsks = body => reportDecision(body).length > 0;

/** 크게 보기 drawer: is what sits under the drawer's key now still the card it was opened on? opened = { sid, since }
 *  captured at open time (since only for a 대표실 entry); cur = { sid, since } of the 대표실 entry / the character in
 *  the current room, or null when gone. Same session and (for an entry) the same wait occurrence -> keep following
 *  it live; otherwise the drawer freezes on the last content and shows 지난 보고 / 지난 요청. Pure. */
export function readerSame(opened, cur) {
  if (!opened || !cur || !opened.sid || cur.sid !== opened.sid) return false;
  return opened.since == null || cur.since === opened.since;
}

// ---------- 대표실 list view (drawer list mode) ----------
/** Row kind of a waiting entry: perm (승인), ask (질문), decide (결정, inferred), report (보고), idle (대기). */
export const rowKind = q => (q.kind === 'perm' || q.kind === 'notify' ? 'perm' : q.kind === 'ask' ? 'ask'
  : q.kind === 'report' ? (q.asks ? 'decide' : 'report') : 'idle');
export const ROW_KIND_KO = { perm: '승인', ask: '질문', decide: '결정(추정)', report: '보고', idle: '대기' };
const KIND_ORDER = { perm: 0, ask: 1, decide: 2, report: 3, idle: 4 };
/** One line of content for a row: the question, the asking line of a report, the report's first line, or the text. */
export function rowText(q) {
  const qs = q.relay?.item?.kind === 'question' ? q.relay.item.questions : null;
  if (Array.isArray(qs) && qs[0]?.question) return s(qs[0].question) + (qs.length > 1 ? ` 외 ${qs.length - 1}개` : '');
  if (q.kind === 'report' && q.body) {
    const d = reportDecision(q.body);
    return d[d.length - 1] || reportText(q.body).split('\n').find(l => l.trim())?.replace(/^\s*•\s*/, '') || s(q.text);
  }
  return s(q.text);
}
export const LIST_COLS = ['at', 'wait', 'kind', 'proj', 'who', 'text'];
/** The list view's rows. list = ceoList/mergeQueue entries. opts: sort { col (LIST_COLS), dir 'asc'|'desc' } (default
 *  arrival oldest first), filter 'all' | 'need' (HIGH, or a report that asks), now, shown (Set of keys already on
 *  screen, or null = all), nameOf / projOf (display strings). Returns { rows, fresh } where rows are the shown rows in
 *  order and fresh counts matching rows not shown yet (the "새 요청 N건" bar). Ties: arrival, then key. Pure. */
export function ceoTable(list, { sort = { col: 'at', dir: 'asc' }, filter = 'all', sid = null, now = 0, shown = null, nameOf = q => s(q.aid) || '실장', projOf = q => s(q.proj) } = {}) {
  const col = LIST_COLS.includes(sort?.col) ? sort.col : 'at', sign = sort?.dir === 'desc' ? -1 : 1;
  const all = (list || []).map(q => {
    const kind = rowKind(q);
    return { key: q.key, dkey: `${q.key}|${q.since}`, sid: q.sid, at: q.since, wait: Math.max(0, now - q.since), kind, label: ROW_KIND_KO[kind], proj: projOf(q), who: nameOf(q),
      text: rowText(q).replace(/\s+/g, ' ').trim(), need: q.prio === HIGH || !!q.asks };
  }).filter(r => (filter !== 'need' || r.need) && (!sid || r.sid === sid));   // sid: one session (a 대표실 group)
  const val = r => (col === 'kind' ? KIND_ORDER[r.kind] : r[col]);
  const cmp = (a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko');
    return c * sign || a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  };
  all.sort(cmp);
  const rows = shown ? all.filter(r => shown.has(r.key)) : all;
  return { rows, fresh: all.length - rows.length };
}
// List selection (bulk 돌려보내기). Sets of dismiss keys (`${key}|${since}`, the same id DismissStore uses), so a
// character that leaves and queues again later is a new, unselected occurrence. Every helper returns a new Set. Pure.
const dk = q => `${q.key}|${q.since}`;
/** Keep only occurrences that are still waiting (resolved rows, and older waits of a re-queued character, drop out). */
export const pruneSel = (sel, list) => { const live = new Set((list || []).map(dk)); return new Set([...sel].filter(k => live.has(k))); };
/** Header checkbox: select (on) or clear every row currently shown (filtered); selections outside the filter stay. */
export const selectRows = (sel, rows, on) => { const out = new Set(sel); for (const r of rows) if (on) out.add(r.dkey); else out.delete(r.dkey); return out; };
/** Header checkbox state for the shown rows: 'all' | 'some' | 'none'. */
export const selState = (sel, rows) => { const n = rows.filter(r => sel.has(r.dkey)).length; return !rows.length || !n ? 'none' : n === rows.length ? 'all' : 'some'; };
/** Shift-click: set every row between the anchor and the clicked row (dismiss keys; inclusive, shown order) to `on`. */
export function selectRange(sel, rows, fromDk, toDk, on = true) {
  const i = rows.findIndex(r => r.dkey === fromDk), j = rows.findIndex(r => r.dkey === toDk);
  if (i < 0 || j < 0) return selectRows(sel, rows.filter(r => r.dkey === toDk), on);
  return selectRows(sel, rows.slice(Math.min(i, j), Math.max(i, j) + 1), on);
}
/** Selected entries that still need a human in the terminal (HIGH: 승인·질문), for the inline confirm. */
export const selHigh = (sel, list) => (list || []).filter(q => sel.has(dk(q)) && q.prio === HIGH).length;
/** Selected occurrences not on screen right now (filtered out or behind the 새 요청 bar): "숨은 N건 포함". */
export const selHidden = (sel, rows) => { const on = new Set(rows.map(r => r.dkey)); return [...sel].filter(k => !on.has(k)).length; };
/** The waiting entries a selection stands for (what bulk 돌려보내기 sends back). */
export const selEntries = (sel, list) => (list || []).filter(q => sel.has(dk(q)));
/** Clicking a column header: the same column flips asc/desc, a new column starts asc. */
export const nextSort = (sort, col) => (sort?.col === col ? { col, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { col, dir: 'asc' });

/** Report text (after reportText) as display blocks: { t: 'li', text, depth } for '• ' bullets, { t: 'p', text } for
 *  other lines, { t: 'gap' } for a blank line. The caller renders text through textContent / linkParts. Pure. */
export function reportBlocks(text) {
  return s(text).split('\n').map(l => {
    const m = /^(\s*)•\s+(.*)$/.exec(l);
    if (m) return { t: 'li', text: m[2], depth: Math.min(3, Math.floor(m[1].length / 2)) };
    return l.trim() ? { t: 'p', text: l } : { t: 'gap' };
  });
}
/** Split a line into text and http(s) link parts: [{ t: 'text'|'url', v }]. Only http/https URLs that parse become
 *  links; trailing punctuation (.,;:!? and unmatched closing brackets) stays text. Pure. */
export function linkParts(line) {
  const out = [], str = s(line), re = /https?:\/\/[^\s<>"'`]+/gi;
  let at = 0, m;
  const push = (t, v) => { if (!v) return; const last = out[out.length - 1]; if (t === 'text' && last?.t === 'text') last.v += v; else out.push({ t, v }); };
  while ((m = re.exec(str))) {
    let u = m[0];
    for (;;) {                                          // peel trailing punctuation / a closing bracket with no opener
      const ch = u.slice(-1);
      if (/[.,;:!?。、]/.test(ch)) { u = u.slice(0, -1); continue; }
      const pair = { ')': '(', ']': '[', '}': '{', '）': '（' }[ch];
      if (pair && u.split(pair).length <= u.split(ch).length - 1) { u = u.slice(0, -1); continue; }
      break;
    }
    let ok = false;
    try { const p = new URL(u); ok = p.protocol === 'http:' || p.protocol === 'https:'; } catch { /* not a URL */ }
    push('text', str.slice(at, m.index));
    if (ok) push('url', u); else push('text', u);
    at = m.index + u.length; re.lastIndex = at;
  }
  push('text', str.slice(at));
  return out;
}

// ---------- 돌려보내기 (send back without a decision) ----------
/** One occurrence of a wait: the same character waiting again later (new `since`) is a new occurrence. */
export const dismissKey = q => `${q.key}|${q.since}`;
/** The waiting line minus occurrences the user sent back. */
export const visibleQueue = (list, dismissed) => list.filter(q => !dismissed.has(dismissKey(q)));
const OPEN_RELAY = new Set(['pending', 'sending']);
/** What "모두 돌려보내기" does per entry: release the open relay item on the server (if any) and dismiss locally. */
export const releasePlan = list => list.map(q => ({ key: q.key, dkey: dismissKey(q), relayId: q.relay && OPEN_RELAY.has(q.relay.status) ? q.relay.item.id : null }));
/** Dismissed occurrences, persisted per viewer (sessionStorage/localStorage-like `storage`; failures are ignored). */
export class DismissStore {
  constructor(storage, name = 'office.dismissed', max = 300) {
    this.storage = storage; this.name = name; this.max = max; this.set = new Set();
    try { const v = JSON.parse(storage?.getItem(name) || '[]'); if (Array.isArray(v)) for (const k of v) if (typeof k === 'string') this.set.add(k); } catch { /* blocked or corrupt */ }
  }
  has(k) { return this.set.has(k); }
  add(k) {
    this.set.add(k);
    while (this.set.size > this.max) this.set.delete(this.set.values().next().value);
    try { this.storage?.setItem(this.name, JSON.stringify([...this.set])); } catch { /* private mode: in-memory only */ }
  }
}

// ---------- 대표실 floor plan (world units, room 134×100; x measured from the room's RIGHT wall so the banner works too) ----------
// The 대표 sits with his back to the right (exterior) wall and faces LEFT, toward the door; the desk stands between
// him and the door. People waiting queue in front of the desk on the door side and face RIGHT, toward him.
export const CEO_PLAN = {
  // The chair and the 대표 share one canvas (sprites.js EXEC; canvas right edge at r 1, painter x -> r 5 + x):
  chair: { r0: 5, r1: 16 },                           // r = distance from the right wall; backrest r 5-9, seat to r 16
  boss: { r: 13, y: 91, face: 'left', back: 10, knee: 20, hands: [22, 24] },   // sprite centre; his back on the backrest, knee, hands
  desk: { r0: 21, r1: 48, top: 21 },                  // side-view desk from just in front of his knees to the door side
  spot0: 60, step: 21, y: 91, min: 8,                // queue: first spot just left of the desk, then further left (label below)
  door: 124,                                          // the glass door (world.js ROOMS.ceo.door.x): newcomers knock here first
};
/** Queue spots for n people: [{ r (centre, from the right wall), y (feet), face: 'right' }], front first.
 *  Only as many as fit between the door side and the desk (room width w); the rest are counted as +N. */
export function ceoSpots(n, w = 134) {
  const P = CEO_PLAN, fit = Math.max(1, Math.floor((w - P.min - 12 - P.spot0) / P.step) + 1);
  return Array.from({ length: Math.min(n, fit, 4) }, (_, i) => ({ r: P.spot0 + i * P.step, y: P.y, face: 'right' }));
}

/** Queue spots plus the +N button by the door. bw = the button's width in world units (≥ 32px / scale), gap = clear
 *  space between the last figure (24 wide) and the button. If the button would not fit inside the room, one figure
 *  fewer stands in line (never fewer than one). -> { spots, more (0 = no button), r (button's right edge, from the
 *  right wall) } */
export function ceoMore(n, w = 134, bw = 14, gap = 3) {
  let spots = ceoSpots(n, w);
  if (n <= spots.length) return { spots, more: 0, r: null };
  const edge = sp => sp.r + 12 + gap;
  while (spots.length > 1 && edge(spots[spots.length - 1]) + bw > w - 1) spots = spots.slice(0, -1);
  return { spots, more: n - spots.length, r: edge(spots[spots.length - 1]) };
}

// ---------- 대표실 grouping (adaptive) ----------
/** Who stands in the 대표실 line. If every entry fits in `seats`, everyone stands individually (one figure per entry,
 *  key = entry key). Only when the line would overflow are entries grouped per session: one figure per session
 *  (key `g:<sid>`), shown as its highest-priority member (HIGH first, then the one waiting longest), with a ×N badge,
 *  `high` when any member is HIGH. Figures are ordered by the longest wait among their members (front first).
 *  -> { grouped, figures: [{ key, sid, rep, members, n, high, since }] }. Pure. */
export function ceoGroupPlan(list, seats) {
  const L = list || [];
  const one = q => ({ key: q.key, sid: q.sid, rep: q, members: [q], n: 1, high: q.prio === HIGH, since: q.since });
  if (L.length <= Math.max(1, seats)) return { grouped: false, figures: L.map(one) };
  const by = new Map();
  for (const q of L) { const g = by.get(q.sid) || { key: `g:${q.sid}`, sid: q.sid, members: [] }; g.members.push(q); by.set(q.sid, g); }
  const rank = q => (q.prio === HIGH ? 0 : 1);
  const figures = [...by.values()].map(g => {
    const rep = [...g.members].sort((a, b) => rank(a) - rank(b) || a.since - b.since || (a.key < b.key ? -1 : 1))[0];
    return { ...g, rep, n: g.members.length, high: g.members.some(q => q.prio === HIGH), since: Math.min(...g.members.map(q => q.since)) };
  }).sort((a, b) => a.since - b.since || (a.key < b.key ? -1 : 1));
  return { grouped: true, figures };
}
/** Hover text for a group: "실장 보고 · 승인 1 · 질문 1" (the main session's own entry by kind, then the others counted). */
export function groupTip(g) {
  const main = g.members.find(q => !q.aid), parts = [];
  if (main) parts.push(`실장 ${ROW_KIND_KO[rowKind(main)]}`);
  const counts = new Map();
  for (const q of g.members) if (q !== main) { const k = ROW_KIND_KO[rowKind(q)]; counts.set(k, (counts.get(k) || 0) + 1); }
  for (const [k, n] of counts) parts.push(`${k} ${n}`);
  return parts.join(' · ');
}
/** How a figure joins the line: a real newcomer walks in (or warps) and knocks; a figure whose members were already
 *  waiting (regrouping when the line starts/stops overflowing, a group someone joined, or a step up from +N) just
 *  appears in place. -> { anim, knock } */
export function groupEntry(fig, { known, sameFloor, reduced }) {
  if (!known || reduced) return { anim: null, knock: false };
  const isNew = !fig.members.some(q => known.has(q.key));
  // people already waiting who only regroup (or come in from +N) appear in place: no walk-in, no knock
  return isNew ? { anim: sameFloor ? 'arrive' : 'warp', knock: true } : { anim: null, knock: false };
}

// ---------- 대표실 arrival: knock at the door, then walk to the spot ----------
/** Knock timing (ms; style.css .qf.knock/.qf.entering use the same numbers): the enter animation runs, "똑똑" shows
 *  from 40% of `ms` to its end, then the figure walks from the door to its spot in `walk`. */
export const CEO_KNOCK = { ms: 1350, bubbleAt: 540, walk: 900 };
/** How a new figure joins the 대표실 line. known = keys queued at the previous live render, or null before the first
 *  live render (reload / history replay: whoever is already waiting appears in place, no animation, no knock).
 *  A key that was already queued (e.g. waiting as +N) slides in without knocking; only a real newcomer knocks.
 *  Reduced motion: no animation and no knock (no bubble either). -> { anim: 'arrive'|'warp'|null, knock } */
export function ceoEntry(key, { known, sameFloor, reduced }) {
  if (!known || reduced) return { anim: null, knock: false };
  return { anim: sameFloor ? 'arrive' : 'warp', knock: !known.has(key) };
}

// ---------- hover card hold ----------
/** Keeps a hover-opened card open while the pointer is on its anchor (the character) or on the card itself.
 *  Leaving either starts a grace of `ms`; the card closes only if, when it runs out, the pointer is on neither.
 *  Switching: with a card open, the pointer must REST on another person for `dwell` ms before that person's card
 *  replaces it; passing through (on the way to the card) does not switch. While the pointer is on the card, people
 *  under or next to it never take over. close() decides about pinned cards itself. Timers are injectable for tests. */
export class HoverHold {
  constructor(close, ms = 300, timers = { set: (f, t) => setTimeout(f, t), clear: id => clearTimeout(id) }, dwell = 150) {
    this.close = close; this.ms = ms; this.t = timers; this.dwell = dwell;
    this.on = { anchor: false, card: false }; this.id = null; this.cur = null; this.pend = null; this.pid = null;
  }
  /** The pointer is over person `key`; open(key) shows that person's card. */
  over(key, open) {
    if (this.on.card) return;                             // the open card wins (even where it overlaps someone)
    this.on.anchor = true; this.cancel();
    if (this.cur == null || this.cur === key) { this.clearPend(); if (this.cur !== key) { this.cur = key; open(key); } return; }
    if (this.pend === key) return;                        // still resting on the same person: keep the dwell timer
    this.clearPend(); this.pend = key;
    this.pid = this.t.set(() => { this.pid = null; if (this.pend === key && !this.on.card) { this.pend = null; this.cur = key; open(key); } }, this.dwell);
  }
  /** The pointer left person `key`. */
  out(key) { if (this.pend === key) this.clearPend(); this.leave('anchor'); }
  enter(part) { this.on[part] = true; this.cancel(); if (part === 'card') this.clearPend(); }
  leave(part) {
    this.on[part] = false; this.cancel();
    this.id = this.t.set(() => { this.id = null; if (!this.on.anchor && !this.on.card) this.close(); }, this.ms);
  }
  clearPend() { if (this.pid != null) this.t.clear(this.pid); this.pid = null; this.pend = null; }
  cancel() { if (this.id != null) this.t.clear(this.id); this.id = null; }
  reset() { this.cancel(); this.clearPend(); this.cur = null; this.on.anchor = this.on.card = false; }
}

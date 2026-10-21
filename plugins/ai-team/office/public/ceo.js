// AI Team Office v2 — 대표실 대기열. Who needs the human right now, derived only from office events (no guessing).
// Pure: ceoQueue(events, now) folds the stream; ceoStep(map, e) is the same fold one event at a time (app.js uses it
// incrementally). Keys are `${sid}|${aid || 'main'}`; one entry per character.
//
//   PreToolUse tool=AskUserQuestion           -> kind ask     HIGH  text = ask | target
//   PermissionRequest                         -> kind perm    HIGH  text = ask | `${tool} ${target}`
//   Notification permission_prompt|idle_prompt-> kind notify  HIGH  text = msg (keeps an earlier HIGH entry's text)
//   Stop (main)                               -> kind report  LOW   text = '보고 드렸어요', body = msg (the final report,
//                                                                      up to 4000 chars from the hook; absent under --redact)
//   resolved by: the same character's next PreToolUse/PostToolUse/PostToolUseFailure (an ask entry ignores the
//   AskUserQuestion PreToolUse that opened it), UserPromptSubmit or SessionEnd on that sid, SubagentStop of that aid.

export const HIGH = 'high', LOW = 'low';
const keyOf = e => `${e.sid}|${e.aid || 'main'}`;
const s = v => (typeof v === 'string' ? v : v == null ? '' : typeof v === 'number' ? String(v) : '');
const tsOf = e => { const t = Date.parse(s(e.ts)); return Number.isFinite(t) ? t : 0; };

function open(map, e, kind, prio, text, body = '') {
  const k = keyOf(e), prev = map.get(k);
  const keepSince = prev && prev.prio === prio;
  map.set(k, { key: k, sid: s(e.sid), proj: s(e.proj) || '(unknown)', aid: s(e.aid) || null, atype: s(e.atype) || null,
    kind, prio, text: text.slice(0, 2000), since: keepSince ? prev.since : tsOf(e), tool: s(e.tool) || null,
    ...(body ? { body: body.slice(0, 4001) } : {}) });
}

/** Apply one event to the waiting map (mutates `map`). Returns the keys resolved by this event. */
export function ceoStep(map, e) {
  if (!e || typeof e !== 'object' || typeof e.ev !== 'string' || !s(e.sid)) return [];
  const k = keyOf(e), resolved = [];
  const drop = key => { if (map.delete(key)) resolved.push(key); };
  const dropSid = () => { for (const key of [...map.keys()]) if (key.startsWith(`${e.sid}|`)) drop(key); };
  const ask = s(e.ask).trim();
  switch (e.ev) {
    case 'PreToolUse':
      if (e.tool === 'AskUserQuestion') open(map, e, 'ask', HIGH, ask || s(e.target).trim() || '질문이 있어요');
      else drop(k);
      break;
    case 'PostToolUse': case 'PostToolUseFailure': drop(k); break;
    case 'PermissionRequest': open(map, e, 'perm', HIGH, ask || `${s(e.tool)} ${s(e.target)}`.trim() || '승인이 필요해요'); break;
    case 'Notification': {
      if (e.ntype !== 'permission_prompt' && e.ntype !== 'idle_prompt') break;
      const prev = map.get(k);
      if (prev && prev.prio === HIGH) break;              // the PermissionRequest / question already says more
      const msg = s(e.msg).trim();                        // Claude Code's notification text is English; show it only if it is Korean
      open(map, e, 'notify', HIGH, /[가-힣]/.test(msg) ? msg : e.ntype === 'idle_prompt' ? '입력을 기다리고 있어요' : '승인이 필요해요');
      break;
    }
    case 'Stop': if (!e.aid) { drop(k); open(map, e, 'report', LOW, '보고 드렸어요', s(e.msg).trim()); } break;
    case 'UserPromptSubmit': case 'SessionEnd': dropSid(); break;
    case 'SubagentStop': drop(k); break;
    default: break;
  }
  return resolved;
}

/** The human answered `key` outside the event stream (dashboard relay, or the simulator's local answer): the
 *  character leaves the line now instead of waiting for its next tool event. Returns the resolved keys. */
export function ceoResolve(map, key) { return key && map.delete(key) ? [key] : []; }

/** A LOW report ("보고 드렸어요") is a courtesy, not a question: after `ms` the 실장 bows and goes back to work
 *  even if no new prompt came. Returns the resolved keys. */
export function ceoExpire(map, now, ms = 90000) {
  const out = [];
  for (const [k, x] of map) if (x.prio === LOW && now - x.since > ms) { map.delete(k); out.push(k); }
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
};
/** Queue spots for n people: [{ r (centre, from the right wall), y (feet), face: 'right' }], front first.
 *  Only as many as fit between the door side and the desk (room width w); the rest are counted as +N. */
export function ceoSpots(n, w = 134) {
  const P = CEO_PLAN, fit = Math.max(1, Math.floor((w - P.min - 12 - P.spot0) / P.step) + 1);
  return Array.from({ length: Math.min(n, fit, 4) }, (_, i) => ({ r: P.spot0 + i * P.step, y: P.y, face: 'right' }));
}

// AI Team Office — the one reducer. Shared by server.mjs (classify for --redact), app.js and node:test.
// Pure: reduce(state, event) never mutates its input; it returns a new state (or the same object for bad input).
//
// STATE MACHINE (one character per agent; main session = the character with no aid)
//
//   event / timer                         -> act          room        phase    obs
//   SessionStart, Stop, idle Notification -> idle         desk        idle     observed
//   UserPromptSubmit (main)               -> thinking     desk        prompt   inferred
//   PreToolUse tool                       -> by classify  classify()  tool     observed
//        library=reading  server=running  bench=writing  external=external  meeting=delegating
//        atype=code-reviewer overrides the room with review (reviewing)
//   PostToolUse / PostToolUseFailure      -> (stays)      (stays)     between  observed
//        Failure also sets failedAt -> `flash` (lightning) for FAIL_MS and failCount++
//   main Agent Pre/Post/Failure           -> s.deleg row: pending -> done | failed; expired after PENDING_MS.
//        Pairing: tuid (tool_use_id) when both sides carry it, else (sid, desc, FIFO order).
//   PermissionRequest / Notification(permission_prompt)
//                                         -> blocked      desk        (kept)   observed  (hand raised)
//        cleared by the next PreToolUse/PostToolUse/Stop/UserPromptSubmit of the same character
//   SubagentStart / first event of an aid -> arriving     elevator    between  observed
//   SubagentStop                          -> leaving      elevator    gone     observed  (+verdict stamp)
//
//   tick(now) timers (honest, never invented activity):
//   phase between|prompt and quiet >= THINK_MS     -> thinking at desk (inferred)
//   phase tool and now-toolSince > STUCK_MS        -> stuck=true (amber)
//     except main waiting on a pending Agent call  -> stuck=false, label='위임 대기' (no 💤/stale either)
//   quiet > DOZE_MS                                -> dozing=true (💤)
//   quiet > STALE_MS                               -> obs=stale
//   subagent quiet > HOME_MS (HOME_TOOL_MS in a tool), no SubagentStop
//                                                  -> goes home: leaving via elevator, then removed
//   leaving and now-leaveAt > LEAVE_MS             -> character removed, desk freed
//
// Out of order: lines are applied in arrival order; an event older than the character's last ts
// (late by any amount, typically <2s since hook ts are whole seconds) updates counters/delegations
// and still applies lifecycle events (SubagentStart/SubagentStop), but never moves a room backwards.

export const T = { THINK_MS: 3000, STUCK_MS: 60000, DOZE_MS: 180000, STALE_MS: 300000, LEAVE_MS: 5000, FAIL_MS: 3000,
  HOME_MS: 300000, HOME_TOOL_MS: 600000, PENDING_MS: 600000 };
export const DESKS = 6;
export const MODELS = ['fable', 'opus', 'sonnet', 'haiku'];

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'WebFetch', 'WebSearch', 'ToolSearch', 'Skill', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
const ACT = { library: 'reading', server: 'running', bench: 'writing', external: 'external', meeting: 'delegating', review: 'reviewing', desk: 'working' };
const B_WRITE = new Set(['tee', 'mv', 'cp', 'mkdir', 'touch', 'patch', 'chmod', 'ln', 'rm']);
const B_EXT = new Set(['curl', 'wget', 'gh', 'aws', 'awsx', 'ssh', 'scp', 'rsync', 'http', 'ping', 'dig', 'nc']);
const B_READ = new Set(['rg', 'grep', 'cat', 'head', 'tail', 'less', 'ls', 'find', 'fd', 'wc', 'jq', 'tree', 'stat', 'file', 'du', 'diff', 'which', 'od']);
const GIT_EXT = new Set(['push', 'pull', 'fetch', 'clone']);
const GIT_READ = new Set(['log', 'diff', 'status', 'show', 'blame', 'grep', 'branch']);

/** Model family from 'haiku' | 'claude-haiku-5-5' | anything. */
export function family(s) {
  const m = typeof s === 'string' ? /fable|opus|sonnet|haiku/.exec(s.toLowerCase()) : null;
  return m ? m[0] : null;
}

/** Tokens of the first meaningful shell segment (skips `cd x &&`, env assignments, sudo/time). */
export function bashTokens(cmd) {
  const segs = (typeof cmd === 'string' ? cmd : '').split(/&&|\|\||;|\|/).map(x => x.trim()).filter(Boolean);
  for (const seg of segs) {
    const toks = seg.split(/\s+/).filter(Boolean);
    while (toks.length && (/^\w+=/.test(toks[0]) || ['sudo', 'time', 'env', 'command'].includes(toks[0]))) toks.shift();
    if (toks.length && toks[0] !== 'cd') return { toks, seg };
  }
  return { toks: [], seg: segs[0] || '' };
}

/** Which room a tool call happens in. Bash is sub-classified by the command head. */
export function classify(tool, target) {
  if (typeof tool !== 'string' || !tool) return 'desk';
  if (READ_TOOLS.has(tool)) return 'library';
  if (WRITE_TOOLS.has(tool)) return 'bench';
  if (tool === 'Agent' || tool === 'Task') return 'meeting';
  if (tool.startsWith('mcp__')) return 'external';
  if (tool !== 'Bash') return 'desk';
  const { toks, seg } = bashTokens(target);
  const base = (toks[0] || '').split('/').pop(), a1 = toks[1] || '';
  if ((base === 'sed' && /\s-i/.test(seg)) || B_WRITE.has(base) || /(^|\s)>>?\s*(?!\/dev\/null)[^\s&]/.test(seg)) return 'bench';
  if (B_EXT.has(base) || (base === 'git' && GIT_EXT.has(a1)) || (base === 'npm' && a1 === 'publish')) return 'external';
  if (B_READ.has(base) || base === 'sed' || (base === 'git' && GIT_READ.has(a1))) return 'library';
  return 'server';
}

/** Safe JSONL line parse: object or null. Never throws. */
export function parseLine(line) {
  try { const o = JSON.parse(line); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}

export function initState() {
  return { now: 0, seq: 0, floors: {}, deleg: [], verdicts: {}, agentModel: {}, ticker: [],
    stats: { direct: 0, delegated: 0, failures: 0, events: 0, permissions: 0 } };
}

const tsOf = e => (e && typeof e.ts === 'string' ? Date.parse(e.ts) : NaN);
const valid = e => e && typeof e === 'object' && !Number.isNaN(tsOf(e)) &&
  (typeof e.event === 'string' || (typeof e.ev === 'string' && typeof e.sid === 'string' && e.sid));

// Identity fields must be strings (finite numbers are coerced) or the event is dropped; text fields of a
// wrong type are dropped, the event kept. Coerced so that .slice/.startsWith never throw downstream.
const ID_KEYS = ['ev', 'sid', 'event', 'session_id', 'aid', 'tool', 'ref', 'child', 'tuid', 'agent_id'];
const STR_KEYS = ['proj', 'atype', 'effort', 'mode', 'resolved', 'ntype', 'trigger', 'msg', 'prompt', 'cwd', 'err',
  'verdict', 'note', 'model', 'agent_type', 'room'];
const SUB_KEYS = ['type', 'model', 'effort', 'desc', 'prompt'];
const str = v => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
const head = v => { try { const j = JSON.stringify(v); return typeof j === 'string' ? j.slice(0, 120) : null; } catch { return null; } };

/** Validate + coerce one raw line into the shape the reducer relies on. Returns a new object or null. Never throws. */
export function norm(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  const o = { ...e };
  for (const k of ID_KEYS) if (o[k] != null) { const v = str(o[k]); if (v === undefined) return null; o[k] = v; }
  for (const k of STR_KEYS) if (o[k] != null) { const v = str(o[k]); if (v === undefined) delete o[k]; else o[k] = v; }
  if (o.target != null) o.target = str(o.target) ?? head(o.target);
  if (o.sub != null) {
    const sub = {};
    if (typeof o.sub === 'object' && !Array.isArray(o.sub)) for (const k of SUB_KEYS) { const v = str(o.sub[k]); if (v !== undefined) sub[k] = v; }
    o.sub = sub;
  }
  if (o.dur != null && !Number.isFinite(o.dur)) delete o.dur;
  if (o.response != null) { const m = str(o.response.resolvedModel); o.response = m ? { resolvedModel: m } : {}; }
  return valid(o) ? o : null;
}

/** Pure single-event reducer. Invalid input returns the same state object. */
export function reduce(state, e) {
  const n = norm(e);
  if (!n) return state;
  const s = structuredClone(state);
  apply(s, n);
  return s;
}

/** Batch form (one clone for many events) — same semantics as folding reduce. */
export function reduceAll(state, events) {
  const s = structuredClone(state);
  for (const e of events) { const n = norm(e); if (n) apply(s, n); }
  return s;
}

function setPlace(s, c, room, act) {
  if (c.room !== room) { c.visits.push({ room, seq: ++s.seq }); if (c.visits.length > 8) c.visits.shift(); }
  c.room = room; c.act = act;
}

function newChar(s, room, e, ms) {
  const aid = e.aid || null;
  const c = { id: aid || 'main', aid, atype: aid ? (e.atype || 'agent') : 'Fable', model: 'fable', effort: e.effort || null,
    room: 'desk', act: 'idle', phase: 'idle', obs: 'observed', tool: null, target: null, toolSince: null,
    lastTs: ms, enteredAt: ms, blocked: false, failedAt: null, flash: false, failCount: 0, stuck: false, dozing: false,
    leaveAt: null, verdict: null, msg: null, desk: null, label: null, visits: [] };
  if (aid) {
    const pend = [...s.deleg].reverse().find(d => d.sid === room.sid && (d.child === aid || (d.status === 'pending' && d.type === c.atype)));
    c.model = s.agentModel[aid] || (pend && (family(pend.resolved) || family(pend.intended))) || 'unknown';
    if (pend && !c.effort) c.effort = pend.effort || null;
    const free = room.desks.indexOf(null);
    if (free >= 0) { room.desks[free] = aid; c.desk = free; }
    c.phase = 'between'; setPlace(s, c, 'elevator', 'arriving');
  } else c.visits.push({ room: 'desk', seq: ++s.seq });
  return c;
}

function roomFor(s, e, ms) {
  const proj = e.proj || '(unknown)';
  const f = s.floors[proj] ||= { proj, lastTs: 0, rooms: {} };
  const r = f.rooms[e.sid] ||= { sid: e.sid, proj, lastTs: 0, ended: false, desks: Array(DESKS).fill(null), chars: {} };
  f.lastTs = Math.max(f.lastTs, ms); r.lastTs = Math.max(r.lastTs, ms);
  return r;
}

function findChar(s, aid) {
  for (const f of Object.values(s.floors)) for (const r of Object.values(f.rooms)) if (r.chars[aid]) return r.chars[aid];
  return null;
}

function pushTicker(s, ms, e, who, text, kind) {
  s.ticker.unshift({ seq: ++s.seq, ts: ms, sid: e.sid || e.session_id || '', proj: e.proj || '', who, text, kind });
  if (s.ticker.length > 30) s.ticker.length = 30;
}

/** Agent Pre rows still waiting for their Post become `expired` after PENDING_MS. */
function expire(s, now) {
  for (const d of s.deleg) if (d.status === 'pending' && now - d.startMs > T.PENDING_MS) d.status = 'expired';
}

/** Pending delegation row for a main Agent Post/Failure: same tuid when known, else same desc —
 *  oldest first for Post (FIFO), newest first for Failure. Rows carrying a different tuid never match. */
function pairDeleg(s, e, ms, newest) {
  expire(s, ms);
  const open = s.deleg.filter(d => d.sid === e.sid && d.status === 'pending');
  if (e.tuid) { const t = open.find(d => d.tuid === e.tuid); if (t) return t; }
  const desc = e.sub?.desc;
  const cand = open.filter(d => !(e.tuid && d.tuid) && (!desc || d.desc === desc));
  return (newest ? cand.at(-1) : cand[0]) || null;
}

/** Lines from delegation.jsonl (they carry `event`, not `ev`). Only verdicts and model hints matter. */
function applyDelegation(s, e, ms) {
  if (e.event === 'PostToolUse' && e.agent_id) {
    s.agentModel[e.agent_id] ||= family(e.response && e.response.resolvedModel) || family(e.model) || 'unknown';
    return;
  }
  if (e.event !== 'verdict' || !e.ref || !['ok', 'rework', 'fail'].includes(e.verdict)) return;
  s.verdicts[e.ref] = { v: e.verdict, note: e.note || '', ts: ms };
  for (const d of s.deleg) if (d.child === e.ref) d.verdict = e.verdict;
  const c = findChar(s, e.ref);
  if (c) c.verdict = e.verdict;
  pushTicker(s, ms, e, 'Fable', `판정 ${e.verdict.toUpperCase()} · ${e.ref.slice(0, 4)}`, 'verdict');
}

function apply(s, e) {
  const ms = tsOf(e);
  s.now = Math.max(s.now, ms);
  s.stats.events++;
  if (typeof e.event === 'string' && typeof e.ev !== 'string') return applyDelegation(s, e, ms);
  const r = roomFor(s, e, ms), key = e.aid || 'main';
  const c = r.chars[key] ||= newChar(s, r, e, ms);
  const late = ms < c.lastTs, lifecycle = e.ev === 'SubagentStart' || e.ev === 'SubagentStop';
  if (!late) c.lastTs = ms;
  if (e.effort) c.effort = e.effort;
  if (e.atype && c.aid) c.atype = e.atype;
  const who = c.aid ? `${c.atype}·${c.aid.slice(0, 4)}` : 'Fable';
  const sub = e.sub && typeof e.sub === 'object' ? e.sub : null;

  // --- bookkeeping: always applied, even for late lines ---
  if (e.ev === 'PreToolUse' && !c.aid) {
    if (e.tool === 'Agent') {
      s.stats.delegated++;
      s.deleg.push({ id: ++s.seq, sid: e.sid, proj: r.proj, type: sub?.type || 'general-purpose', intended: sub?.model || null,
        effort: sub?.effort || null, desc: sub?.desc || e.target || '', tuid: e.tuid || null, status: 'pending',
        startMs: ms, child: null, resolved: null, endMs: null, verdict: null });
      if (s.deleg.length > 500) s.deleg.shift();
    } else s.stats.direct++;
  }
  if (e.ev === 'PostToolUseFailure' && e.tool === 'Agent' && !c.aid) {
    const d = pairDeleg(s, e, ms, true);
    if (d) { d.status = 'failed'; d.endMs = ms; }
  }
  if (e.ev === 'PostToolUse' && e.tool === 'Agent' && !c.aid && e.child) {
    const d = pairDeleg(s, e, ms, false);
    if (d) {
      d.status = 'done'; d.child = e.child; d.resolved = e.resolved || null;
      if (s.verdicts[e.child]) d.verdict = s.verdicts[e.child].v;
      s.agentModel[e.child] = family(e.resolved) || family(d.intended) || 'unknown';
      const kid = r.chars[e.child];
      if (kid) { kid.model = s.agentModel[e.child]; if (!kid.effort) kid.effort = d.effort; }
    }
  }
  if (e.ev === 'SubagentStop') {
    const d = s.deleg.find(x => x.child === e.aid);
    if (d && !d.endMs) d.endMs = ms;
  }
  if (e.ev === 'PostToolUseFailure') s.stats.failures++;
  if (e.ev === 'PermissionRequest' || (e.ev === 'Notification' && e.ntype === 'permission_prompt')) s.stats.permissions++;

  pushTicker(s, ms, e, who, tickerText(e), e.ev);
  if (late && !lifecycle) return;

  // --- character state machine (see header) ---
  const clearBlock = () => { c.blocked = false; };
  switch (e.ev) {
    case 'SessionStart': clearBlock(); c.phase = 'idle'; c.obs = 'observed'; setPlace(s, c, 'desk', 'idle'); r.ended = false; break;
    case 'UserPromptSubmit': clearBlock(); c.phase = 'prompt'; c.obs = 'inferred'; c.target = null; setPlace(s, c, 'desk', 'thinking'); break;
    case 'PreToolUse': {
      clearBlock(); c.phase = 'tool'; c.obs = 'observed'; c.tool = e.tool || null; c.target = e.target || null; c.toolSince = ms;
      const room = c.atype === 'code-reviewer' && c.aid ? 'review' : (e.room || classify(e.tool, e.target));
      setPlace(s, c, room, ACT[room]);
      break;
    }
    case 'PostToolUse': clearBlock(); c.phase = 'between'; c.obs = 'observed'; break;
    case 'PostToolUseFailure': clearBlock(); c.phase = 'between'; c.failedAt = ms; c.flash = true; c.failCount++; break;
    case 'PermissionRequest': c.blocked = true; c.obs = 'observed'; if (e.target) c.target = e.target; setPlace(s, c, 'desk', 'blocked'); break;
    case 'Notification':
      if (e.ntype === 'permission_prompt') { c.blocked = true; setPlace(s, c, 'desk', 'blocked'); }
      else if (e.ntype === 'idle_prompt') { c.phase = 'idle'; setPlace(s, c, 'desk', 'idle'); }
      break;
    case 'Stop': clearBlock(); c.phase = 'idle'; c.obs = 'observed'; c.msg = typeof e.msg === 'string' && e.msg ? e.msg : null; setPlace(s, c, 'desk', 'idle'); break;
    case 'SessionEnd': r.ended = true; c.phase = 'idle'; c.obs = 'stale'; setPlace(s, c, 'desk', 'idle'); break;
    case 'SubagentStart': break; // newChar already placed it at the elevator
    case 'SubagentStop':
      clearBlock(); c.phase = 'gone'; c.leaveAt = Math.max(ms, c.lastTs); c.msg = typeof e.msg === 'string' && e.msg ? e.msg : null; c.obs = 'observed'; c.label = null;
      c.verdict = s.verdicts[c.id]?.v || null;
      setPlace(s, c, 'elevator', 'leaving');
      break;
    default: break;
  }
}

function tickerText(e) {
  const raw = e.target ? String(e.target) : '';
  const short = e.tool !== 'Bash' && /^[~/]/.test(raw) ? raw.split('/').filter(Boolean).pop() : raw;
  const t = short ? ` ${short.slice(0, 60)}` : '';
  switch (e.ev) {
    case 'PreToolUse': return e.tool === 'Agent' ? `위임 → ${e.sub?.type || '?'} (${e.sub?.model || '모델 미지정'})` : `${e.tool}${t}`;
    case 'PostToolUse': return `${e.tool} 완료${e.dur != null ? ` ${(e.dur / 1000).toFixed(1)}초` : ''}`;
    case 'PostToolUseFailure': return `${e.tool} 실패`;
    case 'PermissionRequest': return `승인 요청 ${e.tool || ''}`;
    case 'Notification': return e.ntype === 'permission_prompt' ? '승인 대기 알림' : `알림 ${e.ntype || ''}`;
    case 'UserPromptSubmit': return '사람이 지시함';
    case 'SubagentStart': return '엘리베이터 도착';
    case 'SubagentStop': return '작업 끝, 퇴장';
    case 'Stop': return '턴 종료, 대기';
    default: return e.ev;
  }
}

/** Time-based transitions. Pure: returns a new state. */
export function tick(state, now) {
  const s = structuredClone(state);
  s.now = now;
  expire(s, now);
  for (const f of Object.values(s.floors)) for (const r of Object.values(f.rooms)) {
    for (const c of Object.values(r.chars)) {
      const home = c.phase === 'tool' ? T.HOME_TOOL_MS : T.HOME_MS;
      if (c.aid && c.leaveAt == null && !c.blocked && now - c.lastTs > home) {   // no SubagentStop: goes home
        c.phase = 'gone'; c.obs = 'stale'; c.label = null; c.leaveAt = c.lastTs + home;
        setPlace(s, c, 'elevator', 'leaving');
        pushTicker(s, now, r, `${c.atype}·${c.aid.slice(0, 4)}`, `${home / 60000}분 무활동, 퇴근 (종료 신호 없음)`, 'home');
      }
      if (c.leaveAt != null) {
        if (now - c.leaveAt > T.LEAVE_MS) { delete r.chars[c.id]; if (c.desk != null && r.desks[c.desk] === c.id) r.desks[c.desk] = null; }
        continue;
      }
      const quiet = now - c.lastTs;
      // Main blocked on a synchronous Agent call is waiting for its delegate, not stuck or asleep.
      const waiting = !c.aid && c.phase === 'tool' && c.tool === 'Agent' && s.deleg.some(d => d.sid === r.sid && d.status === 'pending');
      c.flash = c.failedAt != null && now - c.failedAt < T.FAIL_MS;
      const long = c.phase === 'tool' && !c.blocked && c.toolSince != null && now - c.toolSince > T.STUCK_MS;
      c.stuck = long && !waiting;
      c.label = long && waiting ? '위임 대기' : null;
      if ((c.phase === 'between' || c.phase === 'prompt') && !c.blocked && quiet >= T.THINK_MS) {
        c.obs = 'inferred'; setPlace(s, c, 'desk', 'thinking');
      }
      c.dozing = !waiting && quiet > T.DOZE_MS;
      if (quiet > T.STALE_MS && !waiting) c.obs = 'stale';
    }
  }
  return s;
}

/** Compliance meter (the headline widget): intended vs resolved model, direct vs delegated, verdicts, rework rate. */
export function compliance(s) {
  const rows = s.deleg.map(d => {
    const actual = family(d.resolved), want = family(d.intended);
    let match = d.status === 'failed' || d.status === 'expired' ? d.status : 'pending';
    if (want && actual) match = want === actual ? 'yes' : 'no';
    else if (!want && actual) match = actual === 'fable' ? 'no' : 'unset';
    return { ...d, want, actual, match, durMs: d.endMs ? d.endMs - d.startMs : null, verdict: d.verdict || s.verdicts[d.child]?.v || null };
  });
  const byModel = {};
  const bucket = m => (byModel[m] ||= { n: 0, durSum: 0, durN: 0, ok: 0, rework: 0, fail: 0 });
  for (const r of rows) {
    const b = bucket(r.actual || r.want || 'unknown');
    b.n++;
    if (r.durMs != null) { b.durSum += r.durMs; b.durN++; }
  }
  const verdicts = { ok: 0, rework: 0, fail: 0 };
  for (const [ref, v] of Object.entries(s.verdicts)) { verdicts[v.v]++; bucket(s.agentModel[ref] || 'unknown')[v.v]++; }
  for (const b of Object.values(byModel)) {
    const judged = b.ok + b.rework + b.fail;
    b.avgMs = b.durN ? Math.round(b.durSum / b.durN) : null;
    b.reworkRate = judged ? (b.rework + b.fail) / judged : null;
  }
  const yes = rows.filter(r => r.match === 'yes').length, no = rows.filter(r => r.match === 'no').length;
  const unset = rows.filter(r => r.match === 'unset').length;
  const { direct, delegated } = s.stats;
  return { rows, byModel, verdicts, yes, no, unset, matchRate: yes + no ? yes / (yes + no) : null,
    direct, delegated, directRatio: direct + delegated ? direct / (direct + delegated) : null };
}

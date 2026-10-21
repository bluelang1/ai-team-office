// 대표실 relay: answer Claude Code's permission prompts and AskUserQuestion from the dashboard.
// A hook (hooks/ceo-relay.sh, or an `http` hook on /relay/hook) POSTs its raw hook input and long-polls;
// the dashboard answers with POST /relay/answer (or sends it back undecided with POST /relay/release). Decisions come ONLY from answer(): the relay never allows
// anything by itself. Every other ending (timeout, hook killed, the terminal answered first) yields "no decision",
// which makes the hook print nothing so Claude Code's native prompt applies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export const WAIT_DEFAULT = 170000, WAIT_MIN = 100, WAIT_MAX = 540000;
export const MESSAGE_MAX = 500, ANSWER_MAX = 500;
const PENDING_MAX = 100, DONE_MAX = 500, CLIP = 4000;
const SID = /^[A-Za-z0-9_-]{1,128}$/;
const CTRL_G = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** waitMs query value -> integer in [WAIT_MIN, WAIT_MAX]; missing/garbage -> WAIT_DEFAULT. */
export function parseWait(v) {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n)) return WAIT_DEFAULT;
  return Math.min(WAIT_MAX, Math.max(WAIT_MIN, Math.round(n)));
}

/** Control characters (incl. newlines) -> one space, trimmed, capped at `max` code points. */
export const cleanText = (s, max) => Array.from(String(s).replace(CTRL_G, ' ').trim()).slice(0, max).join('');

/** Same "key argument" office-events.sh logs as `target` (jq `//` chain, command capped at 120 code points). */
export function targetOf(i) {
  if (!i || typeof i !== 'object') return null;
  const ok = v => v != null && v !== false;
  for (const k of ['file_path', 'path', 'pattern', 'url', 'query']) if (ok(i[k])) return typeof i[k] === 'string' ? i[k] : JSON.stringify(i[k]);
  if (typeof i.command === 'string') { const c = Array.from(i.command); return c.length > 120 ? c.slice(0, 120).join('') + '…' : i.command; }
  for (const k of ['description', 'skill', 'name']) if (ok(i[k])) return typeof i[k] === 'string' ? i[k] : JSON.stringify(i[k]);
  return null;
}

/** Display copy of a tool input: long strings clipped, depth/size bounded. Returns [value, clipped]. */
function clipInput(v) {
  let clipped = false, budget = 32 * 1024;
  const walk = (x, d) => {
    if (typeof x === 'string') {
      const s = x.length > CLIP ? (clipped = true, x.slice(0, CLIP) + '…') : x;
      budget -= s.length; return s;
    }
    if (x === null || typeof x !== 'object') return x;
    if (d > 6 || budget <= 0) { clipped = true; return '…'; }
    if (Array.isArray(x)) return x.slice(0, 50).map(y => walk(y, d + 1));
    const o = {};
    for (const [k, y] of Object.entries(x).slice(0, 50)) { if (budget <= 0) { clipped = true; break; } o[k] = walk(y, d + 1); }
    return o;
  };
  return [walk(v, 0), clipped];
}

/** AskUserQuestion questions, keeping only what the dashboard needs to render and answer them. */
function cleanQuestions(qs) {
  return qs.map(q => ({
    question: q.question,
    header: typeof q.header === 'string' ? q.header : '',
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).filter(o => o && typeof o.label === 'string')
      .map(o => ({ label: o.label, description: typeof o.description === 'string' ? o.description : '' })),
  }));
}

/** Validate a raw hook input. Returns {error} or {kind}. */
export function classifyInput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'body must be a hook input object' };
  if (typeof raw.session_id !== 'string' || !SID.test(raw.session_id)) return { error: 'bad session_id' };
  if (typeof raw.tool_name !== 'string' || !raw.tool_name || raw.tool_name.length > 200) return { error: 'bad tool_name' };
  if (raw.tool_input != null && (typeof raw.tool_input !== 'object' || Array.isArray(raw.tool_input))) return { error: 'bad tool_input' };
  if (raw.hook_event_name === 'PermissionRequest') return { kind: 'permission' };
  if (raw.hook_event_name === 'PreToolUse' && raw.tool_name === 'AskUserQuestion') {
    const qs = raw.tool_input && raw.tool_input.questions;
    if (!Array.isArray(qs) || !qs.length || qs.length > 10 || !qs.every(q => q && typeof q.question === 'string' && q.question))
      return { error: 'AskUserQuestion needs tool_input.questions[] with question text' };
    if (new Set(qs.map(q => q.question)).size !== qs.length) return { error: 'duplicate question text' };
    return { kind: 'question' };
  }
  return { error: 'only PermissionRequest and PreToolUse(AskUserQuestion) are relayed' };
}

/** Validate a dashboard decision for an item. Returns {error} or {value} (normalised). */
export function validateDecision(item, d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { error: 'decision must be an object' };
  if (item.kind === 'permission') {
    for (const k of Object.keys(d)) if (k !== 'behavior' && k !== 'message') return { error: `unknown decision key: ${k.slice(0, 40)}` };
    if (d.behavior !== 'allow' && d.behavior !== 'deny') return { error: 'behavior must be "allow" or "deny"' };
    if (d.message != null && (typeof d.message !== 'string' || d.behavior !== 'deny')) return { error: 'message is a string, only with deny' };
    const message = d.message ? cleanText(d.message, MESSAGE_MAX) : '';
    return { value: d.behavior === 'deny' && message ? { behavior: 'deny', message } : { behavior: d.behavior } };
  }
  for (const k of Object.keys(d)) if (k !== 'answers') return { error: `unknown decision key: ${k.slice(0, 40)}` };
  const a = d.answers;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { error: 'answers must be an object keyed by question text' };
  const byText = new Map(item.questions.map(q => [q.question, q]));
  for (const k of Object.keys(a)) if (!byText.has(k)) return { error: `answers has a key that is not a question: ${k.slice(0, 60)}` };
  const answers = {};
  for (const [text, q] of byText) {
    let v = a[text];
    if (Array.isArray(v)) {
      if (!q.multiSelect) return { error: `"${text.slice(0, 60)}" is single-select; answer with one string` };
      if (!v.length || !v.every(x => typeof x === 'string' && x.trim())) return { error: 'multi-select answer must be non-empty strings' };
      v = v.map(x => cleanText(x, ANSWER_MAX)).join(', ');      // doc: "Multi-select answers join labels with commas"
    }
    if (typeof v !== 'string' || !v.trim()) return { error: `missing answer for "${text.slice(0, 60)}"` };
    answers[text] = cleanText(v, ANSWER_MAX);
  }
  return { value: { answers } };
}

/** The exact hook JSON for a decision (same shapes hooks/ceo-relay.sh prints). No decision -> {} (= no opinion).
 *  Only behavior/message and answers are ever emitted: no updatedPermissions, no rewritten tool input. */
export function hookOutput(kind, toolInput, decision) {
  if (!decision) return {};
  if (kind === 'permission') {
    const dec = decision.behavior === 'allow' ? { behavior: 'allow' }
      : { behavior: 'deny', ...(decision.message ? { message: decision.message } : {}) };
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: dec } };
  }
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { ...(toolInput || {}), answers: decision.answers } } };
}

const tsMs = e => Date.parse(e && (e.ts || ''));
const POST_TOOL = ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied'];

export class Relay {
  /** broadcast(obj): SSE `event: ceo` fan-out. redactTarget(tool, target): --redact masking for display. */
  /** projOf(cwd): project name for item.proj (server passes the shared project-root resolver). */
  constructor({ broadcast = () => {}, redact = false, logFile = null, log = () => {}, redactTarget = (t, x) => x,
    now = () => Date.now(), projOf = cwd => path.basename(cwd) } = {}) {
    Object.assign(this, { broadcast, redact, logFile, log, redactTarget, now, projOf });
    this.pending = new Map();     // id -> {item, toolInput, settle, timer}
    this.done = new Map();        // id -> by   (recent, so a late second answer gets 409 not 404)
  }

  list() { return [...this.pending.values()].map(p => p.item); }

  /** Register a hook input. Returns {error, status} or {id, item, wait: Promise<{decision, by}>}.
   *  alive(): false once the hook's connection is gone (answer() then refuses with 410 instead of answering nobody). */
  ask(raw, waitMs = WAIT_DEFAULT, { alive = () => true } = {}) {
    const c = classifyInput(raw);
    if (c.error) return { error: c.error, status: 400 };
    if (this.pending.size >= PENDING_MAX) return { error: 'too many pending items', status: 503 };
    const ti = raw.tool_input || {}, t0 = this.now();
    const target = targetOf(ti);
    const item = { id: crypto.randomUUID(), kind: c.kind, sid: raw.session_id,
      proj: typeof raw.cwd === 'string' ? (this.projOf(raw.cwd) || path.basename(raw.cwd)) : '', tool: raw.tool_name, createdAt: t0, expiresAt: t0 + waitMs };
    if (typeof raw.agent_id === 'string' && raw.agent_id) item.aid = raw.agent_id;
    if (typeof raw.agent_type === 'string' && raw.agent_type) item.atype = raw.agent_type;
    if (typeof raw.tool_use_id === 'string') item.tuid = raw.tool_use_id;
    if (typeof raw.permission_mode === 'string') item.mode = raw.permission_mode;
    if (this.redact) {
      item.target = target == null ? null : this.redactTarget(raw.tool_name, target);
      item.input = {};
    } else {
      if (typeof raw.cwd === 'string') item.cwd = raw.cwd;
      item.target = target;
      const [input, clipped] = clipInput(c.kind === 'question' ? { ...ti, questions: undefined } : ti);
      item.input = input;
      if (clipped) item.clipped = true;
    }
    if (c.kind === 'question') item.questions = cleanQuestions(ti.questions);   // kept under --redact: needed to answer
    const p = { item, toolInput: ti, rawTarget: target, alive };
    const wait = new Promise(res => { p.settle = res; });
    p.timer = setTimeout(() => this.finish(item.id, 'terminal', null, 'timeout'), waitMs);
    if (p.timer.unref) p.timer.unref();
    this.pending.set(item.id, p);
    this.broadcast({ type: 'ask', item });
    return { id: item.id, item, wait, toolInput: ti };
  }

  /** Dashboard answer. Returns {status, error?, item?}. Exactly one answer wins. */
  answer(id, decision) {
    if (typeof id !== 'string') return { status: 400, error: 'id must be a string' };
    const p = this.pending.get(id);
    const gone = { status: 410, error: 'the hook that asked is gone (Claude Code killed it or its hook timeout passed); answer in the terminal' };
    if (!p) {
      if (this.done.get(id) === 'withdrawn') return gone;
      return this.done.has(id) ? { status: 409, error: `already resolved by ${this.done.get(id)}` } : { status: 404, error: 'unknown or expired id' };
    }
    const v = validateDecision(p.item, decision);
    if (v.error) return { status: 400, error: v.error };
    let open = true;
    try { open = p.alive() !== false; } catch { open = false; }
    if (!open) { this.withdraw(id); return gone; }
    this.finish(id, 'dashboard', v.value);
    return { status: 200, item: p.item, decision: v.value };
  }

  /** Dashboard "돌려보내기": end the long-poll with NO decision (the hook prints nothing, so the native terminal
   *  prompt takes over). Never allows or denies. Same 404/409/410 rules as answer(). */
  release(id) {
    if (typeof id !== 'string') return { status: 400, error: 'id must be a string' };
    const p = this.pending.get(id);
    const gone = { status: 410, error: 'the hook that asked is gone; nothing to release' };
    if (!p) {
      if (this.done.get(id) === 'withdrawn') return gone;
      return this.done.has(id) ? { status: 409, error: `already resolved by ${this.done.get(id)}` } : { status: 404, error: 'unknown or expired id' };
    }
    let open = true;
    try { open = p.alive() !== false; } catch { open = false; }
    if (!open) { this.withdraw(id); return gone; }
    this.finish(id, 'dashboard', null, 'released');
    return { status: 200, item: p.item };
  }

  /** The hook's HTTP request went away (hook killed / Claude Code moved on). */
  withdraw(id) { return this.finish(id, 'withdrawn', null); }

  /** Nobody can answer: pending items (all, or only those of `kind`) end now with no decision. */
  releaseAll(reason = 'no-viewer', kind = null) {
    let n = 0;
    for (const [id, p] of [...this.pending]) if ((!kind || p.item.kind === kind) && this.finish(id, reason, null, reason)) n++;
    return n;
  }

  /** One live office-events line. Resolves items the terminal (or the session's progress) has made moot. */
  observe(e) {
    if (!e || typeof e.ev !== 'string' || typeof e.sid !== 'string' || !this.pending.size) return;
    const ts = tsMs(e);
    for (const [id, p] of this.pending) {
      const it = p.item;
      if (it.sid !== e.sid) continue;
      if (Number.isNaN(ts) || ts < Math.floor(it.createdAt / 1000) * 1000) continue;   // hook ts are whole seconds
      const sameAgent = (e.aid || null) === (it.aid || null);
      let hit = e.ev === 'UserPromptSubmit' || e.ev === 'SessionEnd'
        || (sameAgent && e.ev === (it.aid ? 'SubagentStop' : 'Stop'));
      if (!hit && sameAgent && POST_TOOL.includes(e.ev) && e.tool === it.tool) {
        // Same tool_use_id when both sides have one; otherwise the same NON-null target. A null target never matches.
        hit = it.tuid && e.tuid ? e.tuid === it.tuid
          : p.rawTarget != null && e.target != null && e.target === p.rawTarget;
      }
      if (hit) this.finish(id, 'terminal', null, e.ev);
    }
  }

  finish(id, by, decision, reason) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    clearTimeout(p.timer);
    this.done.set(id, by);
    if (this.done.size > DONE_MAX) this.done.delete(this.done.keys().next().value);
    this.record(p.item, by, decision, reason);
    if (by === 'dashboard' && decision) this.broadcast({ type: 'answered', id, by });
    else if (by === 'withdrawn') this.broadcast({ type: 'withdrawn', id });
    else this.broadcast({ type: 'resolved', id, by, reason });
    p.settle({ decision, by });
    return true;
  }

  record(item, by, decision, reason) {
    if (!this.logFile) return;
    let d = decision;
    if (d && this.redact) d = d.answers ? { answered: Object.keys(d.answers).length } : { behavior: d.behavior };
    const line = { ts: new Date(this.now()).toISOString(), id: item.id, sid: item.sid, tool: item.tool, kind: item.kind, by, decision: d || null };
    if (item.aid) line.aid = item.aid;
    if (item.proj) line.proj = item.proj;
    if (reason) line.reason = reason;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify(line) + '\n', { mode: 0o600 });
    } catch (err) { this.log('ceo-decisions log failed:', err.message); }
  }
}

// ---------- who is calling? (answer/release self-approval guard) ----------
// A dashboard answer must come from a person at a browser, never from a Claude Code agent's own Bash (curl, node, …).
// On macOS the TCP peer of the request is resolved to a PID with lsof and its process ancestry is walked with ps: if a
// Claude Code CLI is an ancestor, the caller is an agent and is refused. Browsers are never descendants of `claude`.
// This is a guard against accidental / agent self-approval, not against a determined same-user process (README).
export const AGENT_COMM = /^claude$|claude-code|node.*claude/i;
const ANCESTRY_MAX = 40, PEER_TIMEOUT_MS = 1500;

/** Default runner: execFile with argv (no shell), 1.5 s timeout. Resolves {code, stdout}; rejects only when the tool
 *  could not run at all (missing / not permitted / timed out). lsof exits 1 when nothing matched: that is a result. */
export function execRunner(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: PEER_TIMEOUT_MS, maxBuffer: 256 * 1024 }, (err, stdout) => {
      if (err && (typeof err.code !== 'number' || err.killed || err.signal)) return reject(err);
      resolve({ code: err ? err.code : 0, stdout: String(stdout || '') });
    });
  });
}

/** `lsof -Fpc` output -> [{pid, comm}]. */
export function parseLsof(out) {
  const procs = [];
  for (const line of String(out).split('\n')) {
    if (line[0] === 'p') procs.push({ pid: Number(line.slice(1)), comm: '' });
    else if (line[0] === 'c' && procs.length) procs.at(-1).comm = line.slice(1);
  }
  return procs.filter(p => Number.isInteger(p.pid) && p.pid > 0);
}

const isAgentComm = comm => { const c = String(comm || '').trim(); return AGENT_COMM.test(path.basename(c)) || /claude-code|node.*claude/i.test(c); };

/** Classify the process on the other end of a loopback TCP connection.
 *  Returns {verdict: 'agent'|'ok'|'unknown'|'unchecked', chain, detail}:
 *   agent     — a Claude Code CLI is in the caller's ancestry (refuse)
 *   ok        — the caller was found and no Claude Code ancestor exists
 *   unknown   — the tools ran but the caller could not be found (refuse: it hung up or hid)
 *   unchecked — not macOS, or lsof/ps could not run (fall back to the Origin + token checks) */
export async function checkCaller(remotePort, { run = execRunner, selfPid = process.pid, platform = process.platform } = {}) {
  if (platform !== 'darwin') return { verdict: 'unchecked', chain: [], detail: `platform ${platform}` };
  if (!Number.isInteger(remotePort) || remotePort <= 0 || remotePort > 65535) return { verdict: 'unknown', chain: [], detail: 'no peer port' };
  let lsof;
  try { lsof = await run('lsof', ['-nP', `-iTCP@127.0.0.1:${remotePort}`, '-sTCP:ESTABLISHED', '-Fpc']); }
  catch (err) { return { verdict: 'unchecked', chain: [], detail: `lsof: ${err.code || err.message}` }; }
  const peer = parseLsof(lsof.stdout).find(p => p.pid !== selfPid);
  if (!peer) return { verdict: 'unknown', chain: [], detail: 'caller process not found' };
  const chain = [{ pid: peer.pid, comm: peer.comm }];
  if (isAgentComm(peer.comm)) return { verdict: 'agent', chain, detail: peer.comm };
  let pid = peer.pid;
  for (let hop = 0; hop < ANCESTRY_MAX; hop++) {
    let ps;
    try { ps = await run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)]); }
    catch (err) { return { verdict: 'unchecked', chain, detail: `ps: ${err.code || err.message}` }; }
    const m = /^\s*(\d+)\s+(.*?)\s*$/.exec(String(ps.stdout).split('\n').find(l => l.trim()) || '');
    if (!m) break;                                                    // process vanished mid-walk: chain so far stands
    const ppid = Number(m[1]);
    if (!chain.at(-1).comm) chain.at(-1).comm = m[2];
    if (isAgentComm(m[2])) return { verdict: 'agent', chain, detail: m[2] };
    if (ppid <= 1 || ppid === pid) break;
    pid = ppid;
    chain.push({ pid, comm: '' });
  }
  return { verdict: 'ok', chain, detail: '' };
}

/** Test runner: pretends the caller is pid 90001 whose ancestry is `comms` (child first). */
export function fakeAncestryRunner(comms) {
  const base = 90001;
  return async (cmd, args) => {
    if (cmd === 'lsof') return { code: 0, stdout: `p${process.pid}\ncnode\np${base}\nc${comms[0] || 'curl'}\n` };
    const i = Number(args.at(-1)) - base;
    if (!(i >= 0 && i < comms.length)) return { code: 1, stdout: '' };
    return { code: 0, stdout: `${i + 1 < comms.length ? base + i + 1 : 1} ${comms[i]}\n` };
  };
}

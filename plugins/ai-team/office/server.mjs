#!/usr/bin/env node
// AI Team Office server — zero deps. Serves public/ and GET /events (SSE).
// Live mode: replays today's (local-time) lines of office-events.jsonl + delegation.jsonl, then tails both.
// Replay mode: --replay <file> --speed N re-emits a jsonl file with time compression (ts rewritten to now).
// 대표실 relay (relay.mjs): hooks long-poll POST /relay/ask|/relay/hook, the dashboard answers via POST /relay/answer
// or sends a card back undecided via POST /relay/release (no decision: the terminal prompt takes over).
// Usage: token records from today's Claude Code transcripts (usage.mjs), `event: usage-batch` then `event: usage`.
// Imported (tests) it only exports helpers; it listens only when run as the main script.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, parseLine, norm } from './public/reducer.js';
import { Usage, loadJson, scanProjects, projectName, encodeDir } from './usage.mjs';
import { focusSession, SID_RE, makeLimiter } from './focus.mjs';
import { Limits } from './limits.mjs';
import crypto from 'node:crypto';
import { Relay, parseWait, hookOutput, checkCaller, execRunner, fakeAncestryRunner } from './relay.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
// Shown next to the title so a stale install is obvious at a glance; null when the manifest is missing or unreadable.
const VERSION = (() => { try { const v = JSON.parse(fs.readFileSync(path.join(ROOT, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version; return typeof v === 'string' ? v : null; } catch { return null; } })();
const HOME = os.homedir();

function parseArgs(argv) {
  const o = { port: 4747, replay: null, speed: 20, redact: false, logs: path.join(HOME, '.claude', 'logs'),
    usage: true, statusline: path.join(HOME, '.claude', 'logs', 'statusline'), projects: path.join(HOME, '.claude', 'projects'), config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--port') { const p = Number(next()); o.port = Number.isInteger(p) && p >= 0 && p < 65536 ? p : 4747; }   // 0 = any free port
    else if (a === '--replay') o.replay = path.resolve(next() || '');
    else if (a === '--speed') o.speed = Math.max(0.1, Number(next()) || 20);
    else if (a === '--redact') o.redact = true;
    else if (a === '--logs') o.logs = path.resolve(next() || o.logs);
    else if (a === '--statusline') o.statusline = path.resolve(next() || o.statusline);
    else if (a === '--no-usage') o.usage = false;
    else if (a === '--projects') o.projects = path.resolve(next() || o.projects);
    else if (a === '--config') o.config = path.resolve(next() || o.config);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node server.mjs [--port N] [--replay file.jsonl --speed N] [--redact] [--logs DIR] [--statusline DIR]\n' +
        '                        [--no-usage] [--projects DIR] [--config DIR]\n' +
        '  --config DIR  building.json / pricing.json (default ~/.claude/ai-team-office/, falls back to reading office/)');
      process.exit(0);
    }
  }
  return o;
}
const realpath = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && realpath(process.argv[1]) === realpath(fileURLToPath(import.meta.url));
const opt = isMain ? parseArgs(process.argv.slice(2)) : parseArgs([]);
const log = (...a) => console.log(new Date().toISOString(), ...a);
const STARTED_AT = Date.now();

// ---------- usage + config ----------
// building.json / pricing.json are user config and live OUTSIDE the code folder (a plugin update replaces it):
//   --config DIR (read + write)  >  ~/.claude/ai-team-office/ (read + write)  >  office/ itself (read-only, old installs).
// On first start without --config, config files found only in office/ are copied to ~/.claude/ai-team-office/.
export const CONFIG_FILES = ['building.json', 'pricing.json'];
export const configHome = (home = HOME) => path.join(home, '.claude', 'ai-team-office');

/** Path to read `name` from. explicit = --config dir (or null); legacy = the code folder (read-only fallback). */
export function configPath(name, { explicit = null, home = configHome(), legacy = ROOT } = {}) {
  if (explicit) return path.join(explicit, name);
  const cur = path.join(home, name);
  if (fs.existsSync(cur)) return cur;
  const old = path.join(legacy, name);
  return fs.existsSync(old) ? old : cur;
}
/** Directory POST /building.json writes into (created mode 700 on first write). */
export const configWriteDir = ({ explicit = null, home = configHome() } = {}) => explicit || home;

/** Copy config files that exist only in the legacy folder into the config home (once; never overwrites). */
export function migrateConfig({ home = configHome(), legacy = ROOT, log: say = () => {} } = {}) {
  const moved = [];
  for (const name of CONFIG_FILES) {
    const from = path.join(legacy, name), to = path.join(home, name);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to) || fs.lstatSync(from).isSymbolicLink()) continue;
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, 0o600);
      moved.push(name);
    } catch (err) { say(`config: could not copy ${name} to ${home}: ${err.message}`); }
  }
  if (moved.length) say(`config: copied ${moved.join(', ')} from ${legacy} to ${home} (edit it there from now on; the old copy is no longer written)`);
  return moved;
}

let usage = null;                       // Usage tracker (live mode without --no-usage)
let usageReady = Promise.resolve();     // resolves when today's transcripts have been read once
const cfgOpt = () => ({ explicit: opt.config });
const building = () => loadJson(configPath('building.json', cfgOpt()), log);
const pricing = () => loadJson(configPath('pricing.json', cfgOpt()), log);
/** Usage records carry no paths; proj is already a basename. --redact keeps it that way defensively. */
const usageOut = r => (opt.redact && typeof r.proj === 'string' ? { ...r, proj: path.basename(r.proj) } : r);

// ---------- event pipeline ----------
/** Local midnight (process TZ) of the day containing `now`, in epoch ms. "Today" = ts >= dayStart(). */
export const dayStart = (now = Date.now()) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const tsMs = e => Date.parse(e && (e.ts || ''));
const history = [];            // events already emitted, sent to each new client (today's part) as a replay burst
const HISTORY_MAX = 20000;
const clients = new Set();
/** Dashboards = /events clients whose Origin/Referer is this server's own origin (EventSource from the page sends it;
 *  curl and other bare SSE readers do not). Only VISIBLE ones keep relay items waiting: a background tab reports
 *  {visible:false} via POST /viewer and stops counting. res.vid = the page's viewer id, res.visible = its state. */
const viewers = new Set();
const visibleViewers = () => { let n = 0; for (const r of viewers) if (r.visible !== false) n++; return n; };
/** Who must be watching for an item to wait. A permission prompt shows in the terminal at the same time as the hook
 *  runs (the terminal can answer first), so any open dashboard, even a background tab, may hold it: the user usually
 *  works in the terminal and looks at the 대표실 later. A question (PreToolUse) blocks the terminal dialog until the
 *  hook returns, so it waits only while a dashboard is actually on screen. */
/** A raw request field for one log line: strings only, printable ASCII, bounded. */
const logSafe = (v, n) => (typeof v === 'string' ? v.slice(0, n).replace(/[^\x20-\x7e]/g, '?') : '?');
/** A Stop (instruct) holds the session like a question does (the terminal cannot take input while the Stop hook
 *  waits), so it too waits only while a dashboard is on screen. */
const canHold = kind => (kind === 'permission' ? viewers.size : visibleViewers()) > 0;
const holdKind = raw => (raw?.hook_event_name === 'PermissionRequest' ? 'permission' : raw?.hook_event_name === 'Stop' ? 'instruct' : 'question');
/** A closed tab is often a reload: wait this long for a dashboard to come back before releasing (env for tests). */
const CLOSE_GRACE_MS = /^\d{1,6}$/.test(process.env.OFFICE_VIEWER_GRACE_MS || '') ? Number(process.env.OFFICE_VIEWER_GRACE_MS) : 5000;
function releaseIfNoViewer(why) {
  const n = viewers.size ? (visibleViewers() ? 0 : relay.releaseAll('no-viewer', ['question', 'instruct'])) : relay.releaseAll('no-viewer');
  if (n) log(`대표실: ${why}, released ${n} pending`);
}

/** Per-process viewer token: delivered ONLY inside the served index.html (<meta name="office-token">), never on the
 *  SSE stream. answer/release/pending/viewer require it in X-Office-Token. */
const TOKEN = crypto.randomBytes(32).toString('hex');
/** Per-process boot id (not a secret): in index.html and in `ready`, so a page left open across a restart notices its
 *  token is stale and reloads instead of showing answer buttons that would be refused. */
const BOOT = crypto.randomBytes(8).toString('hex');
const tokenOk = t => typeof t === 'string' && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));

/** Caller-process check (relay.mjs checkCaller). OFFICE_TEST_ANCESTRY="comm,comm,…" (child first) swaps in a fake
 *  process tree — tests only; the real check runs otherwise. */
/** OFFICE_TEST_ANCESTRY is honoured ONLY under the node test runner: `node --test` sets NODE_TEST_CONTEXT in the
 *  processes it runs, and the servers the suites spawn inherit it. A real start (start.sh, plugin, a shell) never has
 *  it, so a stray variable cannot switch off the Claude-process-tree check (which now also guards instructions). */
export const testAncestry = env => (env && env.OFFICE_TEST_ANCESTRY && env.NODE_TEST_CONTEXT ? String(env.OFFICE_TEST_ANCESTRY).split(',') : null);
const fakeTree = testAncestry(process.env);
const peerRun = fakeTree ? fakeAncestryRunner(fakeTree) : execRunner;
const peerPlatform = fakeTree ? 'darwin' : process.platform;
if (process.env.OFFICE_TEST_ANCESTRY && !fakeTree) log('대표실: OFFICE_TEST_ANCESTRY ignored (only honoured under the test runner); the real caller-process check runs');
let peerFallbackLogged = false;
/** Project names seen and alias -> project (launch-dir / cwd basename -> root name) for building.json keys. */
const seenProj = new Set(), aliases = new Map();

const homeRe = new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
const unhome = v => (typeof v === 'string' ? v.replace(homeRe, '~') : v);

/** scheme://host/path — no userinfo, query or fragment. Non-URLs pass through. */
export function stripUrl(t) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return t;
  try { const u = new URL(t); return `${u.protocol}//${u.host}${u.pathname}`; } catch { return t.replace(/[?#].*$/s, ''); }
}

/** --redact: drop free text the UI never renders (prompt, sub.prompt, msg, err, cwd); target gets $HOME -> ~,
 *  URL query/fragment stripped, Bash masked after the first token (env assignment values masked too).
 *  The room is classified before masking so the scene stays truthful. */
export function redact(e) {
  const o = { ...e };
  if (o.ev === 'PreToolUse' && o.tool && !o.room) o.room = classify(o.tool, o.target);
  for (const k of ['prompt', 'msg', 'err', 'cwd']) delete o[k];
  if (o.sub && typeof o.sub === 'object') { const { prompt, ...sub } = o.sub; o.sub = { ...sub, desc: unhome(sub.desc) }; }
  if (typeof o.target === 'string') {
    o.target = unhome(stripUrl(o.target.trim()));
    if (o.tool === 'Bash') {
      const parts = o.target.split(/\s+/), first = parts[0].replace(/=.*$/s, '=***');
      o.target = parts.length > 1 ? `${first} ***` : first;
    }
  }
  if (typeof o.note === 'string') o.note = unhome(o.note);
  return o;
}

/** delegation.jsonl lines carry full prompts/responses; the dashboard needs only verdicts and model hints. */
function slim(e) {
  if (typeof e.event !== 'string' || typeof e.ev === 'string') return e;
  const o = { ts: e.ts, event: e.event, session_id: e.session_id };
  for (const k of ['ref', 'verdict', 'note', 'agent_id', 'agent_type', 'model']) if (e[k] != null) o[k] = e[k];
  if (e.response && e.response.resolvedModel) o.response = { resolvedModel: e.response.resolvedModel };
  return o;
}

// ---------- SSE backpressure ----------
// A client that stops reading must not grow server memory without bound. Once its first burst has drained
// ("primed"), frames are skipped while it has >1MB queued; when it drains after a skip the stream is ended so
// EventSource reconnects and resyncs from a fresh burst. Over 8MB queued it is dropped outright.
const SKIP_BYTES = 1 << 20, DROP_BYTES = 8 << 20;
function send(res, frame) {
  if (res.destroyed || res.writableEnded) { clients.delete(res); return; }
  if (res.primed) {
    if (res.writableLength > DROP_BYTES) { clients.delete(res); res.destroy(); log('dropped slow SSE client'); return; }
    if (res.congested && res.writableLength > SKIP_BYTES) { res.skipped = true; return; }
  }
  if (!res.write(frame)) res.congested = true;
}

/** 대표실 relay: `event: ceo` frames ({type: ask|answered|resolved|withdrawn|snapshot}) go to every live client. */
const relay = new Relay({
  broadcast: o => { const frame = `event: ceo\ndata: ${JSON.stringify(o)}\n\n`; for (const res of clients) send(res, frame); },
  redact: opt.redact, logFile: path.join(opt.logs, 'ceo-decisions.jsonl'), log,
  redactTarget: (tool, target) => redact({ ev: 'PermissionRequest', tool, target }).target,
  projOf: projectName,
});

/** One normalised (and, with --redact, redacted) event to history + every live client. Never throws. */
function emit(raw) {
  try {
    const e = norm(slim(raw));
    if (!e) return;
    // office-events.sh logs proj = basename of the CURRENT cwd; map it to the project root (subfolders, worktrees).
    if (typeof e.cwd === 'string') {
      const name = projectName(e.cwd);
      if (name) { if (e.proj && e.proj !== name && aliases.size < 5000) aliases.set(e.proj, name); e.proj = name; }
    }
    if (typeof e.proj === 'string' && e.proj && seenProj.size < 5000) seenProj.add(e.proj);
    const out = opt.redact ? redact(e) : e;
    history.push(out);
    if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    const frame = `data: ${JSON.stringify(out)}\n\n`;
    for (const res of clients) send(res, frame);
  } catch (err) { log('emit skipped a bad event:', err.message); }
}

/** Stable sort by ts (same-second lines keep file order). */
const byTs = list => list.map((e, i) => [e, i]).sort((a, b) => (tsMs(a[0]) - tsMs(b[0])) || (a[1] - b[1])).map(x => x[0]);

/** One complete line (bytes i..j of buf) -> event or null. A bad line never throws. */
function lineEvent(buf, i, j) {
  try {
    const line = buf.toString('utf8', i, j);
    if (!line.trim()) return null;
    const e = parseLine(line);
    return e && !Number.isNaN(tsMs(e)) ? e : null;
  } catch (err) { log('bad line skipped:', err.message); return null; }
}

/** Every complete line of buf; onLine(bytesConsumed) lets a tail advance its offset line by line. */
function parseBuffer(buf, onLine = () => {}) {
  const out = [];
  for (let i = 0, j; (j = buf.indexOf(0x0a, i)) >= 0; i = j + 1) {
    onLine(j + 1 - i);
    const e = lineEvent(buf, i, j);
    if (e) out.push(e);
  }
  return out;
}

// ---------- tailing (fs.watch on the directory, 500ms polling fallback) ----------
class Tail {
  constructor(file, onEvents) { this.file = file; this.onEvents = onEvents; this.offset = 0; this.ino = null; }
  /** Read the whole file once; return today's events and remember where we stopped (after the last \n). */
  initial() {
    try {
      const st = fs.statSync(this.file);
      this.ino = st.ino;
      const evs = parseBuffer(fs.readFileSync(this.file), n => { this.offset += n; });
      const d0 = dayStart();
      return evs.filter(e => tsMs(e) >= d0);
    } catch { return []; }                               // missing file = empty office
  }
  check() {
    let st;
    try { st = fs.statSync(this.file); } catch { this.offset = 0; this.ino = null; return; }
    if (this.ino !== null && st.ino !== this.ino) this.offset = 0;   // rotated
    if (st.size < this.offset) this.offset = 0;                       // truncated
    this.ino = st.ino;
    if (st.size === this.offset) return;
    let fd, evs = [];
    try {
      fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(st.size - this.offset);
      const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
      // Only complete lines; the offset advances per line, so a partial line (or partial UTF-8) stays on disk.
      evs = parseBuffer(buf.subarray(0, n), len => { this.offset += len; });
    } catch (err) { log('tail error', this.file, err.message); }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
    if (evs.length) this.onEvents(evs);
  }
}

/** A ceo-decisions.jsonl line -> office event `RelayDecided` {sid, aid, tool, answer: allow|deny|answered|instructed}, only for
 *  answers given in the dashboard. In the history, a page that reloads (or opens after a restart) sees the request as
 *  decided instead of bringing back a card with no buttons while the approved command is still running. */
function decisionEvent(d) {
  if (!d || d.by !== 'dashboard' || !d.decision || typeof d.sid !== 'string') return null;
  const answer = d.decision.behavior === 'allow' || d.decision.behavior === 'deny' ? d.decision.behavior : d.kind === 'instruct' ? 'instructed' : 'answered';
  return { ts: d.ts, ev: 'RelayDecided', sid: d.sid, ...(d.aid ? { aid: d.aid } : {}), ...(d.tool ? { tool: d.tool } : {}), ...(typeof d.proj === 'string' && d.proj ? { proj: d.proj } : {}), answer };
}

function startLive() {
  const files = ['office-events.jsonl', 'delegation.jsonl', 'ceo-decisions.jsonl'].map(f => path.join(opt.logs, f));
  const tails = files.map((f, i) => new Tail(f, raw => {
    const sorted = byTs(i === 2 ? raw.map(decisionEvent).filter(Boolean) : raw);
    sorted.forEach(emit);
    // Live office-events lines tell the relay when the terminal answered first (or the session moved on).
    if (i === 0) for (const e of sorted) { try { relay.observe(norm(e)); } catch (err) { log('relay observe:', err.message); } }
  }));
  const inits = tails.map(t => t.initial());                // once: initial() advances each tail's offset
  byTs(inits.flatMap((evs, i) => (i === 2 ? evs.map(decisionEvent).filter(Boolean) : evs))).forEach(emit);
  // Today's endings without a decision (timeout, no viewer, hook gone) explain buttonless cards after a restart too.
  for (const d of inits[2]) {
    const at = tsMs(d), reason = d?.by === 'withdrawn' ? 'withdrawn' : d?.reason;
    if (d && !d.decision && at >= dayStart()) relay.noteEnd({ sid: d.sid, aid: d.aid, tool: d.tool, kind: d.kind, reason, wait: Number(d.wait), at }, false);
  }
  log(`replayed ${history.length} of today's events from ${opt.logs}`);
  const checkAll = () => tails.forEach(t => t.check());
  let watching = false;
  try {
    fs.watch(opt.logs, { persistent: true }, () => checkAll()).on('error', () => { watching = false; });
    watching = true;
  } catch (err) { log('fs.watch unavailable, polling every 500ms:', err.message); }
  // Polling: 500ms when watch is unavailable; a slow safety poll otherwise (missed FSEvents, dir created later).
  let last = 0;
  setInterval(() => { const now = Date.now(); if (!watching || now - last >= 5000) { last = now; checkAll(); } }, 500);
  if (opt.usage) startUsage();
  startLimits();
}

/** Plan limits + context windows from the statusline files; `event: limits` carries the full snapshot on change. */
let limits = null;
/** Never throws: a bad statusline file must not kill /events or /limits.json. */
function limitsNow() {
  try { return limits ? limits.get() : null; } catch (err) { log('limits snapshot failed:', err.message); return null; }
}

function startLimits() {
  limits = new Limits({ dir: opt.statusline, log, redact: opt.redact,
    onChange: snap => { const frame = `event: limits\ndata: ${JSON.stringify(snap)}\n\n`; for (const res of clients) send(res, frame); } });
  limits.start();
}

function startUsage() {
  usage = new Usage({ dir: opt.projects, pricingFile: configPath('pricing.json', cfgOpt()), log,
    onRecord: r => { const frame = `event: usage\ndata: ${JSON.stringify(usageOut(r))}\n\n`; for (const res of clients) send(res, frame); } });
  const t0 = Date.now();
  usageReady = usage.start()
    .then(() => log(`usage: ${usage.records.size} messages today from ${usage.fileCount} transcripts in ${Date.now() - t0}ms`))
    .catch(err => log('usage scan failed:', err.message));
}

/** Re-emit a jsonl file with time compression; ts rewritten to the moment of emission. */
function replayFile(file, speed, sink, isAlive = () => true) {
  let evs;
  try { evs = byTs(parseBuffer(fs.readFileSync(file))); } catch (err) { log('replay read failed:', err.message); return; }
  if (!evs.length) return;
  const t0 = tsMs(evs[0]);
  let i = 0;
  const startAt = Date.now();
  const step = () => {
    if (!isAlive()) return;
    while (i < evs.length && (tsMs(evs[i]) - t0) / speed <= Date.now() - startAt) sink({ ...evs[i++], ts: new Date().toISOString() });
    if (i < evs.length) setTimeout(step, Math.max(5, (tsMs(evs[i]) - t0) / speed - (Date.now() - startAt)));
    else log(`replay of ${path.basename(file)} finished (${evs.length} events)`);
  };
  step();
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
// DNS rebinding guard: only loopback names are served; /events also refuses cross-site Origins.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i;
export const okHost = h => typeof h === 'string' && LOCAL_HOST.test(h);
export const okOrigin = o => o === undefined || (typeof o === 'string' && LOCAL_ORIGIN.test(o));

function sseOpen(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  res.on('drain', () => {
    res.primed = true; res.congested = false;
    if (res.skipped) { clients.delete(res); res.end(); log('slow SSE client skipped frames; ended for resync'); }
  });
  const ka = setInterval(() => send(res, ': keep-alive\n\n'), 15000);
  req.on('close', () => { clearInterval(ka); clients.delete(res); });
}

/** History burst, usage burst, then `ready` {mode, redact, count, dayStart, usage, usageFiles, usageCount, hasPricing,
 *  building}. dayStart = local midnight (epoch ms) that "today" was cut at; a client resets its daily stats when its
 *  clock passes dayStart + 24h. usage-batch frames (<= 1000 records each, <= 5000 in all) all precede `ready`. */
function sendBurst(res, list, useUsage = false) {
  for (let i = 0; i < list.length; i += 500) res.write(`event: batch\ndata: ${JSON.stringify(list.slice(i, i + 500))}\n\n`);
  const recs = useUsage && usage ? usage.batch().map(usageOut) : [];
  for (let i = 0; i < recs.length; i += 1000) res.write(`event: usage-batch\ndata: ${JSON.stringify(recs.slice(i, i + 1000))}\n\n`);
  const info = { mode: opt.replay ? 'replay' : 'live', redact: opt.redact, count: list.length, dayStart: dayStart(),
    usage: !!(useUsage && usage), usageFiles: useUsage && usage ? usage.fileCount : 0, usageCount: recs.length,
    hasPricing: !!(usage && usage.hasPricing), building: servedBuilding(), limits: limitsNow(), boot: BOOT };
  res.write(`event: ready\ndata: ${JSON.stringify(info)}\n\n`);
  res.primed = !res.writableNeedDrain;
}

async function handleEvents(req, res, url) {
  sseOpen(req, res);
  if (url.searchParams.get('sim') === '1') {        // per-client simulator: sample fixture, no live data
    let alive = true;
    req.on('close', () => { alive = false; });
    sendBurst(res, []);
    const speed = Math.max(0.1, Number(url.searchParams.get('speed')) || 1);
    const fixture = path.join(ROOT, 'test', 'fixtures', 'sample.jsonl');
    replayFile(fixture, speed, raw => {
      const e = norm(raw);
      if (e) send(res, `data: ${JSON.stringify(opt.redact ? redact(e) : e)}\n\n`);
    }, () => alive && !res.writableEnded);
    return;
  }
  await usageReady;                                  // first clients wait for the initial transcript scan
  if (res.destroyed || res.writableEnded) return;
  const d0 = dayStart();
  sendBurst(res, opt.replay ? history : history.filter(e => tsMs(e) >= d0), true);
  res.write(`event: ceo\ndata: ${JSON.stringify({ type: 'snapshot', items: relay.list(), ends: relay.ends.filter(x => x.at >= d0), startedAt: STARTED_AT })}\n\n`);
  clients.add(res);
  if (isViewer(req)) {
    const vid = url.searchParams.get('vid');
    if (vid && VID_RE.test(vid)) res.vid = vid;
    res.visible = url.searchParams.get('visible') !== '0';
    viewers.add(res);
    res.on('close', () => {
      viewers.delete(res);
      // decided when the grace ends, by whoever is connected then (a reloaded page counts again)
      setTimeout(() => releaseIfNoViewer(viewers.size ? 'last visible dashboard closed (background tabs remain)' : 'last dashboard closed'), CLOSE_GRACE_MS).unref();
    });
  }
}

/** Origin or Referer pointing at this server (loopback host, same port). */
export function sameServerOrigin(headers, port) {
  for (const h of [headers.origin, headers.referer]) {
    if (typeof h !== 'string') continue;
    try {
      const u = new URL(h);
      if (u.protocol === 'http:' && LOCAL_HOST.test(u.host) && Number(u.port || 80) === port) return true;
    } catch {}
  }
  return false;
}
const isViewer = req => sameServerOrigin(req.headers, req.socket.localPort);
const VID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** Strict form for state-changing dashboard calls: the Origin header itself (no Referer, no "missing is fine") must be
 *  this server's own loopback origin. */
export function ownOrigin(origin, port) {
  if (typeof origin !== 'string') return false;
  try {
    const u = new URL(origin);
    return u.protocol === 'http:' && LOCAL_HOST.test(u.host) && Number(u.port || 80) === port && origin === u.origin;
  } catch { return false; }
}

/** Dashboard-only gate: own Origin + viewer token; for answer/release (decide=true) also the caller-process check.
 *  Sends the 403 and returns false when refused. */
async function dashboardGate(req, res, { decide = false } = {}) {
  const deny = msg => { sendJson(res, 403, { error: msg }, { Connection: 'close' }); return false; };
  if (!ownOrigin(req.headers.origin, req.socket.localPort)) return deny('forbidden origin (dashboard calls need this server\'s Origin)');
  if (!tokenOk(req.headers['x-office-token'])) return deny('missing or wrong X-Office-Token (reload the dashboard)');
  if (!decide) return true;
  let c;
  try { c = await checkCaller(req.socket.remotePort, { run: peerRun, platform: peerPlatform }); }
  catch (err) { c = { verdict: 'unchecked', detail: err.message }; }
  if (c.verdict === 'agent') {
    log(`대표실: refused an answer from an agent process (${c.chain.map(p => `${p.pid}:${path.basename(p.comm)}`).join(' <- ')})`);
    return deny('agent processes cannot answer');
  }
  if (c.verdict === 'unknown') return deny(`could not verify the calling process (${c.detail})`);
  req.callerVerdict = c.verdict;
  if (c.verdict === 'unchecked' && !peerFallbackLogged) {
    peerFallbackLogged = true;
    log(`대표실: caller-process check unavailable (${c.detail}); relying on Origin + token only`);
  }
  return !res.writableEnded;
}

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400).end('bad path'); return; }
  if (rel.includes('\0')) { res.writeHead(400).end('bad path'); return; }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found'); return; }
    if (file === path.join(PUBLIC, 'index.html')) {
      const html = buf.toString('utf8').replace('<head>', `<head>\n  <meta name="office-token" content="${TOKEN}">\n  <meta name="office-boot" content="${BOOT}">`);
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'Referrer-Policy': 'same-origin' }).end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(buf);
  });
}

// ---------- floor editor endpoints ----------
let projCache = { at: 0, list: null };
function projectsJson() {
  if (!projCache.list || Date.now() - projCache.at > 10000) {
    projCache = { at: Date.now(), list: scanProjects(opt.projects, Date.now(), { aliases }) };
    if (aliases.size > 5000) aliases.clear();
  }
  return opt.redact ? projCache.list.map(({ cwd, ...r }) => r) : projCache.list;
}

/** building.json as served (ready.building, GET /building.json): a floors key that is not a known project name is
 *  mapped to the project it stands for — via an alias (launch-dir / cwd basename -> project root name) or an equal
 *  encodeDir ("web-ui" -> "web_ui"). An exact key wins over a mapped duplicate. Keys still unmatched
 *  are kept and listed in `unknownKeys` so the editor can flag them. The file itself is not rewritten. */
export function normaliseBuilding(b, known, alias = new Map()) {
  if (!b || typeof b !== 'object' || !b.floors || typeof b.floors !== 'object' || Array.isArray(b.floors)) return b;
  const knownSet = new Set(known), byEnc = new Map();
  for (const p of knownSet) if (!byEnc.has(encodeDir(p))) byEnc.set(encodeDir(p), p);
  const target = k => (knownSet.has(k) ? k : alias.has(k) && knownSet.has(alias.get(k)) ? alias.get(k) : byEnc.get(encodeDir(k)) ?? null);
  const entries = Object.entries(b.floors), floors = Object.create(null), unknownKeys = [];
  for (const [k, v] of entries) if (target(k) === k) floors[k] = v;
  for (const [k, v] of entries) {
    const t = target(k);
    if (t === k) continue;
    if (t == null) { unknownKeys.push(k); floors[k] = v; } else if (!(t in floors)) floors[t] = v;
  }
  const { unknownKeys: _, ...rest } = b;
  return { ...rest, floors: { ...floors }, unknownKeys };
}
const knownProjects = () => [...projectsJson().map(p => p.proj), ...seenProj];
const servedBuilding = () => normaliseBuilding(building(), knownProjects(), aliases);

const BODY_MAX = 64 * 1024;
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** Strict validation of the POST /building.json body. Returns {error} or {value}. */
export function validateBuilding(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { error: 'body must be an object' };
  for (const k of Object.keys(b)) if (k !== 'ceo' && k !== 'floors' && k !== 'unknownKeys') return { error: `unknown key: ${k.slice(0, 40)}` };   // unknownKeys (served, informational) is dropped
  const out = {};
  if (b.ceo !== undefined) {
    if (typeof b.ceo !== 'string' || b.ceo.length > 40 || CTRL.test(b.ceo)) return { error: 'ceo must be a string <= 40 chars without control characters' };
    out.ceo = b.ceo;
  }
  const f = b.floors;
  if (!f || typeof f !== 'object' || Array.isArray(f)) return { error: 'floors must be an object' };
  const entries = Object.entries(f);
  if (entries.length > 200) return { error: 'too many floors (max 200)' };
  out.floors = Object.create(null);
  for (const [proj, v] of entries) {
    if (!proj || proj.length > 200 || CTRL.test(proj) || proj === '__proto__') return { error: 'bad project name' };
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: `floor entry for ${proj} must be an object` };
    for (const k of Object.keys(v)) if (k !== 'floor' && k !== 'label') return { error: `unknown key in ${proj}: ${k.slice(0, 40)}` };
    if (!Number.isInteger(v.floor) || v.floor < 1 || v.floor > 99) return { error: `floor for ${proj} must be an integer 1..99` };
    if (typeof v.label !== 'string' || v.label.length > 40 || CTRL.test(v.label)) return { error: `label for ${proj} must be a string <= 40 chars without control characters` };
    out.floors[proj] = { floor: v.floor, label: v.label };
  }
  out.floors = { ...out.floors };
  return { value: out };
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => {
      n += c.length;
      if (n > max) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function saveBuilding(req, res) {
  const text = o => ({ 'Content-Type': 'text/plain; charset=utf-8', ...o });
  const fail = (code, msg) => { res.writeHead(code, text({ Connection: 'close' })).end(msg + '\n'); };
  if (!okOrigin(req.headers.origin)) return fail(403, 'forbidden origin');
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return fail(415, 'content-type must be application/json');
  if (Number(req.headers['content-length']) > BODY_MAX) { req.resume(); return fail(413, 'body too large (max 64KB)'); }
  let parsed;
  try { parsed = JSON.parse(await readBody(req, BODY_MAX)); }
  catch (err) { return fail(err.status || 400, err.status ? 'body too large (max 64KB)' : 'invalid JSON'); }
  const v = validateBuilding(parsed);
  if (v.error) return fail(400, v.error);
  const dir = configWriteDir(cfgOpt()), file = path.join(dir, 'building.json');
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (err) { log('config dir create failed:', err.message); return fail(500, 'cannot create config dir'); }
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return fail(409, 'building.json is a symlink; refusing to write');
  } catch (err) { if (err.code !== 'ENOENT') return fail(500, 'cannot stat building.json'); }
  const json = JSON.stringify(v.value, null, 2) + '\n';
  const tmpFile = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpFile, json, { flag: 'wx', mode: 0o644 });
    fs.renameSync(tmpFile, file);
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch {}
    log('building.json write failed:', err.message);
    return fail(500, 'write failed');
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }).end(json);
}

// ---------- 대표실 relay endpoints ----------
const ASK_MAX = 1 << 20, ANSWER_BODY_MAX = 16 * 1024;
const sendJson = (res, code, o, extra = {}) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ...extra }).end(JSON.stringify(o));
};

/** JSON body or a response already sent (returns undefined). */
async function jsonBody(req, res, max) {
  if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) { sendJson(res, 415, { error: 'content-type must be application/json' }, { Connection: 'close' }); return; }
  if (Number(req.headers['content-length']) > max) { req.resume(); sendJson(res, 413, { error: 'body too large' }, { Connection: 'close' }); return; }
  try { return JSON.parse(await readBody(req, max)); }
  catch (err) { sendJson(res, err.status || 400, { error: err.status ? 'body too large' : 'invalid JSON' }, { Connection: 'close' }); }
}

/** POST /relay/ask (hook script: {id, kind, decision|null}) and /relay/hook (`http` hook: final hook JSON or {}).
 *  Holds the response until the dashboard answers, waitMs passes, the terminal answers first, or the hook hangs up.
 *  With no dashboard (viewer) connected it answers "no decision" at once so the native prompt is never held up for
 *  nobody; when the last dashboard closes, every pending item is released the same way (`no-viewer`). */
async function relayAsk(req, res, url, asHook) {
  const raw = await jsonBody(req, res, ASK_MAX);
  if (raw === undefined) return;
  const none = reason => sendJson(res, 200, asHook ? {} : { id: null, decision: null, reason });
  if (holdKind(raw) === 'instruct' && peerPlatform !== 'darwin') {   // no caller-process check here: no instructions
    try { relay.skip(raw, 'unchecked'); } catch { /* bookkeeping only */ }
    return none('unchecked');
  }
  if (!canHold(holdKind(raw))) {
    try { relay.skip(raw, viewers.size ? 'hidden' : 'no-viewer'); } catch { /* bookkeeping only */ }
    log(`대표실: ${logSafe(raw?.hook_event_name === 'Stop' ? 'Stop' : raw?.tool_name, 40)} (${logSafe(raw?.session_id, 8)}) not relayed: ${viewers.size ? 'dashboard in the background' : 'no dashboard open'}`);
    return none('no-viewer');
  }
  const alive = () => !res.destroyed && !res.writableEnded && !!res.socket && !res.socket.destroyed && res.socket.writable;
  const r = relay.ask(raw, parseWait(url.searchParams.get('waitMs'), holdKind(raw)), { alive });
  if (r.error) return asHook ? none(r.error) : sendJson(res, r.status, { error: r.error });
  if (r.none) return none(r.none);                       // e.g. a Stop whose report does not ask: no hold, no log
  res.on('close', () => { if (!res.writableFinished) relay.withdraw(r.id); });
  const { decision, by } = await r.wait;
  if (asHook) sendJson(res, 200, hookOutput(r.item.kind, r.toolInput, decision));
  else sendJson(res, 200, { id: r.id, kind: r.item.kind, decision, by });
}

async function relayAnswer(req, res) {
  if (!(await dashboardGate(req, res, { decide: true }))) { req.resume(); return; }
  const b = await jsonBody(req, res, ANSWER_BODY_MAX);
  if (b === undefined) return;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return sendJson(res, 400, { error: 'body must be {id, decision}' });
  // An instruction becomes the session's next input: never without the caller-process check (non-macOS / tools missing).
  if (req.callerVerdict === 'unchecked' && typeof b.id === 'string' && relay.pending.get(b.id)?.item.kind === 'instruct')
    return sendJson(res, 403, { error: 'dashboard instructions need the caller-process check (macOS lsof/ps); answer in the terminal' });
  const r = relay.answer(b.id, b.decision);
  if (r.status !== 200) return sendJson(res, r.status, { error: r.error });
  log(`대표실: ${r.item.kind} ${r.item.tool} ${r.decision.behavior || (r.item.kind === 'instruct' ? 'instructed' : 'answered')} (${r.item.sid.slice(0, 8)})`);
  sendJson(res, 200, { ok: true, id: b.id, decision: r.decision });
}

/** POST /relay/release {id}: 돌려보내기 — resolve the long-poll with no decision (native terminal prompt takes over). */
async function relayRelease(req, res) {
  if (!(await dashboardGate(req, res, { decide: true }))) { req.resume(); return; }
  const b = await jsonBody(req, res, ANSWER_BODY_MAX);
  if (b === undefined) return;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return sendJson(res, 400, { error: 'body must be {id}' });
  const r = relay.release(b.id);
  if (r.status !== 200) return sendJson(res, r.status, { error: r.error });
  log(`대표실: ${r.item.kind} ${r.item.tool} released to the terminal (${r.item.sid.slice(0, 8)})`);
  sendJson(res, 200, { ok: true, id: b.id, released: true });
}

/** POST /viewer {vid, visible}: the page went to the background (or came back). Hidden tabs do not count as viewers;
 *  when the last visible one goes, pending items are released as no-viewer (the terminal prompt takes over). */
async function setViewer(req, res) {
  if (!(await dashboardGate(req, res))) { req.resume(); return; }
  const b = await jsonBody(req, res, 1024);
  if (b === undefined) return;
  if (!b || typeof b !== 'object' || typeof b.vid !== 'string' || typeof b.visible !== 'boolean') return sendJson(res, 400, { error: 'body must be {vid, visible:boolean}' });
  let hit = 0;
  for (const r of viewers) if (r.vid === b.vid) { r.visible = b.visible; hit++; }
  if (!hit) return sendJson(res, 404, { error: 'no open dashboard with that vid' });
  if (!b.visible) releaseIfNoViewer('last visible dashboard went to the background');
  sendJson(res, 200, { ok: true, visible: b.visible, viewers: visibleViewers() });
}

function handleRelay(req, res, url) {
  if (!okOrigin(req.headers.origin)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden origin\n'); return; }
  const route = { '/relay/ask': 'POST', '/relay/hook': 'POST', '/relay/answer': 'POST', '/relay/release': 'POST', '/relay/pending': 'GET' }[url.pathname];
  if (!route) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found\n'); return; }
  if (req.method !== route) { res.writeHead(405, { Allow: route }).end(); return; }
  if (url.pathname === '/relay/pending') {
    dashboardGate(req, res).then(ok => { if (ok) sendJson(res, 200, relay.list()); }).catch(err => { log('relay error', err.message); sendJson(res, 500, { error: 'error' }); });
    return;
  }
  const p = url.pathname === '/relay/answer' ? relayAnswer(req, res) : url.pathname === '/relay/release' ? relayRelease(req, res) : relayAsk(req, res, url, url.pathname === '/relay/hook');
  p.catch(err => { log('relay error', err.message); try { sendJson(res, 500, { error: 'error' }); } catch {} });
}

const focusLimit = makeLimiter(1000);
function handle(req, res) {
  try {
    if (!okHost(req.headers.host)) {
      res.writeHead(421, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' }).end('misdirected request\n');
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/events') {
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
      if (!okOrigin(req.headers.origin)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden origin\n'); return; }
      handleEvents(req, res, url).catch(err => { log('events error', err.message); try { res.end(); } catch {} });
      return;
    }
    if (url.pathname.startsWith('/relay/')) { handleRelay(req, res, url); return; }
    if (url.pathname === '/viewer') {
      if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
      setViewer(req, res).catch(err => { log('viewer error', err.message); try { sendJson(res, 500, { error: 'error' }); } catch {} });
      return;
    }
    if (url.pathname === '/building.json' && req.method === 'POST') {
      saveBuilding(req, res).catch(err => { log('save error', err.message); try { res.writeHead(500).end(); } catch {} });
      return;
    }
    if (url.pathname === '/focus') {
      const json = (code, o) => res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }).end(JSON.stringify(o));
      if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
      if (!okOrigin(req.headers.origin)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden origin\n'); return; }
      const sid = url.searchParams.get('sid') || '';
      if (!SID_RE.test(sid)) { json(400, { ok: false, method: 'none', detail: 'bad sid' }); return; }
      if (!focusLimit()) { res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '1' }).end(JSON.stringify({ ok: false, method: 'none', detail: 'rate limited' })); return; }
      focusSession(sid, { projectsDir: opt.projects }).then(r => json(200, r), err => { log('focus error', err.message); json(500, { ok: false, method: 'none', detail: 'error' }); });
      return;
    }
    if (url.pathname === '/limits.json') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
      if (!okOrigin(req.headers.origin)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden origin\n'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }).end(req.method === 'HEAD' ? undefined : JSON.stringify(limitsNow()));
      return;
    }
    if (url.pathname === '/projects.json') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
      if (!okOrigin(req.headers.origin)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden origin\n'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }).end(req.method === 'HEAD' ? undefined : JSON.stringify(projectsJson()));
      return;
    }
    if (url.pathname === '/building.json' || url.pathname === '/pricing.json') {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD, POST' }).end(); return; }
      if (!okOrigin(req.headers.origin)) { res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('forbidden origin\n'); return; }
      const body = JSON.stringify((url.pathname === '/building.json' ? servedBuilding() : pricing()) || {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }).end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, version: VERSION, events: history.length, clients: clients.size, viewers: visibleViewers(), hiddenViewers: viewers.size - visibleViewers(), pending: relay.pending.size, usage: usage ? usage.records.size : null })); return; }
    serveStatic(req, res, url);
  } catch (err) { log('request error', err.message); try { res.writeHead(500).end(); } catch {} }
}

if (isMain) {
  process.on('uncaughtException', err => log('uncaught (kept alive):', err && err.stack || err));
  process.on('unhandledRejection', err => log('unhandled rejection (kept alive):', err));
  if (!opt.config) migrateConfig({ log });
  const server = http.createServer(handle);
  server.on('error', err => { log('server error:', err.message); if (err.code === 'EADDRINUSE') process.exit(1); });
  server.listen(opt.port, '127.0.0.1', () => {
    const port = server.address().port;
    log(`AI Team Office on http://127.0.0.1:${port}  mode=${opt.replay ? `replay ${opt.replay} x${opt.speed}` : 'live'}${opt.redact ? ' redact' : ''}${opt.usage && !opt.replay ? '' : ' no-usage'}`);
    if (opt.replay) replayFile(opt.replay, opt.speed, emit);
    else startLive();
  });
}

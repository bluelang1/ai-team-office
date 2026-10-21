#!/usr/bin/env node
// AI Team Office server — zero deps. Serves public/ and GET /events (SSE).
// Live mode: replays today's (local-time) lines of office-events.jsonl + delegation.jsonl, then tails both.
// Replay mode: --replay <file> --speed N re-emits a jsonl file with time compression (ts rewritten to now).
// Imported (tests) it only exports helpers; it listens only when run as the main script.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, parseLine, norm } from './public/reducer.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const HOME = os.homedir();

function parseArgs(argv) {
  const o = { port: 4747, replay: null, speed: 20, redact: false, logs: path.join(HOME, '.claude', 'logs') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--port') { const p = Number(next()); o.port = Number.isInteger(p) && p >= 0 && p < 65536 ? p : 4747; }   // 0 = any free port
    else if (a === '--replay') o.replay = path.resolve(next() || '');
    else if (a === '--speed') o.speed = Math.max(0.1, Number(next()) || 20);
    else if (a === '--redact') o.redact = true;
    else if (a === '--logs') o.logs = path.resolve(next() || o.logs);
    else if (a === '--help' || a === '-h') {
      console.log('usage: node server.mjs [--port N] [--replay file.jsonl --speed N] [--redact] [--logs DIR]');
      process.exit(0);
    }
  }
  return o;
}
const realpath = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isMain = !!process.argv[1] && realpath(process.argv[1]) === realpath(fileURLToPath(import.meta.url));
const opt = isMain ? parseArgs(process.argv.slice(2)) : parseArgs([]);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- event pipeline ----------
/** Local midnight (process TZ) of the day containing `now`, in epoch ms. "Today" = ts >= dayStart(). */
export const dayStart = (now = Date.now()) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };
const tsMs = e => Date.parse(e && (e.ts || ''));
const history = [];            // events already emitted, sent to each new client (today's part) as a replay burst
const HISTORY_MAX = 20000;
const clients = new Set();

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

/** One normalised (and, with --redact, redacted) event to history + every live client. Never throws. */
function emit(raw) {
  try {
    const e = norm(slim(raw));
    if (!e) return;
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

function startLive() {
  const files = ['office-events.jsonl', 'delegation.jsonl'].map(f => path.join(opt.logs, f));
  const tails = files.map(f => new Tail(f, evs => byTs(evs).forEach(emit)));
  byTs(tails.flatMap(t => t.initial())).forEach(emit);
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

/** History burst, then `ready` {mode, redact, count, dayStart}. dayStart = local midnight (epoch ms) that "today"
 *  was cut at; a client resets its daily stats when its clock passes dayStart + 24h. */
function sendBurst(res, list) {
  for (let i = 0; i < list.length; i += 500) res.write(`event: batch\ndata: ${JSON.stringify(list.slice(i, i + 500))}\n\n`);
  const info = { mode: opt.replay ? 'replay' : 'live', redact: opt.redact, count: list.length, dayStart: dayStart() };
  res.write(`event: ready\ndata: ${JSON.stringify(info)}\n\n`);
  res.primed = !res.writableNeedDrain;
}

function handleEvents(req, res, url) {
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
  const d0 = dayStart();
  sendBurst(res, opt.replay ? history : history.filter(e => tsMs(e) >= d0));
  clients.add(res);
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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(buf);
  });
}

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
      return handleEvents(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, events: history.length, clients: clients.size })); return; }
    serveStatic(req, res, url);
  } catch (err) { log('request error', err.message); try { res.writeHead(500).end(); } catch {} }
}

if (isMain) {
  process.on('uncaughtException', err => log('uncaught (kept alive):', err && err.stack || err));
  process.on('unhandledRejection', err => log('unhandled rejection (kept alive):', err));
  const server = http.createServer(handle);
  server.on('error', err => { log('server error:', err.message); if (err.code === 'EADDRINUSE') process.exit(1); });
  server.listen(opt.port, '127.0.0.1', () => {
    const port = server.address().port;
    log(`AI Team Office on http://127.0.0.1:${port}  mode=${opt.replay ? `replay ${opt.replay} x${opt.speed}` : 'live'}${opt.redact ? ' redact' : ''}`);
    if (opt.replay) replayFile(opt.replay, opt.speed, emit);
    else startLive();
  });
}

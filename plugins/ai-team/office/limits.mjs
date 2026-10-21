// Plan limits + context window from the statusline wrapper's per-session JSON files
// (~/.claude/logs/statusline/<session_id>.json, atomic rename, refreshed per assistant message).
// snapshot(): {account:{five_hour, seven_day, stale}, sessions:[...]} — pure function of the files + `now`.
import fs from 'node:fs';
import path from 'node:path';
import { familyOf, projectName } from './usage.mjs';

export const SESSION_STALE_S = 10 * 60, ACCOUNT_STALE_S = 15 * 60;
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = v => (typeof v === 'string' && v ? v : null);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Local midnight of the day containing `nowS` (epoch s), in epoch s. */
const dayStartS = nowS => { const d = new Date(nowS * 1000); d.setHours(0, 0, 0, 0); return d.getTime() / 1000; };

/** project root name from workspace.project_dir || cwd || transcript_path (encoded dir name as last resort). */
export function projOf(d) {
  const ws = obj(d.workspace);
  const dir = str(ws.project_dir) || str(ws.current_dir) || str(d.cwd);
  if (dir) { const n = projectName(dir); if (n) return n; return path.basename(dir) || null; }
  if (typeof d.transcript_path === 'string' && d.transcript_path) return path.basename(path.dirname(d.transcript_path)) || null;
  return null;
}

/** files: [{sid, data}] (already parsed). now: epoch s. */
export function buildSnapshot(files, now = Date.now() / 1000, { redact = false } = {}) {
  const ok = files.filter(f => f.data && typeof f.data === 'object' && num(f.data._captured_at) !== null);
  const account = { five_hour: null, seven_day: null, stale: true };
  for (const win of ['five_hour', 'seven_day']) {
    let best = null;
    for (const f of ok) {
      const w = obj(f.data.rate_limits)[win];
      if (!w || typeof w !== 'object') continue;
      if (!best || f.data._captured_at > best.at) best = { w, at: f.data._captured_at };
    }
    if (!best) continue;
    const resetsAt = num(best.w.resets_at);
    if (resetsAt !== null && resetsAt <= now) continue;               // window already reset
    account[win] = { pct: num(best.w.used_percentage), resetsAt, capturedAt: best.at };
  }
  const newest = ok.reduce((m, f) => Math.max(m, f.data._captured_at), 0);
  account.stale = !newest || now - newest > ACCOUNT_STALE_S;
  const d0 = dayStartS(now);
  const sessions = [];
  for (const { sid, data: d } of ok.filter(f => f.data._captured_at >= d0).sort((a, b) => b.data._captured_at - a.data._captured_at)) {
    try {                                                            // one malformed file must never break /limits.json or /events
      const cw = obj(d.context_window), model = obj(d.model), name = str(model.display_name) || str(model.id);
      const s = { sid: str(sid) || '?', proj: projOf(d), model: name, family: familyOf(str(model.id) || name || ''),
        ctx: { size: num(cw.context_window_size), pct: num(cw.used_percentage), inTokens: num(cw.total_input_tokens) },
        costUsd: num(obj(d.cost).total_cost_usd), capturedAt: d._captured_at, stale: now - d._captured_at > SESSION_STALE_S };
      if (redact) delete s.costUsd;
      sessions.push(s);
    } catch {}
  }
  return { account, sessions };
}

export class Limits {
  constructor({ dir, onChange = () => {}, log = () => {}, redact = false, debounceMs = 500 }) {
    Object.assign(this, { dir, onChange, log, redact, debounceMs });
    this.cache = new Map();            // file -> {mtimeMs, size, sid, data}
    this.last = null; this.timer = null; this.watcher = null; this.poll = null;
  }
  readFiles() {
    let names = [];
    try { names = fs.readdirSync(this.dir).filter(n => n.endsWith('.json')); } catch { this.cache.clear(); return []; }
    const seen = new Set(), out = [];
    for (const n of names) {
      seen.add(n);
      const f = path.join(this.dir, n);
      try {
        const st = fs.statSync(f), c = this.cache.get(n);
        if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) { if (c.data) out.push(c); continue; }
        let data = null;
        try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}   // partial/invalid -> ignored
        const e = { mtimeMs: st.mtimeMs, size: st.size, sid: (data && typeof data.session_id === 'string' && data.session_id) || n.slice(0, -5), data };
        this.cache.set(n, e);
        if (data) out.push(e);
      } catch {}
    }
    for (const k of this.cache.keys()) if (!seen.has(k)) this.cache.delete(k);
    return out;
  }
  snapshot(now = Date.now() / 1000) { return buildSnapshot(this.readFiles(), now, { redact: this.redact }); }
  check() {
    const snap = this.snapshot(), key = JSON.stringify(snap);
    if (key === this.last) return;
    this.last = key; this.current = snap;
    try { this.onChange(snap); } catch (err) { this.log('limits onChange:', err.message); }
  }
  schedule() { if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.check(); }, this.debounceMs); }
  start() {
    this.last = JSON.stringify(this.snapshot()); this.current = JSON.parse(this.last);
    try { this.watcher = fs.watch(this.dir, () => this.schedule()); this.watcher.on('error', () => {}); }
    catch (err) { this.log('limits: fs.watch unavailable, polling:', err.message); }
    this.poll = setInterval(() => this.schedule(), 2000);   // also advances staleness / past resets
    this.poll.unref && this.poll.unref();
  }
  stop() { clearTimeout(this.timer); clearInterval(this.poll); try { this.watcher && this.watcher.close(); } catch {} }
  /** Fresh snapshot for HTTP / ready frame. */
  get() { return this.snapshot(); }
}

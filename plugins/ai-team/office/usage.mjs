// AI Team Office — token usage from Claude Code transcripts (read-only, zero deps).
// Source: <projects>/<proj-dir>/<sid>.jsonl and <projects>/<proj-dir>/<sid>/subagents/agent-<aid>.jsonl,
// only files modified today (local). Each `type=="assistant"` line carries message.{id,model,usage}; Claude Code
// writes several lines per message while streaming, so records are deduped by message id, last line wins.
// Files are read in 1MB chunks, line by line (a line is JSON-parsed only if it contains the assistant marker),
// then polled every second; the directory set is rescanned every 10s for new sessions/subagents.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'];
const NEEDLE = Buffer.from('"type":"assistant"');
const CHUNK = 1 << 20;
const TOKEN_KEYS = ['in', 'out', 'cacheR', 'cacheW'];

/** Local midnight (process TZ) of the day containing `now`, epoch ms. */
export const dayStart = (now = Date.now()) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** 'claude-opus-5-5' -> 'opus'; anything else -> 'unknown'. */
export function familyOf(model) {
  if (typeof model !== 'string' || !model) return 'unknown';           // statusline/transcript JSON is untrusted: never String() an object
  const m = /fable|opus|sonnet|haiku/.exec(model.toLowerCase());
  return m ? m[0] : 'unknown';
}

/** Claude Code names a project dir after its launch cwd with every non-alphanumeric char replaced by '-'. */
export const encodeDir = p => String(p).replace(/[^a-zA-Z0-9]/g, '-');

// ---------- project naming ----------
// One project = one floor. A cwd resolves to its PROJECT ROOT: the nearest ancestor (itself included) that is a git
// worktree root (`.git` file or dir) or holds a `.claude/` dir or CLAUDE.md; none -> the cwd itself. $HOME and `/`
// are never roots (~/.claude is the global config). A linked git worktree (`.git` file -> <main>/.git/worktrees/x)
// is named after the MAIN repo. Shared by usage records, /projects.json, office-events `proj` and building.json keys.
const ROOT_TTL = 30000, ROOT_MAX = 5000;
const rootCache = new Map();            // cwd -> {at, val}
const lstat = p => { try { return fs.lstatSync(p); } catch { return null; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** <p>/.git -> {main: path|null} (main = main repo dir of a linked worktree) or null when absent. */
function gitAt(p) {
  const st = lstat(path.join(p, '.git'));
  if (!st) return null;
  if (!st.isFile()) return { main: null };
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(path.join(p, '.git'), 'utf8').slice(0, 4096));
    const gd = m && path.resolve(p, m[1]);
    const w = gd && /^(.*)\/\.git\/worktrees\/[^/]+\/?$/.exec(gd);
    return { main: w ? w[1] : null };
  } catch { return { main: null }; }
}

/** cwd -> {root, name, marked} (marked = a root marker was found), or null for a non-absolute cwd. Cached 30s. */
export function projectOf(cwd, { home = os.homedir(), now = Date.now() } = {}) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  const start = path.normalize(cwd).replace(/(.)\/+$/, '$1');
  const key = home + '\0' + start, c = rootCache.get(key);
  if (c && now - c.at < ROOT_TTL) return c.val;
  let val = { root: start, name: path.basename(start) || start, marked: false };
  for (let p = start; p !== home && p !== path.dirname(p); p = path.dirname(p)) {
    const g = gitAt(p);
    if (g) { val = { root: p, name: path.basename(g.main || p), marked: true }; break; }
    if (isDir(path.join(p, '.claude')) || lstat(path.join(p, 'CLAUDE.md'))) { val = { root: p, name: path.basename(p), marked: true }; break; }
  }
  if (rootCache.size >= ROOT_MAX) rootCache.clear();
  rootCache.set(key, { at: now, val });
  return val;
}
export const projectName = cwd => { const r = projectOf(cwd); return r ? r.name : null; };

/** The launch dir (a real path) behind a transcript dir name, using a transcript `cwd`: the cwd or an ancestor
 *  encoding exactly to dirName (the session may have cd'ed deeper), else the cwd itself when dirName extends it
 *  (`<cwd>-…`, e.g. a worktree dir under the project). null when the cwd does not belong to this dir. */
export function launchDirFromCwd(dirName, cwd) {
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  const c = path.normalize(cwd);
  for (let p = c; ; p = path.dirname(p)) {
    if (encodeDir(p) === dirName) return p;
    if (p === path.dirname(p)) break;
  }
  return c !== '/' && dirName.startsWith(encodeDir(c) + '-') ? c : null;
}

/** Project name for a transcript dir given a transcript cwd, or null when the cwd does not match the dir. */
export function projFromDir(dirName, cwd) {
  const d = launchDirFromCwd(dirName, cwd);
  return d ? projectName(d) : null;
}

/** Rebuild the real path of dirName by walking the filesystem from `root`, choosing children whose encoding is
 *  dirName or a `-`-prefix of it (depth <= 12, <= 2000 dirs read). Returns {path} on an exact match, else
 *  {partial: deepest existing prefix path} or null. */
export function walkDir(dirName, root = '/') {
  let best = null, budget = 2000;
  const go = (dir, depth) => {
    if (depth > 12 || budget-- <= 0) return null;
    let names;
    try { names = fs.readdirSync(dir); } catch { return null; }
    for (const n of names) {
      const p = path.join(dir, n), e = encodeDir(p);
      if (e !== dirName && !dirName.startsWith(e + '-')) continue;
      if (!isDir(p)) continue;
      if (e === dirName) return p;
      if (!best || p.length > best.length) best = p;
      const hit = go(p, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  if (!dirName.startsWith(encodeDir(root))) return null;
  const hit = go(root, 0);
  return hit ? { path: hit } : best ? { partial: best } : null;
}

const fallbackMemo = new Map();         // root\0dirName -> {at, val}
/** Project name for a transcript dir with no usable cwd: the filesystem walk (exact path -> its project; a missing
 *  path whose deepest existing ancestor sits inside a marked project -> that project, e.g. a removed worktree),
 *  else the whole dir name (never a guessed last dash segment). Memoised 60s. */
export function fallbackProj(dirName, root = '/', now = Date.now()) {
  dirName = String(dirName);
  const k = root + '\0' + dirName, c = fallbackMemo.get(k);
  if (c && now - c.at < 60000) return c.val;
  const w = walkDir(dirName, root);
  let val = dirName;
  if (w && w.path) val = projectName(w.path) || dirName;
  else if (w && w.partial) { const r = projectOf(w.partial); if (r && r.marked && r.root !== '/') val = r.name; }
  if (fallbackMemo.size >= ROOT_MAX) fallbackMemo.clear();
  fallbackMemo.set(k, { at: now, val });
  return val;
}

/** Read a small JSON config file: object, or null when missing / unparsable / not an object. */
export function loadJson(file, log = () => {}) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try { const o = JSON.parse(text); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; }
  catch (err) { log(`${path.basename(file)} ignored (bad JSON):`, err.message); return null; }
}

/** pricing.json -> {family: {in,out,cacheR,cacheW}} keeping only families with all four finite, non-negative
 *  USD-per-1M-token numbers (other keys such as "_comment" are ignored). null when nothing usable. */
export function normPricing(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const [fam, p] of Object.entries(o)) {
    if (fam.startsWith('_') || !p || typeof p !== 'object') continue;
    if (TOKEN_KEYS.every(k => Number.isFinite(p[k]) && p[k] >= 0)) out[fam] = Object.fromEntries(TOKEN_KEYS.map(k => [k, p[k]]));
  }
  return Object.keys(out).length ? out : null;
}

/** USD for one record, or undefined when the family has no price row. */
export function costOf(r, pricing) {
  const p = pricing && pricing[r.family];
  if (!p) return undefined;
  return Math.round(TOKEN_KEYS.reduce((s, k) => s + (r[k] || 0) * p[k], 0)) / 1e6;   // tokens * USD/1M, 1e-6 USD precision
}

const tok = v => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** One parsed transcript object -> usage record (without proj) or null. ctx = {sid, aid?, atype?}. */
export function toRecord(o, ctx) {
  if (!o || o.type !== 'assistant' || !o.message || typeof o.message !== 'object') return null;
  const m = o.message, u = m.usage;
  const ms = Date.parse(o.timestamp);
  if (!u || typeof u !== 'object' || Number.isNaN(ms)) return null;
  const id = typeof m.id === 'string' && m.id ? m.id : typeof o.uuid === 'string' ? o.uuid : null;
  if (!id) return null;
  const r = { id, ts: new Date(ms).toISOString(), sid: ctx.sid, model: typeof m.model === 'string' ? m.model : 'unknown',
    in: tok(u.input_tokens), out: tok(u.output_tokens), cacheR: tok(u.cache_read_input_tokens), cacheW: tok(u.cache_creation_input_tokens) };
  if (!r.in && !r.out && !r.cacheR && !r.cacheW) return null;            // synthetic/error messages carry no tokens
  r.family = familyOf(r.model);
  if (ctx.aid) r.aid = ctx.aid;
  if (ctx.atype) r.atype = ctx.atype;
  return r;
}

/** Stream complete lines of `file` from byte `offset`; returns the offset after the last complete line
 *  (a half-written last line stays for the next read). Never loads the whole file. */
export async function readLines(file, offset, onLine) {
  const fh = await fsp.open(file, 'r');
  const buf = Buffer.allocUnsafe(CHUNK);
  let pos = offset, carry = null;
  try {
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const chunk = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
      carry = null;
      let i = 0;
      for (let j; (j = chunk.indexOf(0x0a, i)) >= 0; i = j + 1) { onLine(chunk.subarray(i, j)); offset += j + 1 - i; }
      if (i < chunk.length) carry = Buffer.from(chunk.subarray(i));     // copy: buf is reused
    }
  } finally { await fh.close(); }
  return offset;
}

/** Batch size guard: when there are more than `max` records, records older than `keepRawMs` are summed per
 *  (proj, sid, aid, family) and local time bucket (1 min, else 10 min, else 1 h). Aggregates carry
 *  `n` (messages) and `agg` (bucket minutes); raw records have neither (n = 1). Totals are preserved. */
export function compact(recs, max = 5000, now = Date.now(), keepRawMs = 600000) {
  if (recs.length <= max) return recs;
  const d0 = dayStart(now);
  let out = recs;
  for (const bucket of [60000, 600000, 3600000]) {
    out = [];
    const agg = new Map();
    for (const r of recs) {
      const t = Date.parse(r.ts);
      if (now - t < keepRawMs) { out.push(r); continue; }
      const b = d0 + Math.floor((t - d0) / bucket) * bucket;
      const k = `${r.proj}|${r.sid}|${r.aid || ''}|${r.family}|${b}`;
      let a = agg.get(k);
      if (!a) {
        a = { id: `agg:${bucket / 60000}:${k}`, ts: new Date(b).toISOString(), proj: r.proj, sid: r.sid, model: r.model, family: r.family,
          in: 0, out: 0, cacheR: 0, cacheW: 0, n: 0, agg: bucket / 60000 };
        if (r.aid) a.aid = r.aid;
        if (r.atype) a.atype = r.atype;
        agg.set(k, a); out.push(a);
      }
      for (const key of TOKEN_KEYS) a[key] += r[key];
      if (r.usd !== undefined) a.usd = Math.round(((a.usd || 0) + r.usd) * 1e6) / 1e6;
      a.n += r.n || 1;
    }
    if (out.length <= max) break;
  }
  return out.sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
}

/** Tracks today's transcripts. onRecord(rec) fires for every new or changed record after start() has finished. */
export class Usage {
  constructor({ dir, pricingFile = null, onRecord = () => {}, log = () => {}, pollMs = 1000, rescanMs = 10000, root = '/' }) {
    Object.assign(this, { dir, pricingFile, onRecord, log, pollMs, rescanMs, root });
    this.records = new Map();   // message id -> record (today only)
    this.files = new Map();     // path -> {offset, ino, dirName, sid, aid, atype}
    this.dirProj = new Map();   // proj-dir name -> resolved project name
    this.pricing = null; this.pricingMtime = -1;
    this.live = false; this.busy = false; this.timers = [];
  }

  get fileCount() { return this.files.size; }
  get hasPricing() { return !!this.pricing; }

  /** (Re)load pricing.json when its mtime changed; recompute usd on every stored record. */
  loadPricing() {
    if (!this.pricingFile) return;
    let mt = 0;
    try { mt = fs.statSync(this.pricingFile).mtimeMs; } catch { mt = 0; }
    if (mt === this.pricingMtime) return;
    this.pricingMtime = mt;
    this.pricing = mt ? normPricing(loadJson(this.pricingFile, this.log)) : null;
    for (const r of this.records.values()) this.price(r);
  }
  price(r) { const usd = costOf(r, this.pricing); if (usd === undefined) delete r.usd; else r.usd = usd; return r; }

  /** Find today's transcript files (sync, cheap). Subagent dirs are only listed for sessions active today. */
  scan() {
    const d0 = dayStart();
    let dirs = [];
    try { dirs = fs.readdirSync(this.dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { return; }
    const todayJsonl = (dir, re) => {
      let names = [];
      try { names = fs.readdirSync(dir).filter(n => re.test(n)); } catch { return []; }
      return names.map(n => path.join(dir, n)).filter(f => { try { return fs.statSync(f).mtimeMs >= d0; } catch { return false; } });
    };
    for (const dirName of dirs) {
      const pdir = path.join(this.dir, dirName);
      for (const f of todayJsonl(pdir, /\.jsonl$/)) {
        const sid = path.basename(f, '.jsonl');
        this.track(f, { dirName, sid });
        for (const af of todayJsonl(path.join(pdir, sid, 'subagents'), /^agent-.+\.jsonl$/)) {
          this.track(af, { dirName, sid, aid: path.basename(af, '.jsonl').slice('agent-'.length) });
        }
      }
    }
    for (const [f, t] of this.files) if (t.aid && !t.atype) t.atype = this.metaType(f);   // meta may appear late
  }
  track(f, ctx) {
    if (this.files.has(f)) return;
    this.files.set(f, { offset: 0, ino: null, ...ctx, atype: ctx.aid ? this.metaType(f) : undefined });
  }
  metaType(f) {
    const meta = loadJson(f.replace(/\.jsonl$/, '.meta.json'));
    return meta && typeof meta.agentType === 'string' ? meta.agentType : undefined;
  }

  /** Read new complete lines of one file; store (and, when live, emit) new or changed records. */
  async readFile(f) {
    const t = this.files.get(f);
    let st;
    try { st = fs.statSync(f); } catch { return; }
    if ((t.ino !== null && st.ino !== t.ino) || st.size < t.offset) t.offset = 0;   // replaced or truncated
    t.ino = st.ino;
    if (st.size === t.offset) return;
    const d0 = dayStart();
    try {
      t.offset = await readLines(f, t.offset, line => {
        if (line.indexOf(NEEDLE) < 0) return;
        let o;
        try { o = JSON.parse(line.toString('utf8')); } catch { return; }       // malformed line: skip it only
        const r = toRecord(o, t);
        if (!r || Date.parse(r.ts) < d0) return;
        r.proj = this.projOf(t.dirName, o.cwd);
        this.store(r);
      });
    } catch (err) { this.log('usage read error', path.basename(f), err.message); }
  }
  projOf(dirName, cwd) {
    const known = this.dirProj.get(dirName);
    if (known) return known;
    const p = projFromDir(dirName, cwd);
    if (p) { this.dirProj.set(dirName, p); return p; }
    return fallbackProj(dirName, this.root);     // memoised; a later line with a matching cwd still wins
  }
  store(r) {
    this.price(r);
    const old = this.records.get(r.id);
    if (old && old.model === r.model && TOKEN_KEYS.every(k => old[k] === r[k])) return;
    this.records.set(r.id, r);
    if (this.live) try { this.onRecord(r); } catch (err) { this.log('usage emit failed:', err.message); }
  }

  /** One pass over every tracked file (never overlapping itself). */
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try { for (const f of this.files.keys()) await this.readFile(f); } finally { this.busy = false; }
  }
  rescan() {
    const d0 = dayStart();
    for (const [id, r] of this.records) if (Date.parse(r.ts) < d0) this.records.delete(id);   // past midnight
    for (const f of this.files.keys()) {                 // files gone or not modified today: stop tracking them
      let mt = -1;
      try { mt = fs.statSync(f).mtimeMs; } catch {}
      if (mt < d0) this.files.delete(f);
    }
    this.loadPricing();
    this.scan();
  }

  /** Initial scan + read of today's files, then live polling. Resolves when the initial read is done. */
  async start() {
    this.loadPricing();
    this.scan();
    await this.poll();
    this.live = true;
    this.timers.push(setInterval(() => this.poll().catch(err => this.log('usage poll:', err.message)), this.pollMs));
    this.timers.push(setInterval(() => { try { this.rescan(); } catch (err) { this.log('usage rescan:', err.message); } }, this.rescanMs));
    for (const t of this.timers) t.unref?.();
  }
  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; this.live = false; }

  /** Today's records sorted by ts (stable). */
  today() {
    const d0 = dayStart();
    return [...this.records.values()].filter(r => Date.parse(r.ts) >= d0).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  }
  /** What a new SSE client gets: today's records, compacted to at most `max`. */
  batch(max = 5000) { return compact(this.today(), max); }
}

/** Known projects under `dir` (a ~/.claude/projects clone): [{proj, cwd?, lastActive (ISO), sessionsToday}], newest first.
 *  Each transcript dir is mapped to its project (launch dir from the first matching `cwd` in the newest transcripts'
 *  first 256KB, else the filesystem walk; then projectOf) and dirs of one project are merged (worktrees, subfolders):
 *  lastActive = newest, sessionsToday = sum, cwd = project root. Skipped: dirs without transcripts, scratchpads and
 *  temp dirs (name has '-scratchpad' or starts '-private-tmp'/'-tmp'; root under /private/tmp or /tmp, or a root
 *  named "scratchpad"). `aliases` (optional Map) collects launch-dir basename -> project name. */
export function scanProjects(dir, now = Date.now(), { root = '/', aliases = null } = {}) {
  const d0 = dayStart(now), byProj = new Map();
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (name.includes('-scratchpad') || name.startsWith('-private-tmp') || name.startsWith('-tmp-')) continue;
    const sub = path.join(dir, name);
    let files = [];
    try {
      files = fs.readdirSync(sub).filter(f => f.endsWith('.jsonl')).map(f => {
        const full = path.join(sub, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      });
    } catch { continue; }
    if (!files.length) continue;
    files.sort((a, b) => b.mtime - a.mtime);
    let launch = null;
    for (const f of files.slice(0, 3)) {
      try {
        const fd = fs.openSync(f.full, 'r');
        try {
          const buf = Buffer.alloc(256 * 1024);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          for (const line of buf.toString('utf8', 0, n).split('\n')) {
            if (!line.includes('"cwd"')) continue;
            try { const o = JSON.parse(line); launch = launchDirFromCwd(name, o.cwd); if (launch) break; } catch {}
          }
        } finally { fs.closeSync(fd); }
      } catch {}
      if (launch) break;
    }
    if (!launch) { const w = walkDir(name, root); if (w && w.path) launch = w.path; }
    const pr = launch ? projectOf(launch) : null;
    const proj = pr ? pr.name : fallbackProj(name, root);
    const rootDir = pr ? pr.root : null;
    if (rootDir && (/^\/(private\/)?tmp(\/|$)/.test(rootDir) || path.basename(rootDir) === 'scratchpad')) continue;
    if (proj === 'scratchpad') continue;
    if (aliases && launch) aliases.set(path.basename(launch), proj);
    const lastMs = files[0].mtime, today = files.filter(f => f.mtime >= d0).length;
    const cur = byProj.get(proj);
    if (!cur) { byProj.set(proj, { proj, lastMs, sessionsToday: today, cwd: rootDir, exact: !!(launch && launch === rootDir) }); continue; }
    cur.sessionsToday += today;
    if (lastMs > cur.lastMs) cur.lastMs = lastMs;
    if (rootDir && (!cur.cwd || (!cur.exact && launch === rootDir))) { cur.cwd = rootDir; cur.exact = launch === rootDir; }
  }
  return [...byProj.values()].sort((a, b) => b.lastMs - a.lastMs).map(r => {
    const rec = { proj: r.proj, lastActive: new Date(r.lastMs).toISOString(), sessionsToday: r.sessionsToday };
    if (r.cwd) rec.cwd = r.cwd;
    return rec;
  });
}

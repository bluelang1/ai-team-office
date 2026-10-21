// Best-effort "focus the terminal running session <sid>" (macOS only). Focus only, never types.
// Only the validated sid reaches code; the TTY goes to osascript via argv, never into script text.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile } from 'node:child_process';

export const SID_RE = /^[0-9a-f-]{8,64}$/;

/** Default runner: execFile with timeout, resolves {code, stdout} (never rejects). */
export const defaultRun = (cmd, args, timeout = 3000) => new Promise(resolve => {
  execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '') }));
});

const cwdCache = new Map(); // sid -> {at, val}
/** Stream ~/.claude/projects/*\/<sid>.jsonl, stop at first line with string cwd (a `tty` seen up to there is kept).
 *  Found: cached 60s. Not found: cached 5s only (the transcript may appear any moment). */
export async function findSessionCwd(projectsDir, sid, now = Date.now()) {
  const c = cwdCache.get(projectsDir + '\0' + sid);
  if (c && now - c.at < (c.val ? 60000 : 5000)) return c.val;
  let val = null, tty = null;
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch {}
  for (const d of dirs) {
    const f = path.join(projectsDir, d, sid + '.jsonl');
    if (!fs.existsSync(f)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.includes('"cwd"') && !line.includes('"tty"')) continue;
        try {
          const o = JSON.parse(line);
          if (typeof o.tty === 'string' && o.tty) tty = o.tty;
          if (typeof o.cwd === 'string' && o.cwd) { val = { cwd: o.cwd, tty }; break; }
        } catch {}
      }
    } finally { rl.close(); }
    if (val) break;
  }
  cwdCache.set(projectsDir + '\0' + sid, { at: now, val });
  return val;
}

const normTty = t => { t = String(t || '').trim(); return !t || t === '?' || t === '??' ? null : t.replace(/^\/dev\//, ''); };

/** Running `claude` process -> {pid, tty} or null. With a transcript tty, the process on that tty wins (exact);
 *  otherwise (or when none runs there) the first one whose cwd equals `cwd`. Accepts `info` {cwd, tty} or a cwd. */
export async function findClaudeProc(info, run) {
  const { cwd, tty: want } = typeof info === 'string' ? { cwd: info, tty: null } : info;
  const ps = await run('ps', ['-axo', 'pid=,tty=,command=']);
  const procs = [];
  for (const line of ps.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (m && /(^|\/)claude( |$)/.test(m[3])) procs.push(m);
  }
  const wantTty = normTty(want);
  if (wantTty) {
    const m = procs.find(p => normTty(p[2]) === wantTty);
    if (m) return { pid: Number(m[1]), tty: wantTty };
  }
  for (const m of procs) {
    const l = await run('lsof', ['-a', '-p', m[1], '-d', 'cwd', '-Fn']);
    const n = l.stdout.split('\n').find(x => x.startsWith('n'));
    const tty = normTty(m[2]);
    if (n && n.slice(1) === cwd && tty) return { pid: Number(m[1]), tty };
  }
  return null;
}

const ITERM = `on run argv
  set t to "/dev/" & item 1 of argv
  tell application "iTerm2"
    repeat with w in windows
      repeat with tb in tabs of w
        repeat with s in sessions of tb
          if (tty of s) is t then
            select tb
            select s
            set index of w to 1
            activate
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "nomatch"
end run`;
const TERMINAL = `on run argv
  set t to "/dev/" & item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with tb in tabs of w
        if (tty of tb) is t then
          set selected of tb to true
          set index of w to 1
          activate
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "nomatch"
end run`;

async function isRunning(app, run) {
  const r = await run('pgrep', ['-xq', app === 'iTerm2' ? 'iTerm2' : app]);
  return r.code === 0;
}

/** First ancestor executable inside `X.app/Contents/MacOS/` -> .app bundle path, or null. */
async function ancestorBundle(pid, run) {
  for (let i = 0, p = pid; i < 16 && p > 1; i++) {
    const r = await run('ps', ['-o', 'ppid=,comm=', '-p', String(p)]);
    const m = /^\s*(\d+)\s+(.*)$/.exec(r.stdout.trim());
    if (!m) return null;
    const k = m[2].indexOf('.app/Contents/MacOS/');
    if (k >= 0) return m[2].slice(0, k + 4);
    p = Number(m[1]);
  }
  return null;
}
export const bundleAllowed = (b, home = os.homedir()) =>
  !b.includes('..') && [ '/Applications/', '/System/Applications/', path.join(home, 'Applications') + '/' ].some(d => b.startsWith(d));

export async function focusSession(sid, { projectsDir, platform = process.platform, run = defaultRun, home = os.homedir() } = {}) {
  if (platform !== 'darwin') return { ok: false, method: 'unsupported', detail: `platform ${platform}` };
  const info = await findSessionCwd(projectsDir, sid);
  if (!info) return { ok: false, method: 'none', detail: 'session transcript/cwd not found' };
  const proc = await findClaudeProc(info, run);
  if (!proc) return { ok: false, method: 'none', detail: 'no running claude process for that tty/cwd' };
  const tests = [['iTerm2', 'iterm2', ITERM], ['Terminal', 'terminal', TERMINAL]];
  for (const [app, method, script] of tests) {
    if (!(await isRunning(app, run))) continue;
    const r = await run('osascript', ['-e', script, proc.tty]);
    if (r.code === 0 && r.stdout.trim() === 'ok') return { ok: true, method, detail: `tty ${proc.tty}` };
  }
  const bundle = await ancestorBundle(proc.pid, run);
  if (bundle) {
    const name = path.basename(bundle, '.app');
    if (!bundleAllowed(bundle, home)) return { ok: false, method: 'none', detail: `app bundle not allowed: ${name}` };
    const r = await run('open', ['-a', bundle]);
    if (r.code === 0) return { ok: true, method: 'app-bundle', detail: name };
  }
  return { ok: false, method: 'none', detail: `no terminal matched tty ${proc.tty}` };
}

/** 1 call/sec limiter. */
export function makeLimiter(ms = 1000) {
  let last = 0;
  return (now = Date.now()) => { if (now - last < ms) return false; last = now; return true; };
}

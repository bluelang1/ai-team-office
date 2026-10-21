import './home.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { focusSession, findSessionCwd, SID_RE } from '../focus.mjs';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'focus-test-'));
const procs = [];
after(() => { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const proj = path.join(tmp, 'projects');
fs.mkdirSync(path.join(proj, '-x-y'), { recursive: true });
fs.writeFileSync(path.join(proj, '-x-y', SID + '.jsonl'),
  '{"type":"summary"}\nnot json "cwd"\n{"type":"user","cwd":"/work/demo"}\n{"cwd":"/other"}\n');

function startServer() {
  const p = spawn(process.execPath, [SERVER, '--port', '0', '--no-usage', '--projects', proj], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((resolve, reject) => {
    let out = '';
    p.stdout.on('data', b => { out += b; const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    p.on('exit', c => reject(new Error('exited ' + c)));
  });
}
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => resolve({ status: r.statusCode, body: b })); }).on('error', reject);
});

test('SID_RE', () => {
  assert.ok(SID_RE.test(SID));
  for (const b of ['', 'abc', 'ZZZZZZZZ', 'aaaaaaaa;rm', 'a'.repeat(65)]) assert.ok(!SID_RE.test(b));
});

test('cwd lookup from fixture transcript (first hit)', async () => {
  const r = await findSessionCwd(proj, SID);
  assert.equal(r.cwd, '/work/demo');
  assert.equal(await findSessionCwd(proj, 'bbbbbbbb-0000'), null);
});

test('transcript tty is preferred over the cwd match; null lookups are cached 5s only', async () => {
  const sid = 'cccccccc-1111-2222-3333-444444444444';
  fs.writeFileSync(path.join(proj, '-x-y', sid + '.jsonl'), '{"type":"user","tty":"/dev/ttys009","cwd":"/work/demo"}\n');
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'ps' && args[0] === '-axo') return { code: 0, stdout: '  901 ttys007 claude\n  905 ttys009 claude\n' };
    if (cmd === 'lsof') return { code: 0, stdout: 'n/work/demo\n' };              // both share the cwd
    if (cmd === 'pgrep') return { code: args[1] === 'iTerm2' ? 0 : 1, stdout: '' };
    if (cmd === 'osascript') return { code: 0, stdout: 'ok\n' };
    return { code: 1, stdout: '' };
  };
  const r = await focusSession(sid, { projectsDir: proj, platform: 'darwin', run });
  assert.deepEqual([r.ok, r.detail], [true, 'tty ttys009']);
  assert.equal(calls.some(c => c[0] === 'lsof'), false, 'tty match needs no cwd lookup');
  const late = 'dddddddd-1111-2222-3333-444444444444', t = Date.now();
  assert.equal(await findSessionCwd(proj, late, t), null);
  fs.writeFileSync(path.join(proj, '-x-y', late + '.jsonl'), '{"cwd":"/late"}\n');
  assert.equal(await findSessionCwd(proj, late, t + 4000), null, 'cached null within 5s');
  assert.equal((await findSessionCwd(proj, late, t + 5100)).cwd, '/late', 'null not cached for 60s');
});

test('unsupported platform', async () => {
  const r = await focusSession(SID, { projectsDir: proj, platform: 'linux', run: async () => { throw new Error('no'); } });
  assert.equal(r.ok, false); assert.equal(r.method, 'unsupported');
});

test('osascript receives tty as argv, not in script', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'ps' && args[0] === '-axo') return { code: 0, stdout: '  901 ttys007 /usr/local/bin/claude --x\n  902 ?? /bin/zsh\n' };
    if (cmd === 'lsof') return { code: 0, stdout: 'p901\nfcwd\nn/work/demo\n' };
    if (cmd === 'pgrep') return { code: args[1] === 'iTerm2' ? 0 : 1, stdout: '' };
    if (cmd === 'osascript') return { code: 0, stdout: 'ok\n' };
    return { code: 1, stdout: '' };
  };
  const r = await focusSession(SID, { projectsDir: proj, platform: 'darwin', run });
  assert.deepEqual([r.ok, r.method], [true, 'iterm2']);
  const osa = calls.find(c => c[0] === 'osascript');
  assert.equal(osa[1][2], 'ttys007');
  assert.ok(!osa[1][1].includes('ttys007'));
});

function bundleRun(comm, calls) {
  return async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'ps' && args[0] === '-axo') return { code: 0, stdout: '  901 ttys004 claude\n' };
    if (cmd === 'lsof') return { code: 0, stdout: 'n/work/demo\n' };
    if (cmd === 'pgrep') return { code: 1, stdout: '' };
    if (cmd === 'ps') {
      const p = args[3];
      if (p === '901') return { code: 0, stdout: '  850 claude\n' };
      if (p === '850') return { code: 0, stdout: '  800 /bin/zsh\n' };
      if (p === '800') return { code: 0, stdout: ' 1 ' + comm + '\n' };
    }
    return { code: 0, stdout: '' };
  };
}
test('app-bundle fallback from ps ancestry', async () => {
  const calls = [];
  const r = await focusSession(SID, { projectsDir: proj, platform: 'darwin',
    run: bundleRun('/Applications/Terminal App.app/Contents/MacOS/terminal-app', calls) });
  assert.deepEqual([r.ok, r.method, r.detail], [true, 'app-bundle', 'Terminal App']);
  assert.deepEqual(calls.find(c => c[0] === 'open')[1], ['-a', '/Applications/Terminal App.app']);
});
test('app-bundle outside allowed dirs is rejected', async () => {
  const calls = [];
  const r = await focusSession(SID, { projectsDir: proj, platform: 'darwin', home: '/Users/me',
    run: bundleRun('/tmp/evil.app/Contents/MacOS/x', calls) });
  assert.deepEqual([r.ok, r.method], [false, 'none']);
  assert.ok(!calls.some(c => c[0] === 'open'));
});

test('endpoint: 400 bad sid, 403 origin, 421 host, 429 rate limit', async () => {
  const port = await startServer();
  assert.equal((await get(port, '/focus?sid=nope')).status, 400);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await get(port, '/focus?sid=' + SID, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await get(port, '/focus?sid=' + SID, { Host: 'evil.example' })).status, 421);
  await new Promise(r => setTimeout(r, 1100));
  const a = await get(port, '/focus?sid=' + SID);
  assert.equal(a.status, 200);
  assert.equal(JSON.parse(a.body).ok, false); // no such claude proc for /work/demo
  assert.equal((await get(port, '/focus?sid=' + SID)).status, 429);
});

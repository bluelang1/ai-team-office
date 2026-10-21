import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { redact, stripUrl, dayStart, okHost, okOrigin } from '../server.mjs';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const HOME = os.homedir();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-test-'));
const procs = [];
after(() => { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const now = () => new Date().toISOString();
const SECRETS = ['hunter2', 'sk-live-abc', 'tok3n', 'PRIVATE PROMPT', 'sub-secret', 'last msg', 'stack-trace'];
const secretEvents = () => [
  { ts: now(), ev: 'PreToolUse', sid: 's', proj: 'P', tool: 'Bash', cwd: `${HOME}/proj`, target: `API_KEY=hunter2 curl -H "x: sk-live-abc" https://h/x?k=tok3n` },
  { ts: now(), ev: 'PreToolUse', sid: 's', proj: 'P', tool: 'WebFetch', target: `https://user:hunter2@api.example.com/v1/items?token=tok3n#frag` },
  { ts: now(), ev: 'PreToolUse', sid: 's', proj: 'P', tool: 'Agent', sub: { type: 'lookup', desc: `look in ${HOME}/x`, prompt: 'sub-secret' } },
  { ts: now(), ev: 'UserPromptSubmit', sid: 's', proj: 'P', prompt: 'PRIVATE PROMPT', cwd: HOME },
  { ts: now(), ev: 'PostToolUseFailure', sid: 's', proj: 'P', tool: 'Bash', err: 'stack-trace sk-live-abc' },
  { ts: now(), ev: 'SubagentStop', sid: 's', proj: 'P', aid: 'a1', msg: 'last msg tok3n' },
  { ts: now(), ev: 'PreToolUse', sid: 's', proj: 'P', tool: 'Read', target: `${HOME}/.ssh/config` },
];
const assertClean = json => {
  for (const x of [...SECRETS, '?', HOME]) assert.equal(json.includes(x), false, `leaked ${JSON.stringify(x)} in ${json}`);
};

test('redact drops free text, strips URL queries, masks Bash, unhomes paths', () => {
  const out = secretEvents().map(redact);
  assertClean(JSON.stringify(out));
  assert.equal(out[0].target, 'API_KEY=*** ***');
  assert.equal(out[0].room, 'external', 'room classified before masking');
  assert.equal(out[1].target, 'https://api.example.com/v1/items');
  assert.equal(out[2].sub.desc, 'look in ~/x');
  assert.equal(out[6].target, '~/.ssh/config');
  for (const k of ['prompt', 'msg', 'err', 'cwd']) assert.equal(out.some(e => k in e), false, k);
  assert.equal(stripUrl('not a url?x'), 'not a url?x');
});

test('host/origin guards and local day boundary', () => {
  for (const h of ['127.0.0.1', '127.0.0.1:4747', 'localhost', 'LOCALHOST:1', '[::1]:4747']) assert.equal(okHost(h), true, h);
  for (const h of [undefined, '', 'evil.com', 'evil.com:4747', '127.0.0.1.evil.com', 'localhost:4747@evil', '127.0.0.2']) assert.equal(okHost(h), false, h);
  assert.equal(okOrigin(undefined), true);
  assert.equal(okOrigin('http://localhost:4747'), true);
  for (const o of ['null', 'http://evil.com', 'http://localhost.evil.com']) assert.equal(okOrigin(o), false, o);
  const d = new Date(dayStart());
  assert.deepEqual([d.getHours(), d.getMinutes(), d.getSeconds()], [0, 0, 0]);
});

// ---------- live server ----------
function startServer(args) {
  const p = spawn(process.execPath, [SERVER, '--port', '0', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((resolve, reject) => {
    let out = '';
    p.stdout.on('data', b => { out += b; const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    p.on('exit', c => reject(new Error(`server exited ${c}: ${out}`)));
  });
}
function req(port, { method = 'GET', path: p = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => {
      let body = '';
      res.on('data', b => { body += b; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject); r.end();
  });
}
/** Read the SSE stream until `until(text)` is true; returns the raw text. */
function stream(port, until, ms = 4000) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/events' }, res => {
      let text = '';
      const t = setTimeout(() => { r.destroy(); reject(new Error(`timeout; got: ${text}`)); }, ms);
      res.on('data', b => { text += b; if (until(text)) { clearTimeout(t); r.destroy(); resolve(text); } });
    });
    r.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}
const events = text => text.split('\n\n').flatMap(f => {
  const data = f.split('\n').find(l => l.startsWith('data: '));
  if (!data || f.includes('event: ready')) return [];
  const v = JSON.parse(data.slice(6));
  return Array.isArray(v) ? v : [v];
});

test('live server: guards, NUL path, bad lines never lose the rest, dayStart in ready', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'live-'));
  const f = path.join(logs, 'office-events.jsonl');
  const line = o => JSON.stringify({ ts: now(), sid: 's1', proj: 'P', ...o });
  fs.writeFileSync(f, [
    line({ ev: 'Stop' }),
    line({ ev: 'PreToolUse', tool: 123, target: { x: 1 } }),
    '{garbage', line({ ev: { bad: 1 } }), line({ ev: 'PreToolUse', aid: 7, tool: 'Read' }),
    JSON.stringify({ ts: '2000-01-01T00:00:00Z', ev: 'Stop', sid: 'old', proj: 'P' }),
    line({ ev: 'UserPromptSubmit', prompt: 'last good' }), ''].join('\n'));
  const port = await startServer(['--logs', logs]);
  assert.equal((await req(port, { path: '/events', headers: { Host: 'evil.com' } })).status, 421);
  assert.equal((await req(port, { path: '/', headers: { Host: `attacker.test:${port}` } })).status, 421);
  assert.equal((await req(port, { path: '/events', headers: { Origin: 'http://evil.com' } })).status, 403);
  assert.equal((await req(port, { method: 'HEAD', path: '/events' })).status, 405);
  assert.equal((await req(port, { method: 'POST', path: '/events' })).status, 405);
  assert.equal((await req(port, { path: '/%00' })).status, 400);
  assert.equal((await req(port, { path: '/', headers: { Host: `localhost:${port}` } })).status, 200);

  const text = await stream(port, t => t.includes('event: ready'));
  const evs = events(text);
  assert.deepEqual(evs.map(e => e.ev), ['Stop', 'PreToolUse', 'PreToolUse', 'UserPromptSubmit'], 'bad lines skipped, yesterday cut');
  assert.equal(evs[1].tool, '123'); assert.equal(evs[2].aid, '7');
  const ready = JSON.parse(/event: ready\ndata: (.*)/.exec(text)[1]);
  assert.equal(ready.dayStart, dayStart()); assert.equal(ready.count, 4);

  // tail: a chunk with bad lines in the middle still delivers the good line after them
  const got = stream(port, t => t.includes('after-bad'), 8000);
  setTimeout(() => fs.appendFileSync(f, ['{bad', line({ ev: 'Stop', sid: [1] }), line({ ev: 'Notification', ntype: 'after-bad' }), ''].join('\n')), 300);
  assert.ok(events(await got).some(e => e.ntype === 'after-bad'));
});

test('--redact stream carries no secrets, no query strings, no $HOME', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'redact-'));
  fs.writeFileSync(path.join(logs, 'office-events.jsonl'), secretEvents().map(e => JSON.stringify(e)).join('\n') + '\n');
  const port = await startServer(['--logs', logs, '--redact']);
  const text = await stream(port, t => t.includes('event: ready'));
  assert.equal(events(text).length, secretEvents().length);
  assertClean(text.replace(/^retry.*$/m, ''));
});

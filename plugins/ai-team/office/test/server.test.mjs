import './home.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { redact, stripUrl, dayStart, okHost, okOrigin, validateBuilding, normaliseBuilding, sameServerOrigin,
  configPath, configWriteDir, migrateConfig, configHome } from '../server.mjs';
import { encodeDir } from '../usage.mjs';

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
function startServer(args, env = {}) {
  const p = spawn(process.execPath, [SERVER, '--port', '0', '--no-usage', ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
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

// ---------- floor editor endpoints ----------
const FIX = fileURLToPath(new URL('./fixtures/usage/projects', import.meta.url));
function post(port, body, { headers = {}, path: p = '/building.json' } = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: p,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', e => resolve({ status: 0, body: String(e.code || e.message) }));   // server may cut an oversized upload
    r.end(data);
  });
}

test('GET /projects.json: shape, sort, no scratchpads; --redact omits cwd', async () => {
  const proj = fs.mkdtempSync(path.join(tmp, 'projs-'));
  fs.cpSync(FIX, proj, { recursive: true });
  for (const n of ['-Users-x-proj-scratchpad', '-private-tmp-foo']) { fs.mkdirSync(path.join(proj, n)); fs.writeFileSync(path.join(proj, n, 's.jsonl'), '{}\n'); }
  const port = await startServer(['--projects', proj, '--config', proj]);
  const r = await req(port, { path: '/projects.json' });
  assert.equal(r.status, 200);
  const list = JSON.parse(r.body);
  assert.ok(Array.isArray(list) && list.length >= 3);
  assert.deepEqual(list.map(x => x.proj).filter(n => /scratch|foo/.test(n)), []);
  for (const x of list) {
    assert.equal(typeof x.proj, 'string');
    assert.equal(new Date(x.lastActive).toISOString(), x.lastActive);
    assert.ok(Number.isInteger(x.sessionsToday) && x.sessionsToday >= 0);
  }
  assert.deepEqual(list.map(x => x.lastActive), list.map(x => x.lastActive).sort().reverse());
  assert.ok(list.some(x => x.proj === 'AI_Team' && x.cwd === '/Users/x/Documents/AI_Team'), r.body);
  assert.equal((await req(port, { path: '/projects.json', headers: { Origin: 'http://evil.com' } })).status, 403);
  const rp = await startServer(['--projects', proj, '--config', proj, '--redact']);
  const red = JSON.parse((await req(rp, { path: '/projects.json' })).body);
  assert.ok(red.length >= 3 && red.every(x => !('cwd' in x)));
});

test('validateBuilding is strict', () => {
  const ok = { ceo: 'c', floors: { a: { floor: 1, label: 'x' } } };
  assert.deepEqual(validateBuilding(ok).value, ok);
  for (const bad of [null, [], { floors: {}, extra: 1 }, { floors: [] }, { floors: { a: { floor: 1.5, label: 'x' } } },
    { floors: { a: { floor: 0, label: 'x' } } }, { floors: { a: { floor: 100, label: 'x' } } }, { floors: { a: { floor: '1', label: 'x' } } },
    { floors: { a: { floor: 1, label: 'x'.repeat(41) } } }, { floors: { a: { floor: 1, label: 'a\nb' } } },
    { floors: { a: { floor: 1, label: 'x', z: 1 } } }, { ceo: 5, floors: {} }, { ceo: 'a\u0007', floors: {} },
    { floors: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`p${i}`, { floor: 1, label: '' }])) }])
    assert.ok(validateBuilding(bad).error, JSON.stringify(bad).slice(0, 80));
});

test('POST /building.json: round trip, rejections, symlink', async () => {
  const cfg = fs.mkdtempSync(path.join(tmp, 'cfg-'));
  const port = await startServer(['--config', cfg]);
  const good = { ceo: 'Boss', floors: { 'shop-backend-app': { floor: 2, label: 'Shop' }, AI_Team: { floor: 9, label: '팀' } } };
  const r = await post(port, good, { headers: { Origin: `http://localhost:${port}` } });
  assert.equal(r.status, 200); assert.deepEqual(JSON.parse(r.body), good);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cfg, 'building.json'), 'utf8')), good);
  const { unknownKeys, ...served } = JSON.parse((await req(port, { path: '/building.json' })).body);
  assert.ok(Array.isArray(unknownKeys)); assert.deepEqual(served, good);
  assert.equal((await post(port, { ...good, unknownKeys })).status, 200, 'served unknownKeys round-trips (dropped on save)');
  assert.deepEqual(fs.readdirSync(cfg), ['building.json'], 'no stray tmp files');

  const before = fs.readFileSync(path.join(cfg, 'building.json'), 'utf8');
  assert.equal((await post(port, { floors: { a: { floor: 'x', label: '' } } })).status, 400);
  assert.equal((await post(port, { floors: {}, evil: 1 })).status, 400);
  assert.equal((await post(port, '{not json')).status, 400);
  assert.equal((await post(port, good, { headers: { Origin: 'http://evil.com' } })).status, 403);
  assert.equal((await post(port, good, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(port, good, { headers: { Host: 'evil.com' } })).status, 421);
  const big = await post(port, JSON.stringify({ floors: {}, ceo: 'x'.repeat(70000) }));
  assert.ok(big.status === 413 || big.status === 0, `oversized -> ${big.status}`);
  assert.equal(fs.readFileSync(path.join(cfg, 'building.json'), 'utf8'), before, 'rejected posts leave the file untouched');

  const cfg2 = fs.mkdtempSync(path.join(tmp, 'cfg-'));
  const victim = path.join(cfg2, 'victim.json'); fs.writeFileSync(victim, 'KEEP');
  fs.symlinkSync(victim, path.join(cfg2, 'building.json'));
  const p2 = await startServer(['--config', cfg2]);
  assert.equal((await post(p2, good)).status, 409);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'KEEP');
  assert.ok(fs.lstatSync(path.join(cfg2, 'building.json')).isSymbolicLink());
});

test('normaliseBuilding: alias / encodeDir keys map to the real project name; exact key wins; unknownKeys listed', () => {
  const b = { ceo: 'c', unknownKeys: ['stale'], floors: { 'web-ui': { floor: 4, label: 'G' }, office: { floor: 9, label: 'O' },
    AI_Team: { floor: 8, label: 'A' }, my_app: { floor: 3, label: 'E' }, ghost: { floor: 1, label: 'X' } } };
  const out = normaliseBuilding(b, ['web_ui', 'AI_Team', 'shop-backend-app'], new Map([['office', 'AI_Team']]));
  assert.deepEqual(out, { ceo: 'c', floors: { AI_Team: { floor: 8, label: 'A' }, web_ui: { floor: 4, label: 'G' },
    my_app: { floor: 3, label: 'E' }, ghost: { floor: 1, label: 'X' } }, unknownKeys: ['my_app', 'ghost'] });
  assert.equal(normaliseBuilding(null, []), null);
  assert.equal(sameServerOrigin({ referer: 'http://127.0.0.1:4747/?sim=0' }, 4747), true);
  assert.equal(sameServerOrigin({ origin: 'http://localhost:4747' }, 4747), true);
  for (const h of [{}, { referer: 'http://127.0.0.1:4748/' }, { referer: 'http://evil.com:4747/' }, { origin: 'null' }, { referer: 'https://127.0.0.1:4747/' }])
    assert.equal(sameServerOrigin(h, 4747), false, JSON.stringify(h));
});

test('live: office-events proj -> project root (subfolder, worktree); building keys normalised in ready and GET', async () => {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'roots-')));
  for (const d of ['repo_x/.git/worktrees/w1', 'repo_x/sub', 'wt/w1', 'web_ui/.git']) fs.mkdirSync(path.join(T, d), { recursive: true });
  fs.writeFileSync(path.join(T, 'wt/w1/.git'), `gitdir: ${T}/repo_x/.git/worktrees/w1\n`);
  const projs = path.join(T, 'projects'), logs = path.join(T, 'logs'), cfg = path.join(T, 'cfg');
  for (const d of [logs, cfg]) fs.mkdirSync(d);
  const pd = path.join(projs, encodeDir(`${T}/web_ui`)); fs.mkdirSync(pd, { recursive: true });
  fs.writeFileSync(path.join(pd, 's.jsonl'), JSON.stringify({ type: 'user', cwd: `${T}/web_ui` }) + '\n');
  fs.writeFileSync(path.join(logs, 'office-events.jsonl'), [
    { ts: now(), ev: 'Stop', sid: 's1', proj: 'sub', cwd: `${T}/repo_x/sub` },
    { ts: now(), ev: 'Stop', sid: 's2', proj: 'w1', cwd: `${T}/wt/w1` },
    { ts: now(), ev: 'Stop', sid: 's3', proj: 'plain', cwd: `${T}/plain` }].map(e => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(cfg, 'building.json'), JSON.stringify({ floors: { 'web-ui': { floor: 4, label: 'G' }, sub: { floor: 2, label: 'S' }, nobody: { floor: 7, label: 'N' } } }));
  const port = await startServer(['--logs', logs, '--projects', projs, '--config', cfg]);
  const text = await stream(port, t => t.includes('event: ready'));
  assert.deepEqual(events(text).map(e => e.proj), ['repo_x', 'repo_x', 'plain']);
  const ready = JSON.parse(/event: ready\ndata: (.*)/.exec(text)[1]);
  const want = { floors: { web_ui: { floor: 4, label: 'G' }, repo_x: { floor: 2, label: 'S' }, nobody: { floor: 7, label: 'N' } }, unknownKeys: ['nobody'] };
  assert.deepEqual(ready.building, want);
  assert.deepEqual(JSON.parse((await req(port, { path: '/building.json' })).body), want);
});

test('config: --config > ~/.claude/ai-team-office > code folder (read-only); legacy copied once, never overwritten', () => {
  const root = fs.mkdtempSync(path.join(tmp, 'cfgorder-'));
  const home = path.join(root, 'home', '.claude', 'ai-team-office'), legacy = path.join(root, 'office'), explicit = path.join(root, 'x');
  fs.mkdirSync(legacy, { recursive: true });
  assert.equal(configHome('/h'), '/h/.claude/ai-team-office');
  assert.equal(configPath('building.json', { home, legacy }), path.join(home, 'building.json'), 'nothing anywhere -> new home');
  fs.writeFileSync(path.join(legacy, 'building.json'), '{"floors":{"old":{"floor":1,"label":""}}}');
  assert.equal(configPath('building.json', { home, legacy }), path.join(legacy, 'building.json'), 'legacy read as a fallback');
  assert.equal(configPath('building.json', { explicit, home, legacy }), path.join(explicit, 'building.json'));
  assert.equal(configWriteDir({ home }), home, 'writes never go to the code folder');
  assert.equal(configWriteDir({ explicit, home }), explicit);
  const said = [];
  assert.deepEqual(migrateConfig({ home, legacy, log: m => said.push(m) }), ['building.json']);
  assert.equal(said.length, 1); assert.match(said[0], /copied building\.json/);
  assert.equal((fs.statSync(home).mode & 0o777), 0o700);
  assert.equal(configPath('building.json', { home, legacy }), path.join(home, 'building.json'));
  fs.writeFileSync(path.join(home, 'building.json'), '{"floors":{}}');
  assert.deepEqual(migrateConfig({ home, legacy }), [], 'second start: nothing to copy');
  assert.equal(fs.readFileSync(path.join(home, 'building.json'), 'utf8'), '{"floors":{}}', 'never overwrites the new copy');
});

test('POST /building.json without --config writes ~/.claude/ai-team-office/building.json (dir created 700)', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'home-')));
  const port = await startServer([], { HOME: home });
  const good = { floors: { 'my-app': { floor: 3, label: 'App' } } };
  assert.equal((await post(port, good, { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  const dir = path.join(home, '.claude', 'ai-team-office');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'building.json'), 'utf8')), good);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const { unknownKeys, ...served } = JSON.parse((await req(port, { path: '/building.json' })).body);
  assert.deepEqual(served, good, 'read back from the new home');
});

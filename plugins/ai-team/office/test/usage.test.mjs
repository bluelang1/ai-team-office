import './home.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Usage, familyOf, projFromDir, fallbackProj, normPricing, costOf, compact, toRecord, dayStart, projectOf, encodeDir, walkDir, scanProjects } from '../usage.mjs';

const FIX = fileURLToPath(new URL('./fixtures/usage/', import.meta.url));
const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-usage-'));
const procs = [];
after(() => { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const iso = ms => new Date(ms).toISOString();
/** Copy fixtures/usage into a fresh dir, turning {{T+N}} into local midnight + N s and {{Y}} into 1 min before it.
 *  s-old.jsonl gets yesterday's mtime (must not be read at all). */
function makeFixture() {
  const dst = fs.mkdtempSync(path.join(tmp, 'fx-')), d0 = dayStart();
  const copy = (src, out) => {
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name), o = path.join(out, ent.name);
      if (ent.isDirectory()) { fs.mkdirSync(o, { recursive: true }); copy(s, o); continue; }
      fs.writeFileSync(o, fs.readFileSync(s, 'utf8').replace(/\{\{T\+(\d+)\}\}/g, (_, n) => iso(d0 + Number(n) * 1000)).replace(/\{\{Y\}\}/g, iso(d0 - 60000)));
    }
  };
  copy(FIX, dst);
  const old = path.join(dst, 'projects', '-Users-x-Old', 's-old.jsonl'), y = new Date(d0 - 3600000);
  fs.utimesSync(old, y, y);
  return { projects: path.join(dst, 'projects'), config: dst };
}
async function loaded(opts = {}) {
  const fx = makeFixture();
  const u = new Usage({ dir: fx.projects, ...opts });
  await u.start();
  u.stop();
  return { u, fx, byId: Object.fromEntries(u.today().map(r => [r.id, r])) };
}

test('family classification', () => {
  assert.equal(familyOf('claude-fable-5-1'), 'fable');
  assert.equal(familyOf('claude-opus-5-5'), 'opus');
  assert.equal(familyOf('Claude-Sonnet-5'), 'sonnet');
  assert.equal(familyOf('claude-haiku-5-5'), 'haiku');
  for (const m of ['<synthetic>', 'gpt-x', '', null, undefined, 42]) assert.equal(familyOf(m), 'unknown', String(m));
});

test('proj decoding: cwd (or an ancestor) wins over the ambiguous dir name; worktree dir under the cwd', () => {
  const d = '-Users-x-Documents-AI-Team';
  assert.equal(projFromDir(d, '/Users/x/Documents/AI_Team'), 'AI_Team');
  assert.equal(projFromDir(d, '/Users/x/Documents/AI_Team/office'), 'AI_Team', 'session cd-ed deeper');
  assert.equal(projFromDir('-Users-x-IdeaProjects-shop-backend-app--claude-worktrees-feat-1', '/Users/x/IdeaProjects/shop-backend-app'), 'shop-backend-app',
    'worktree dir accepted from the project cwd (dirName starts with encodeDir(cwd) + "-")');
  assert.equal(projFromDir(d, '/somewhere/else'), null);
  assert.equal(projFromDir(d, '/'), null, '"/" is never a prefix match');
  assert.equal(projFromDir(d, undefined), null);
  assert.equal(fallbackProj('-Users-x-nowhere-at-all-Team'), '-Users-x-nowhere-at-all-Team', 'no cwd, nothing on disk: whole dir name, never "Team"');
});

/** T/main_repo(.git dir)/sub/deeper, T/main_repo/.claude/worktrees/wt-1 (.git file -> main), T/plain/folder,
 *  T/claude_proj (CLAUDE.md)/x, T/my_app + T/my (no "app" child: dash/underscore ambiguity), T/web_ui. */
function tree() {
  const T = fs.realpathSync(fs.mkdtempSync(path.join(tmp, 'tree-')));
  for (const d of ['main_repo/.git/worktrees/wt-1', 'main_repo/sub/deeper', 'main_repo/.claude/worktrees/wt-1', 'plain/folder',
    'claude_proj/x', 'my_app', 'my', 'web_ui/.git']) fs.mkdirSync(path.join(T, d), { recursive: true });
  fs.writeFileSync(path.join(T, 'main_repo/.claude/worktrees/wt-1/.git'), `gitdir: ${T}/main_repo/.git/worktrees/wt-1\n`);
  fs.writeFileSync(path.join(T, 'claude_proj/CLAUDE.md'), '# x\n');
  return T;
}

test('project root: nested folder -> repo, worktree .git file -> main repo, CLAUDE.md marks a root, plain folder is itself', () => {
  const T = tree();
  assert.deepEqual(projectOf(`${T}/main_repo/sub/deeper`), { root: `${T}/main_repo`, name: 'main_repo', marked: true });
  assert.deepEqual(projectOf(`${T}/main_repo/.claude/worktrees/wt-1`), { root: `${T}/main_repo/.claude/worktrees/wt-1`, name: 'main_repo', marked: true });
  assert.equal(projectOf(`${T}/claude_proj/x`).name, 'claude_proj');
  assert.deepEqual(projectOf(`${T}/plain/folder`), { root: `${T}/plain/folder`, name: 'folder', marked: false });
  assert.equal(projectOf('relative/path'), null);
  assert.equal(projectOf(os.homedir()).root, os.homedir(), '$HOME (has ~/.claude) is never a marked root');
  assert.equal(projFromDir(encodeDir(`${T}/main_repo/sub`), `${T}/main_repo/sub/deeper`), 'main_repo', 'launched in a subfolder');
});

test('fs walk rebuilds the real path: dash/underscore ambiguity, subfolder, removed worktree, unknown -> whole dir name', () => {
  const T = tree();
  assert.deepEqual(walkDir(encodeDir(`${T}/my_app`), T), { path: `${T}/my_app` }, 'backtracks out of T/my');
  assert.equal(fallbackProj(encodeDir(`${T}/my_app`), T), 'my_app');
  assert.equal(fallbackProj(encodeDir(`${T}/web_ui`), T), 'web_ui', 'not "ui"');
  assert.equal(fallbackProj(encodeDir(`${T}/main_repo/sub/deeper`), T), 'main_repo');
  assert.equal(fallbackProj(encodeDir(`${T}/main_repo/.claude/worktrees/wt-1`), T), 'main_repo');
  assert.equal(fallbackProj(encodeDir(`${T}/main_repo/.claude/worktrees/gone-wt`), T), 'main_repo', 'removed worktree: deepest existing dir is in the repo');
  const nope = encodeDir(`${T}/plain/nope-x`);
  assert.equal(fallbackProj(nope, T), nope, 'partial path in an unmarked folder: whole dir name');
});

test('scanProjects merges a project\'s subfolder/worktree dirs, collects aliases, skips scratchpads', () => {
  const T = tree(), P = fs.mkdtempSync(path.join(tmp, 'pp-'));
  const add = (launch, cwd, mtime) => {
    const d = path.join(P, encodeDir(launch)); fs.mkdirSync(d, { recursive: true });
    const f = path.join(d, `s${Math.random().toString(36).slice(2)}.jsonl`);
    fs.writeFileSync(f, (cwd ? JSON.stringify({ type: 'user', cwd }) : '{"type":"summary"}') + '\n');
    if (mtime) fs.utimesSync(f, new Date(mtime), new Date(mtime));
  };
  add(`${T}/main_repo`, `${T}/main_repo`);
  add(`${T}/main_repo/sub`, `${T}/main_repo/sub`);
  add(`${T}/main_repo/.claude/worktrees/wt-1`, null);                 // no cwd: fs walk
  add(`${T}/plain/folder`, `${T}/plain/folder`, dayStart() - 3600000);
  add(`${T}/x-scratchpad`, `${T}/x/scratchpad`);
  const aliases = new Map();
  const list = scanProjects(P, Date.now(), { root: T, aliases });
  assert.deepEqual(list.map(x => [x.proj, x.sessionsToday, x.cwd]), [['main_repo', 3, `${T}/main_repo`], ['folder', 0, `${T}/plain/folder`]]);
  assert.equal(aliases.get('sub'), 'main_repo');
  assert.equal(aliases.get('wt-1'), 'main_repo');
});

test('parser: dedupe by message id keeps the last line, malformed/no-usage/zero-token lines skipped', async () => {
  const { byId } = await loaded();
  assert.deepEqual(Object.keys(byId).sort(), ['msg_A', 'msg_B', 'msg_C', 'msg_H1', 'msg_H2', 'msg_M', 'msg_N1', 'msg_O', 'msg_U']);
  assert.deepEqual({ ...byId.msg_A }, { id: 'msg_A', ts: iso(dayStart() + 3602000), sid: 's-main', model: 'claude-fable-5-1',
    in: 3, out: 407, cacheR: 0, cacheW: 2949, family: 'fable', proj: 'AI_Team' });
  assert.equal(byId.msg_H2.out, 25, 'streamed message: last line wins');
  assert.equal(byId.msg_U.family, 'unknown');
  assert.equal(byId.msg_O.proj, 'shop-backend-app');
  assert.equal(byId.msg_C.proj, '-Users-x-Work-my-proj', 'no cwd, path not on disk: whole dir name (never a guessed segment)');
  assert.equal(Object.values(byId).reduce((s, r) => s + r.out, 0), 978);
  assert.equal(toRecord({ type: 'user', message: { id: 'x', usage: { output_tokens: 1 } }, timestamp: iso(Date.now()) }, { sid: 's' }), null);
});

test('subagents: aid from agent-<aid>.jsonl, atype from meta.json when present, sid from parent dir', async () => {
  const { byId } = await loaded();
  assert.deepEqual([byId.msg_H1.sid, byId.msg_H1.aid, byId.msg_H1.atype, byId.msg_H1.family], ['s-main', 'a111', 'lookup', 'haiku']);
  assert.deepEqual([byId.msg_N1.aid, byId.msg_N1.atype, byId.msg_N1.family], ['a222', undefined, 'sonnet']);
  assert.equal('aid' in byId.msg_A, false, 'main session records carry no aid');
});

test('today filter: local midnight inclusive, older lines and files not modified today excluded', async () => {
  const { u, byId } = await loaded();
  const d = new Date(dayStart());
  assert.deepEqual([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()], [0, 0, 0, 0]);
  assert.equal(byId.msg_M.ts, iso(dayStart()), 'exactly midnight is today');
  assert.equal(byId.msg_Y, undefined, 'one minute before midnight is yesterday');
  assert.equal(byId.msg_OLD, undefined, 'file with yesterday mtime is not read');
  assert.equal(u.fileCount, 5);
  const y = new Date(dayStart() - 3600000), f = [...u.files.keys()].find(k => k.endsWith('s-shop.jsonl'));
  fs.utimesSync(f, y, y);
  u.rescan();
  assert.equal(u.fileCount, 4, 'rescan prunes files not modified today');
  assert.equal(u.files.has(f), false);
});

test('pricing: usd only when pricing.json exists, only for complete family rows', async () => {
  const none = await loaded();
  assert.equal(none.u.hasPricing, false);
  assert.equal(Object.values(none.byId).some(r => 'usd' in r), false);
  const fx = makeFixture();
  const { u, byId } = await loaded({ pricingFile: path.join(fx.config, 'pricing.json') });
  assert.equal(u.hasPricing, true);
  assert.equal(byId.msg_A.usd, 0.004503);         // (3*1 + 407*2 + 0*0.5 + 2949*1.25) / 1e6
  assert.equal(byId.msg_H1.usd, 0.000718);        // (3391*0.1 + 50*0.2 + 2949*0.125) / 1e6
  assert.equal('usd' in byId.msg_O, false, 'opus row lacks out/cacheR/cacheW -> no guess');
  assert.equal('usd' in byId.msg_N1, false, 'no sonnet row');
  assert.deepEqual(normPricing({ _comment: 'x', fable: { in: 0, out: 0, cacheR: 0, cacheW: 0 } }), { fable: { in: 0, out: 0, cacheR: 0, cacheW: 0 } });
  assert.equal(normPricing({ _comment: 'x' }), null);
  assert.equal(costOf({ family: 'fable', in: 1e6, out: 0, cacheR: 0, cacheW: 0 }, null), undefined);
});

test('live: appended lines and new subagent files are picked up; unchanged duplicates are not re-emitted', async () => {
  const fx = makeFixture();
  const got = [];
  const u = new Usage({ dir: fx.projects, onRecord: r => got.push(r), pollMs: 20, rescanMs: 40 });
  await u.start();
  const main = path.join(fx.projects, '-Users-x-Documents-AI-Team', 's-main.jsonl');
  const line = (id, out, extra = {}) => JSON.stringify({ type: 'assistant', message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: out } }, timestamp: iso(Date.now()), ...extra }) + '\n';
  fs.appendFileSync(main, line('msg_LIVE', 5));
  fs.appendFileSync(main, '{"type":"assistant","message":{"id":"msg_PART');          // half-written line waits
  const sub = path.join(fx.projects, '-Users-x-Documents-AI-Team', 's-main', 'subagents', 'agent-a333.jsonl');
  fs.writeFileSync(sub, line('msg_NEW', 9));
  const until = async pred => { for (let i = 0; i < 100 && !pred(); i++) await new Promise(r => setTimeout(r, 20)); };
  await until(() => got.some(r => r.id === 'msg_NEW') && got.some(r => r.id === 'msg_LIVE'));
  fs.appendFileSync(main, '","model":"claude-haiku-5-5","usage":{"output_tokens":3}},"timestamp":"' + iso(Date.now()) + '"}\n');
  await until(() => got.some(r => r.id === 'msg_PART'));
  u.stop();
  assert.equal(got.find(r => r.id === 'msg_NEW').aid, 'a333');
  assert.equal(got.find(r => r.id === 'msg_PART').family, 'haiku', 'partial line completed later');
  assert.equal(got.filter(r => r.id === 'msg_LIVE').length, 1);
  assert.equal(got.some(r => r.id === 'msg_A'), false, 'initial records are not re-emitted');
});

test('compact: > max records are aggregated per minute bucket, totals preserved, recent kept raw', () => {
  const d0 = dayStart(), now = d0 + 20 * 3600000;
  const recs = Array.from({ length: 6000 }, (_, i) => ({ id: `m${i}`, ts: iso(d0 + i * 10000), proj: 'P', sid: 's', model: 'claude-opus-5-5',
    family: i % 2 ? 'opus' : 'haiku', in: 1, out: 2, cacheR: 3, cacheW: 4 }));
  recs.push({ id: 'recent', ts: iso(now - 1000), proj: 'P', sid: 's', model: 'm', family: 'opus', in: 1, out: 1, cacheR: 0, cacheW: 0 });
  const out = compact(recs, 5000, now);
  assert.ok(out.length <= 5000, String(out.length));
  assert.equal(out.reduce((s, r) => s + r.out, 0), 6000 * 2 + 1);
  assert.equal(out.reduce((s, r) => s + (r.n || 1), 0), 6001);
  assert.equal(out.at(-1).id, 'recent');
  assert.equal(out[0].agg, 1);
  assert.equal(compact(recs.slice(0, 10), 5000, now).length, 10);
});

// ---------- server ----------
function startServer(args) {
  const p = spawn(process.execPath, [SERVER, '--port', '0', '--logs', fs.mkdtempSync(path.join(tmp, 'logs-')), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((resolve, reject) => {
    let out = '';
    p.stdout.on('data', b => { out += b; const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) resolve(Number(m[1])); });
    p.on('exit', c => reject(new Error(`server exited ${c}: ${out}`)));
  });
}
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, res => {
      let body = ''; res.on('data', b => { body += b; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}
function stream(port, until, ms = 6000) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path: '/events' }, res => {
      let text = '';
      const t = setTimeout(() => { r.destroy(); reject(new Error(`timeout; got: ${text.slice(0, 500)}`)); }, ms);
      res.on('data', b => { text += b; if (until(text)) { clearTimeout(t); r.destroy(); resolve(text); } });
    });
    r.on('error', e => { if (e.code !== 'ECONNRESET') reject(e); });
  });
}
const frames = (text, name) => text.split('\n\n').filter(f => f.includes(`event: ${name}\n`)).map(f => JSON.parse(f.split('\n').find(l => l.startsWith('data: ')).slice(6)));

test('server: usage-batch before ready, live usage events, ready fields, /building.json and /pricing.json', async () => {
  const fx = makeFixture();
  const port = await startServer(['--projects', fx.projects, '--config', fx.config, '--redact']);
  const text = await stream(port, t => t.includes('event: ready'));
  const batch = frames(text, 'usage-batch').flat();
  const [ready] = frames(text, 'ready');
  assert.ok(text.indexOf('event: usage-batch') < text.indexOf('event: ready'));
  assert.equal(batch.length, 9);
  assert.equal(batch.find(r => r.id === 'msg_A').usd, 0.004503);
  assert.equal(JSON.stringify(batch).includes('/Users/x'), false, 'no paths in usage records');
  assert.deepEqual([ready.usage, ready.usageFiles, ready.usageCount, ready.hasPricing], [true, 5, 9, true]);
  assert.equal(ready.building.floors['shop-backend-app'].floor, 1);
  const b = await get(port, '/building.json');
  assert.equal(b.status, 200); assert.equal(JSON.parse(b.body).ceo, '대표');
  assert.equal(JSON.parse((await get(port, '/pricing.json')).body).fable.out, 2);
  assert.equal((await get(port, '/building.json', { Origin: 'http://evil.com' })).status, 403);
  assert.equal((await get(port, '/building.json', { Host: 'evil.com' })).status, 421);

  const live = stream(port, t => t.includes('msg_LIVE2'), 8000);
  setTimeout(() => fs.appendFileSync(path.join(fx.projects, '-Users-x-IdeaProjects-shop-backend-app', 's-shop.jsonl'),
    JSON.stringify({ type: 'assistant', message: { id: 'msg_LIVE2', model: 'claude-opus-5-5', usage: { input_tokens: 1, output_tokens: 2 } }, timestamp: iso(Date.now()), cwd: '/Users/x/IdeaProjects/shop-backend-app' }) + '\n'), 500);
  const ev = frames(await live, 'usage').find(r => r.id === 'msg_LIVE2');
  assert.deepEqual([ev.proj, ev.family, ev.out], ['shop-backend-app', 'opus', 2]);
});

test('server: no pricing/building files -> no usd, building null, {} endpoints; --no-usage sends no usage', async () => {
  const fx = makeFixture();
  const empty = fs.mkdtempSync(path.join(tmp, 'cfg-'));
  const port = await startServer(['--projects', fx.projects, '--config', empty]);
  const text = await stream(port, t => t.includes('event: ready'));
  const [ready] = frames(text, 'ready');
  assert.equal(frames(text, 'usage-batch').flat().some(r => 'usd' in r), false);
  assert.deepEqual([ready.hasPricing, ready.building, ready.usageCount], [false, null, 9]);
  assert.equal((await get(port, '/building.json')).body, '{}');
  assert.equal((await get(port, '/pricing.json')).body, '{}');
  const p2 = await startServer(['--projects', fx.projects, '--config', empty, '--no-usage']);
  const t2 = await stream(p2, t => t.includes('event: ready'));
  assert.equal(t2.includes('usage-batch'), false);
  assert.deepEqual([frames(t2, 'ready')[0].usage, frames(t2, 'ready')[0].usageFiles], [false, 0]);
});

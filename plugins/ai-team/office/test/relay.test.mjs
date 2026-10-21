// 대표실 relay: unit tests for relay.mjs, live-server tests for /relay/*, and pipe tests for hooks/ceo-relay.sh.
import './home.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Relay, parseWait, classifyInput, validateDecision, hookOutput, targetOf, cleanText, WAIT_DEFAULT, WAIT_MAX,
  checkCaller, parseLsof, fakeAncestryRunner } from '../relay.mjs';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const HOOK = fileURLToPath(new URL('../hooks/ceo-relay.sh', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-relay-'));
const procs = [];
after(() => { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const SID = '0f1e2d3c-aaaa-bbbb-cccc-000000000001';
const permInput = (o = {}) => ({ session_id: SID, transcript_path: '/x.jsonl', cwd: `${os.homedir()}/proj/demo`, permission_mode: 'default',
  hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf node_modules', description: 'Remove node_modules' },
  permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf node_modules' }], behavior: 'allow', destination: 'localSettings' }], ...o });
const QUESTIONS = [
  { question: 'Which framework?', header: 'Framework', options: [{ label: 'React', description: 'Component library' }, { label: 'Vue', description: 'Progressive framework' }], multiSelect: false },
  { question: 'Which extras?', header: 'Extras', options: [{ label: 'ESLint', description: '' }, { label: 'Prettier', description: '' }], multiSelect: true },
];
const askInput = (o = {}) => ({ session_id: SID, cwd: '/w/demo', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion',
  tool_input: { questions: QUESTIONS }, tool_use_id: 'toolu_01ASK', ...o });

// ---------- unit ----------
test('parseWait clamps; cleanText strips control chars and caps', () => {
  assert.equal(parseWait(null), WAIT_DEFAULT); assert.equal(parseWait('abc'), WAIT_DEFAULT);
  assert.equal(parseWait('1500'), 1500); assert.equal(parseWait('9999999'), WAIT_MAX); assert.equal(parseWait('5'), 100);
  assert.equal(cleanText('a\u0007b\n\nc d', 500), 'a b c d');
  assert.equal(cleanText('x'.repeat(600), 500).length, 500);
});

test('classifyInput accepts only PermissionRequest and PreToolUse(AskUserQuestion)', () => {
  assert.equal(classifyInput(permInput()).kind, 'permission');
  assert.equal(classifyInput(askInput()).kind, 'question');
  for (const bad of [null, [], {}, permInput({ session_id: 'bad sid!' }), permInput({ tool_name: '' }), permInput({ tool_input: [] }),
    { ...askInput(), hook_event_name: 'PostToolUse' }, permInput({ hook_event_name: 'PreToolUse' }),
    askInput({ tool_input: { questions: [] } }), askInput({ tool_input: { questions: [{ question: 'a' }, { question: 'a' }] } })])
    assert.ok(classifyInput(bad).error, JSON.stringify(bad).slice(0, 80));
});

test('validateDecision: permission and question shapes', () => {
  const perm = { kind: 'permission' }, q = { kind: 'question', questions: QUESTIONS };
  assert.deepEqual(validateDecision(perm, { behavior: 'allow' }).value, { behavior: 'allow' });
  assert.deepEqual(validateDecision(perm, { behavior: 'deny', message: 'no\nthanks\u0000' }).value, { behavior: 'deny', message: 'no thanks' });
  assert.equal(validateDecision(perm, { behavior: 'deny', message: 'x'.repeat(900) }).value.message.length, 500);
  for (const bad of [null, [], {}, { behavior: 'ask' }, { behavior: 'allow', message: 'm' }, { behavior: 'deny', message: 5 },
    { behavior: 'allow', updatedInput: { command: 'evil' } }, { behavior: 'allow', updatedPermissions: [] }, { behavior: 'deny', interrupt: true }])
    assert.ok(validateDecision(perm, bad).error, JSON.stringify(bad));
  assert.deepEqual(validateDecision(q, { answers: { 'Which framework?': 'React', 'Which extras?': ['ESLint', 'Prettier'] } }).value,
    { answers: { 'Which framework?': 'React', 'Which extras?': 'ESLint, Prettier' } });
  assert.deepEqual(validateDecision(q, { answers: { 'Which framework?': 'Svelte (other)', 'Which extras?': 'ESLint' } }).value.answers['Which framework?'], 'Svelte (other)');
  for (const bad of [{}, { answers: [] }, { answers: { 'Which framework?': 'React' } }, { answers: { 'Which framework?': ['React'], 'Which extras?': 'x' } },
    { answers: { 'Which framework?': 'React', 'Which extras?': 'x', other: 'y' } }, { answers: { 'Which framework?': '', 'Which extras?': 'x' } },
    { answers: { 'Which framework?': 3, 'Which extras?': 'x' } }, { answers: { 'Which framework?': 'React', 'Which extras?': [] } }, { answers: {}, behavior: 'allow' }])
    assert.ok(validateDecision(q, bad).error, JSON.stringify(bad));
});

test('hookOutput matches the documented hook JSON shapes', () => {
  assert.deepEqual(hookOutput('permission', {}, null), {});
  assert.deepEqual(hookOutput('permission', { command: 'x' }, { behavior: 'allow' }),
    { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(hookOutput('permission', {}, { behavior: 'deny', message: 'why' }),
    { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'why' } } });
  assert.deepEqual(hookOutput('question', { questions: QUESTIONS }, { answers: { 'Which framework?': 'React' } }),
    { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
      updatedInput: { questions: QUESTIONS, answers: { 'Which framework?': 'React' } } } });
});

test('targetOf mirrors office-events.sh target', () => {
  assert.equal(targetOf({ command: 'ls', description: 'd' }), 'ls');
  assert.equal(targetOf({ file_path: '/a', command: 'x' }), '/a');
  assert.equal(targetOf({ command: 'é'.repeat(130) }), 'é'.repeat(120) + '…');
  assert.equal(targetOf({ questions: [] }), null);
});

test('Relay: one answer wins, timeout, withdraw, terminal resolution rules, decision log', async () => {
  const frames = [], logFile = path.join(tmp, 'unit-decisions.jsonl');
  const r = new Relay({ broadcast: o => frames.push(o), logFile });
  const a = r.ask(permInput(), 5000);
  assert.equal(frames[0].type, 'ask'); assert.equal(frames[0].item.target, 'rm -rf node_modules');
  assert.equal(r.answer(a.id, { behavior: 'allow' }).status, 200);
  assert.deepEqual(await a.wait, { decision: { behavior: 'allow' }, by: 'dashboard' });
  assert.equal(r.answer(a.id, { behavior: 'deny' }).status, 409, 'second answer loses');
  assert.equal(r.answer('nope', { behavior: 'deny' }).status, 404);

  const t = r.ask(permInput(), 100);
  assert.deepEqual(await t.wait, { decision: null, by: 'terminal' });
  assert.deepEqual(frames.at(-1), { type: 'resolved', id: t.id, by: 'terminal', reason: 'timeout' });
  assert.equal(r.answer(t.id, { behavior: 'allow' }).status, 409, 'too late after timeout');

  const w = r.ask(permInput(), 5000); r.withdraw(w.id);
  assert.deepEqual(frames.at(-1), { type: 'withdrawn', id: w.id });

  const ts = new Date().toISOString();
  const p = r.ask(permInput(), 5000), sub = r.ask(permInput({ agent_id: 'agent1' }), 5000), q = r.ask(askInput(), 5000);
  r.observe({ ts, ev: 'PostToolUse', sid: 'other', tool: 'Bash', target: 'rm -rf node_modules' });
  r.observe({ ts, ev: 'PostToolUse', sid: SID, tool: 'Bash', target: 'ls' });                       // a different Bash call
  r.observe({ ts, ev: 'PostToolUse', sid: SID, tool: 'AskUserQuestion', tuid: 'toolu_OTHER' });
  r.observe({ ts: '2000-01-01T00:00:00Z', ev: 'UserPromptSubmit', sid: SID });                       // stale line
  assert.equal(r.pending.size, 3, 'none of those match');
  r.observe({ ts, ev: 'PostToolUse', sid: SID, tool: 'Bash', target: 'rm -rf node_modules' });       // main agent's call ran
  assert.deepEqual(await p.wait, { decision: null, by: 'terminal' });
  assert.equal(r.pending.size, 2, 'subagent item untouched');
  r.observe({ ts, ev: 'PostToolUse', sid: SID, tool: 'AskUserQuestion', tuid: 'toolu_01ASK' });
  assert.deepEqual(await q.wait, { decision: null, by: 'terminal' });
  r.observe({ ts, ev: 'SubagentStop', sid: SID, aid: 'agent1' });
  assert.deepEqual(await sub.wait, { decision: null, by: 'terminal' });
  assert.equal(r.pending.size, 0);
  const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(l => l.by), ['dashboard', 'terminal', 'withdrawn', 'terminal', 'terminal', 'terminal']);
  assert.deepEqual(Object.keys(lines[0]).slice(0, 7), ['ts', 'id', 'sid', 'tool', 'kind', 'by', 'decision']);
  assert.deepEqual(lines[0].decision, { behavior: 'allow' });
  assert.equal(r.ask({ ...permInput(), hook_event_name: 'Stop' }).status, 400);
});

test('Relay.observe: ts >= floor(createdAt), tuid when both have one, else equal NON-null target', async () => {
  const r = new Relay();
  const created = Date.now(), floor = Math.floor(created / 1000) * 1000;
  const nt = r.ask(permInput({ tool_name: 'WebSearch', tool_input: {} }), 5000);          // target null
  const b = r.ask(permInput(), 5000);
  r.observe({ ts: new Date(floor).toISOString(), ev: 'PostToolUse', sid: SID, tool: 'WebSearch' });
  r.observe({ ts: new Date(floor).toISOString(), ev: 'PostToolUse', sid: SID, tool: 'WebSearch', target: null });
  r.observe({ ts: new Date(floor - 1000).toISOString(), ev: 'PostToolUse', sid: SID, tool: 'Bash', target: 'rm -rf node_modules' });
  r.observe({ ts: 'garbage', ev: 'UserPromptSubmit', sid: SID });
  assert.equal(r.pending.size, 2, 'null target, an older second and a bad ts never match');
  const t = r.ask(permInput({ tool_use_id: 'toolu_B' }), 5000);
  r.observe({ ts: new Date(floor).toISOString(), ev: 'PostToolUse', sid: SID, tool: 'Bash', tuid: 'toolu_C', target: 'rm -rf node_modules' });
  assert.ok(r.pending.has(t.id), 'both tuids present and different: same target does not match');
  r.observe({ ts: new Date(floor).toISOString(), ev: 'PostToolUse', sid: SID, tool: 'Bash', target: 'rm -rf node_modules' });
  assert.equal((await b.wait).by, 'terminal');
  r.releaseAll();
  assert.deepEqual(await nt.wait, { decision: null, by: 'no-viewer' });
});

test('Relay.answer: 410 when the hook connection is gone (alive() false, or already withdrawn)', async () => {
  const frames = [];
  const r = new Relay({ broadcast: o => frames.push(o) });
  const a = r.ask(permInput(), 5000, { alive: () => false });
  const res = r.answer(a.id, { behavior: 'allow' });
  assert.equal(res.status, 410); assert.match(res.error, /hook that asked is gone/);
  assert.deepEqual(await a.wait, { decision: null, by: 'withdrawn' }, 'no decision is delivered');
  assert.deepEqual(frames.at(-1), { type: 'withdrawn', id: a.id });
  assert.equal(r.answer(a.id, { behavior: 'allow' }).status, 410);
  const b = r.ask(permInput(), 5000, { alive: () => false });
  assert.equal(r.answer(b.id, { behavior: 'maybe' }).status, 400, 'validation first');
});

// ---------- live server ----------
// The caller-process check would see THIS test process (often itself under a Claude Code session) as the caller, so
// live servers get a fake process tree: a browser-like one by default, a Claude Code one where a test says so.
const BROWSER_TREE = 'Google Chrome,launchd', AGENT_TREE = 'curl,zsh,claude,zsh,Terminal';
/** port -> () => the server's stdout so far (its log lines). */
const serverOut = new Map();
function startServer(args, tree = BROWSER_TREE) {
  const p = spawn(process.execPath, [SERVER, '--port', '0', '--no-usage', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { OFFICE_VIEWER_GRACE_MS: '300', ...process.env, OFFICE_TEST_ANCESTRY: tree } });
  procs.push(p);
  return new Promise((resolve, reject) => {
    let out = '';
    p.stdout.on('data', b => { out += b; const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(out); if (m) { serverOut.set(Number(m[1]), () => out); resolve(Number(m[1])); } });
    p.on('exit', c => reject(new Error(`server exited ${c}: ${out}`)));
  });
}
function call(port, { method = 'GET', path: p = '/', body, headers = {}, onReq } = {}) {
  const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: data === undefined ? headers : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => { let json; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: b, json }); });
    });
    r.on('error', reject);
    if (onReq) onReq(r);
    r.end(data);
  });
}
/** A dashboard: SSE connection collecting `event: ceo` payloads. Sends a Referer to this server like a browser's
 *  EventSource does (that is what makes it count as a viewer); pass headers = {} for a bare (curl-like) client. */
function viewer(port, headers = { Referer: `http://127.0.0.1:${port}/` }, evPath = '/events') {
  const ceo = [], waiters = [];
  let buf = '';
  const check = () => { for (const w of [...waiters]) { const hit = ceo.find(w.pred); if (hit) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.t); w.resolve(hit); } } };
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: evPath, headers }, res => {
      v.raw = '';
      res.on('data', b => { v.raw += b; });
      res.on('data', b => {
        buf += b;
        let k;
        while ((k = buf.indexOf('\n\n')) >= 0) {
          const f = buf.slice(0, k); buf = buf.slice(k + 2);
          if (f.startsWith('event: ceo\n')) ceo.push(JSON.parse(f.split('\n')[1].slice(6)));
          if (f.startsWith('event: ready')) resolve(v);
        }
        check();
      });
    });
    r.on('error', () => {});
    const v = { ceo, close: () => r.destroy(),
      waitFor: (pred, ms = 4000) => new Promise((res, rej) => {
        const w = { pred, resolve: res, t: setTimeout(() => rej(new Error(`no ceo frame; got ${JSON.stringify(ceo)}`)), ms) };
        waiters.push(w); check();
      }) };
  });
}
/** The viewer token, read the way the page gets it: from the <meta> in the served index.html. */
const tokens = new Map();
async function tokenOf(port) {
  if (!tokens.has(port)) tokens.set(port, /<meta name="office-token" content="([0-9a-f]{64})">/.exec((await call(port, { path: '/' })).body)[1]);
  return tokens.get(port);
}
/** Headers a dashboard page sends: its own Origin + the token. */
const dash = async port => ({ Origin: `http://127.0.0.1:${port}`, 'X-Office-Token': await tokenOf(port) });
const pendingList = async port => call(port, { path: '/relay/pending', headers: await dash(port) });
const ask = (port, input, waitMs, extra = {}) => call(port, { method: 'POST', path: `/relay/ask?waitMs=${waitMs}`, body: input, ...extra });
const answer = async (port, id, decision, headers) => call(port, { method: 'POST', path: '/relay/answer', body: { id, decision }, headers: headers ?? await dash(port) });
const release = async (port, id, headers) => call(port, { method: 'POST', path: '/relay/release', body: { id }, headers: headers ?? await dash(port) });

test('live: no viewer -> immediate null; long-poll resolves on answer; validation; pending list; one answer wins', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'live-'));
  const port = await startServer(['--logs', logs]);
  const t0 = Date.now();
  const early = await ask(port, permInput(), 5000);
  assert.deepEqual(early.json, { id: null, decision: null, reason: 'no-viewer' }); assert.ok(Date.now() - t0 < 1000);

  const v = await viewer(port);
  assert.deepEqual(v.ceo[0], { type: 'snapshot', items: [] });
  const pending = ask(port, permInput(), 5000);
  const { item } = await v.waitFor(f => f.type === 'ask');
  assert.equal(item.kind, 'permission'); assert.equal(item.tool, 'Bash'); assert.equal(item.proj, 'demo');
  assert.equal(item.input.command, 'rm -rf node_modules'); assert.equal(item.expiresAt - item.createdAt, 5000);
  assert.deepEqual((await pendingList(port)).json.map(x => x.id), [item.id]);

  for (const [bad, code] of [[{ behavior: 'maybe' }, 400], [{ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions' }] }, 400]])
    assert.equal((await answer(port, item.id, bad)).status, code);
  assert.equal((await answer(port, 'no-such-id', { behavior: 'allow' })).status, 404);
  assert.equal((await answer(port, item.id, { behavior: 'allow' }, { Origin: 'http://evil.com' })).status, 403);
  assert.equal((await call(port, { method: 'POST', path: '/relay/answer', body: JSON.stringify({ id: item.id, decision: { behavior: 'allow' } }), headers: { ...(await dash(port)), 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await answer(port, item.id, { behavior: 'allow' }, { Host: 'evil.com' })).status, 421);
  assert.equal((await call(port, { path: '/relay/answer' })).status, 405);

  const ok = await answer(port, item.id, { behavior: 'deny', message: 'Not now\nplease' });
  assert.equal(ok.status, 200);
  assert.equal((await answer(port, item.id, { behavior: 'allow' })).status, 409, 'only one answer wins');
  assert.deepEqual((await pending).json, { id: item.id, kind: 'permission', decision: { behavior: 'deny', message: 'Not now please' }, by: 'dashboard' });
  assert.deepEqual(await v.waitFor(f => f.type === 'answered'), { type: 'answered', id: item.id, by: 'dashboard' });
  const logLine = JSON.parse(fs.readFileSync(path.join(logs, 'ceo-decisions.jsonl'), 'utf8').trim());
  assert.equal(logLine.by, 'dashboard'); assert.equal(logLine.sid, SID); assert.equal(logLine.decision.behavior, 'deny');
  assert.equal((await ask(port, { hook_event_name: 'Stop', session_id: SID }, 1000)).status, 400);
  assert.equal((await ask(port, '{nope', 1000)).status, 400);
  v.close();
});

test('viewer rule: bare SSE client is not a dashboard; Referer/Origin of this server is; last viewer closing releases pending', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'view-'));
  const port = await startServer(['--logs', logs]);
  const bare = await viewer(port, {});
  const other = await viewer(port, { Referer: `http://127.0.0.1:${port + 1}/` });
  const t0 = Date.now();
  assert.deepEqual((await ask(port, permInput(), 5000)).json, { id: null, decision: null, reason: 'no-viewer' });
  assert.ok(Date.now() - t0 < 1000);
  assert.deepEqual([JSON.parse((await call(port, { path: '/healthz' })).body).clients, JSON.parse((await call(port, { path: '/healthz' })).body).viewers], [2, 0]);

  const v1 = await viewer(port), v2 = await viewer(port, { Origin: `http://localhost:${port}` });
  const pending = ask(port, permInput(), 5000);
  const { item } = await bare.waitFor(f => f.type === 'ask');
  v1.close();
  await new Promise(r => setTimeout(r, 200));
  assert.equal((await pendingList(port)).json.length, 1, 'one viewer still open');
  v2.close();
  assert.deepEqual((await pending).json, { id: item.id, kind: 'permission', decision: null, by: 'no-viewer' });
  assert.deepEqual(await bare.waitFor(f => f.type === 'resolved'), { type: 'resolved', id: item.id, by: 'no-viewer', reason: 'no-viewer' });
  assert.deepEqual((await pendingList(port)).json, []);
  bare.close(); other.close();
});

test('live: timeout -> null; hook hang-up -> withdrawn; office-events line -> resolved by terminal; /relay/hook', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'race-'));
  const port = await startServer(['--logs', logs]);
  const v = await viewer(port);

  const t = await ask(port, permInput(), 300);
  assert.equal(t.json.decision, null); assert.equal(t.json.by, 'terminal');
  assert.equal((await v.waitFor(f => f.type === 'resolved' && f.id === t.json.id)).reason, 'timeout');

  let reqObj;
  const gone = ask(port, permInput(), 5000, { onReq: r => { reqObj = r; } }).catch(e => e.code);
  const a = await v.waitFor(f => f.type === 'ask' && !v.ceo.some(g => g.id === f.item.id && g.type !== 'ask'));
  reqObj.destroy();                                                     // hook killed
  assert.deepEqual(await v.waitFor(f => f.type === 'withdrawn'), { type: 'withdrawn', id: a.item.id });
  const late = await answer(port, a.item.id, { behavior: 'allow' });
  assert.equal(late.status, 410); assert.match(late.json.error, /gone/);
  await gone;
  assert.deepEqual((await pendingList(port)).json, []);

  // Terminal wins: the tool ran (PostToolUse logged by office-events.sh) while the dashboard was still open.
  const raced = ask(port, permInput(), 5000);
  const r = await v.waitFor(f => f.type === 'ask' && !v.ceo.some(g => g.id === f.item.id && g.type !== 'ask'));
  fs.appendFileSync(path.join(logs, 'office-events.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ev: 'PostToolUse', sid: SID,
    proj: 'demo', tool: 'Bash', tuid: 'toolu_X', target: 'rm -rf node_modules' }) + '\n');
  assert.deepEqual(await v.waitFor(f => f.type === 'resolved' && f.id === r.item.id, 8000), { type: 'resolved', id: r.item.id, by: 'terminal', reason: 'PostToolUse' });
  assert.equal((await raced).json.decision, null);
  assert.equal((await answer(port, r.item.id, { behavior: 'allow' })).status, 409, 'dashboard too late');

  // http hook type: same long-poll, body is the final hook JSON ({} = no decision).
  const hook = call(port, { method: 'POST', path: '/relay/hook?waitMs=5000', body: askInput() });
  const qa = await v.waitFor(f => f.type === 'ask' && f.item.kind === 'question');
  assert.deepEqual(qa.item.questions.map(q => q.question), ['Which framework?', 'Which extras?']);
  assert.equal((await answer(port, qa.item.id, { answers: { 'Which framework?': 'React', 'Which extras?': ['ESLint', 'Prettier'] } })).status, 200);
  assert.deepEqual((await hook).json, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { questions: QUESTIONS, answers: { 'Which framework?': 'React', 'Which extras?': 'ESLint, Prettier' } } } });
  assert.deepEqual((await call(port, { method: 'POST', path: '/relay/hook?waitMs=200', body: permInput() })).json, {});
  v.close();
});

test('live --redact: item has no cwd/input, Bash target masked, decision log keeps no message', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'red-'));
  const port = await startServer(['--logs', logs, '--redact']);
  const v = await viewer(port);
  const p = ask(port, permInput({ tool_input: { command: 'API_KEY=hunter2 curl https://h/x?k=tok3n' } }), 5000);
  const { item } = await v.waitFor(f => f.type === 'ask');
  assert.equal(item.target, 'API_KEY=*** ***'); assert.deepEqual(item.input, {}); assert.equal('cwd' in item, false);
  assert.equal(JSON.stringify(v.ceo).includes('hunter2'), false);
  await answer(port, item.id, { behavior: 'deny', message: 'secret reason' });
  assert.equal((await p).json.decision.message, 'secret reason', 'Claude still gets the reason');
  const log = fs.readFileSync(path.join(logs, 'ceo-decisions.jsonl'), 'utf8');
  assert.equal(log.includes('secret reason'), false); assert.deepEqual(JSON.parse(log).decision, { behavior: 'deny' });
  v.close();
});

// ---------- hooks/ceo-relay.sh pipe tests ----------
function runHook(input, env) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn('bash', [HOOK], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', b => { out += b; }); p.stderr.on('data', b => { err += b; });
    p.on('close', code => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}
const curlAnswer = async (port, id, decision) => { const h = await dash(port); return new Promise((resolve, reject) => execFile('curl', ['-s', '-H', 'Content-Type: application/json',
  '-H', `Origin: ${h.Origin}`, '-H', `X-Office-Token: ${h['X-Office-Token']}`,
  '--data-binary', JSON.stringify({ id, decision }), `http://127.0.0.1:${port}/relay/answer`], (e, out) => (e ? reject(e) : resolve(JSON.parse(out))))); };
/** curl with NO Origin and no token: what an agent's Bash would naturally send. */
const curlBare = (port, p, body) => new Promise((resolve, reject) => execFile('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '-H', 'Content-Type: application/json',
  '--data-binary', JSON.stringify(body), `http://127.0.0.1:${port}${p}`], (e, out) => (e ? reject(e) : resolve(Number(out)))));
export const pipeLog = [];

test('ceo-relay.sh: answered via curl -> exact hook JSON; timeout / server down / disabled -> nothing', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'pipe-'));
  const port = await startServer(['--logs', logs]);
  const v = await viewer(port);
  const env = { OFFICE_PORT: String(port), OFFICE_RELAY_WAIT_MS: '1500' };

  let run = runHook(permInput(), env);
  let f = await v.waitFor(x => x.type === 'ask' && !v.ceo.some(g => g.id === x.item.id && g.type !== 'ask'));
  assert.equal(await curlBare(port, '/relay/answer', { id: f.item.id, decision: { behavior: 'allow' } }), 403, 'origin-less curl can no longer approve');
  await curlAnswer(port, f.item.id, { behavior: 'allow' });
  let r = await run;
  pipeLog.push(['PermissionRequest allow', r.out.trim()]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });

  run = runHook(permInput(), env);
  f = await v.waitFor(x => x.type === 'ask' && !v.ceo.some(g => g.id === x.item.id && g.type !== 'ask'));
  await curlAnswer(port, f.item.id, { behavior: 'deny', message: 'Use npm ci instead' });
  r = await run;
  pipeLog.push(['PermissionRequest deny', r.out.trim()]);
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Use npm ci instead' } } });

  run = runHook(askInput(), env);
  f = await v.waitFor(x => x.type === 'ask' && x.item.kind === 'question' && !v.ceo.some(g => g.id === x.item.id && g.type !== 'ask'));
  await curlAnswer(port, f.item.id, { answers: { 'Which framework?': 'React', 'Which extras?': ['ESLint'] } });
  r = await run;
  pipeLog.push(['PreToolUse AskUserQuestion', r.out.trim()]);
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { questions: QUESTIONS, answers: { 'Which framework?': 'React', 'Which extras?': 'ESLint' } } } });

  // OFFICE_RELAY_WAIT_MS parsing: leading zeros are decimal (never octal), > 7 digits -> default; curl gets wait/1000+5 s.
  for (const [val, want] of [['060000', 60000], ['0800', 800], ['12345678901234567890', 170000]]) {
    const hr = runHook(permInput(), { OFFICE_PORT: String(port), OFFICE_RELAY_WAIT_MS: val, OFFICE_RELAY_DEBUG: '1' });
    const g = await v.waitFor(x => x.type === 'ask' && !v.ceo.some(y => y.id === x.item.id && y.type !== 'ask'));
    assert.equal(g.item.expiresAt - g.item.createdAt, want, val);
    if (want > 1000) await curlAnswer(port, g.item.id, { behavior: 'allow' });
    const o = await hr;
    pipeLog.push([`WAIT_MS=${val}`, `${o.err.trim()} -> server wait ${g.item.expiresAt - g.item.createdAt}ms, stdout ${JSON.stringify(o.out.trim())} (${o.ms}ms)`]);
    assert.equal(o.code, 0);
    assert.match(o.err, new RegExp(`wait_ms=${want} max_time=${Math.floor(want / 1000) + 5}\\b`));
    if (want > 1000) assert.deepEqual(JSON.parse(o.out).hookSpecificOutput.decision, { behavior: 'allow' });
    else { assert.equal(o.out, ''); assert.ok(o.ms >= 700 && o.ms < 3000, `${o.ms}ms`); }
  }

  r = await runHook(permInput(), env);                                   // nobody answers
  pipeLog.push([`timeout (${r.ms}ms)`, JSON.stringify(r.out)]);
  assert.equal(r.code, 0); assert.equal(r.out, ''); assert.ok(r.ms >= 1400 && r.ms < 4000, `${r.ms}ms`);

  r = await runHook(permInput(), { OFFICE_PORT: '9', OFFICE_RELAY_WAIT_MS: '1500' });   // nothing listens on port 9
  pipeLog.push([`server down (${r.ms}ms)`, JSON.stringify(r.out)]);
  assert.equal(r.code, 0); assert.equal(r.out, ''); assert.ok(r.ms < 2500, `${r.ms}ms`);

  r = await runHook(permInput(), { ...env, OFFICE_RELAY_DISABLE: '1' });
  assert.equal(r.out, ''); assert.equal(r.code, 0);
  r = await runHook({ ...askInput(), tool_name: 'Bash' }, env);          // PreToolUse for other tools: never relayed
  assert.equal(r.out, ''); assert.ok(r.ms < 1000);
  r = await runHook('not json', env);
  assert.equal(r.out, ''); assert.equal(r.code, 0);
  v.close();
  if (process.env.PIPE_LOG) for (const [k, o] of pipeLog) console.log(`# ${k}: ${o}`);
});

test('돌려보내기: Relay.release ends the long-poll with no decision; 404/409/410; logged as released', async () => {
  const logFile = path.join(fs.mkdtempSync(path.join(tmp, 'rel-')), 'ceo-decisions.jsonl'), frames = [];
  const r = new Relay({ broadcast: f => frames.push(f), logFile });
  const a = r.ask(permInput(), 5000);
  assert.deepEqual(r.release(a.id), { status: 200, item: a.item });
  assert.deepEqual(await a.wait, { decision: null, by: 'dashboard' });
  assert.deepEqual(frames.at(-1), { type: 'resolved', id: a.id, by: 'dashboard', reason: 'released' });
  assert.ok(!frames.some(f => f.type === 'answered'), 'a release is never an answer');
  assert.equal(r.release(a.id).status, 409);
  assert.equal(r.answer(a.id, { behavior: 'allow' }).status, 409, 'no allow after a release');
  assert.equal(r.release('nope').status, 404);
  assert.equal(r.release(42).status, 400);
  const g = r.ask(permInput(), 5000, { alive: () => false });
  assert.equal(r.release(g.id).status, 410, 'hook gone');
  const line = JSON.parse(fs.readFileSync(logFile, 'utf8').trim().split('\n')[0]);
  assert.deepEqual([line.by, line.decision, line.reason], ['dashboard', null, 'released']);
});

test('ceo-relay.sh: /relay/release -> the hook prints nothing (no allow, no deny); origin checked', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'pipe-rel-'));
  const port = await startServer(['--logs', logs]);
  const v = await viewer(port);
  const env = { OFFICE_PORT: String(port), OFFICE_RELAY_WAIT_MS: '20000' };
  for (const input of [permInput(), askInput()]) {
    const run = runHook(input, env);
    const f = await v.waitFor(x => x.type === 'ask' && !v.ceo.some(g => g.id === x.item.id && g.type !== 'ask'));
    assert.equal((await release(port, f.item.id, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await release(port, f.item.id, {})).status, 403, 'no Origin');
    const rel = await release(port, f.item.id);
    assert.deepEqual([rel.status, rel.json], [200, { ok: true, id: f.item.id, released: true }]);
    const r = await run;
    assert.equal(r.code, 0); assert.equal(r.out, '', 'empty output -> the native terminal prompt takes over'); assert.ok(r.ms < 5000);
    assert.deepEqual(await v.waitFor(x => x.type === 'resolved' && x.id === f.item.id), { type: 'resolved', id: f.item.id, by: 'dashboard', reason: 'released' });
    assert.equal((await release(port, f.item.id)).status, 409);
  }
  assert.equal((await release(port, 'unknown')).status, 404);
  assert.equal((await call(port, { method: 'GET', path: '/relay/release' })).status, 405);
  const log = fs.readFileSync(path.join(logs, 'ceo-decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(log.length >= 2 && log.every(l => l.by === 'dashboard' && l.decision === null && l.reason === 'released'));
  v.close();
});

// ---------- self-approval guard: Origin + viewer token + caller-process check ----------
test('checkCaller: Claude Code in the ancestry -> agent; browser tree -> ok; tools missing / not macOS -> unchecked', async () => {
  assert.deepEqual(parseLsof('p10\ncnode\np20\nccurl\n'), [{ pid: 10, comm: 'node' }, { pid: 20, comm: 'curl' }]);
  const agent = await checkCaller(5555, { run: fakeAncestryRunner(['curl', 'zsh', 'claude', 'zsh', 'Terminal']), platform: 'darwin' });
  assert.equal(agent.verdict, 'agent'); assert.deepEqual(agent.chain.map(p => p.comm), ['curl', 'zsh', 'claude']);
  for (const tree of [['node', '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js'], ['/Users/x/.local/bin/claude'], ['node-claude']])
    assert.equal((await checkCaller(5555, { run: fakeAncestryRunner(tree), platform: 'darwin' })).verdict, 'agent', tree.join('<-'));
  const browser = await checkCaller(5555, { run: fakeAncestryRunner(['Google Chrome Helper', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']), platform: 'darwin' });
  assert.equal(browser.verdict, 'ok'); assert.equal(browser.chain.length, 2);
  assert.equal((await checkCaller(5555, { run: fakeAncestryRunner(['Safari']), platform: 'linux' })).verdict, 'unchecked');
  const enoent = async () => { throw Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' }); };
  assert.equal((await checkCaller(5555, { run: enoent, platform: 'darwin' })).verdict, 'unchecked');
  const self = async () => ({ code: 0, stdout: `p${process.pid}\ncnode\n` });                       // only the server itself
  assert.equal((await checkCaller(5555, { run: self, platform: 'darwin' })).verdict, 'unknown', 'caller gone -> refuse');
  const argv = [];
  await checkCaller(5555, { run: async (c, a) => { argv.push([c, ...a]); return { code: 1, stdout: '' }; }, platform: 'darwin' });
  assert.deepEqual(argv[0], ['lsof', '-nP', '-iTCP@127.0.0.1:5555', '-sTCP:ESTABLISHED', '-Fpc']);
});

test('live: answer/release/pending need own Origin + token; an agent process tree is refused even with both', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'guard-'));
  const port = await startServer(['--logs', logs]);
  const v = await viewer(port);
  const tok = await tokenOf(port);
  assert.equal(v.raw.includes(tok), false, 'the token is never on the SSE stream');
  const html = await call(port, { path: '/index.html' });
  assert.match(html.body, /<meta name="office-token" content="[0-9a-f]{64}">/);
  const p = ask(port, permInput(), 5000);
  const { item } = await v.waitFor(f => f.type === 'ask');
  const O = { Origin: `http://127.0.0.1:${port}` };
  for (const [h, why] of [[{}, 'no Origin, no token'], [{ 'X-Office-Token': tok }, 'no Origin'], [{ ...O }, 'no token'],
    [{ ...O, 'X-Office-Token': 'f'.repeat(64) }, 'wrong token'], [{ Origin: `http://127.0.0.1:${port + 1}`, 'X-Office-Token': tok }, 'other port'],
    [{ Referer: `http://127.0.0.1:${port}/`, 'X-Office-Token': tok }, 'Referer is not enough']]) {
    assert.equal((await answer(port, item.id, { behavior: 'allow' }, h)).status, 403, `answer: ${why}`);
    assert.equal((await release(port, item.id, h)).status, 403, `release: ${why}`);
    assert.equal((await call(port, { path: '/relay/pending', headers: h })).status, 403, `pending: ${why}`);
  }
  assert.equal(await curlBare(port, '/relay/release', { id: item.id }), 403);
  assert.equal((await pendingList(port)).json.length, 1, 'still pending after every refused call');
  assert.equal((await answer(port, item.id, { behavior: 'allow' })).status, 200, 'browser-like tree + Origin + token');
  assert.deepEqual((await p).json.decision, { behavior: 'allow' });
  v.close();

  const aport = await startServer(['--logs', fs.mkdtempSync(path.join(tmp, 'agent-'))], AGENT_TREE);
  const av = await viewer(aport);
  const ap = ask(aport, permInput(), 5000);
  const a = await av.waitFor(f => f.type === 'ask');
  const an = await answer(aport, a.item.id, { behavior: 'allow' });
  assert.deepEqual([an.status, an.json], [403, { error: 'agent processes cannot answer' }]);
  assert.equal((await release(aport, a.item.id)).status, 403, 'release: same rule');
  assert.equal((await pendingList(aport)).status, 200, 'listing is not a decision');
  assert.equal((await pendingList(aport)).json.length, 1, 'the request is untouched');
  av.close();
  assert.equal((await ap).json.decision, null, 'closing the dashboard releases it with no decision');
});

test('live: a hidden tab holds permissions but not questions; hiding releases questions, closing releases all', async () => {
  const port = await startServer(['--logs', fs.mkdtempSync(path.join(tmp, 'vis-'))]);
  const ref = { Referer: `http://127.0.0.1:${port}/` };
  const health = async () => JSON.parse((await call(port, { path: '/healthz' })).body);
  const setVis = async (vid, visible, headers) => call(port, { method: 'POST', path: '/viewer', body: { vid, visible }, headers: headers ?? await dash(port) });
  const bg = await viewer(port, ref, '/events?vid=tab-background-1&visible=0');      // opened already hidden
  assert.deepEqual([(await health()).viewers, (await health()).hiddenViewers], [0, 1]);
  assert.deepEqual((await ask(port, askInput(), 5000)).json, { id: null, decision: null, reason: 'no-viewer' }, 'a hidden tab holds no question');
  const held = ask(port, permInput(), 5000);              // the terminal prompt runs alongside: a background tab may hold it
  const { item: hItem } = await bg.waitFor(f => f.type === 'ask');
  assert.equal(hItem.kind, 'permission');
  assert.equal((await answer(port, hItem.id, { behavior: 'allow' }, await dash(port))).status, 200, 'answerable from the background tab');
  assert.equal((await held).json.decision.behavior, 'allow');

  const fg = await viewer(port, ref, '/events?vid=tab-foreground-1');
  assert.equal((await health()).viewers, 1);
  for (const [h, why] of [[{}, 'no Origin'], [{ Origin: `http://127.0.0.1:${port}`, 'X-Office-Token': 'nope' }, 'wrong token']])
    assert.equal((await setVis('tab-foreground-1', false, h)).status, 403, why);
  assert.equal((await setVis('no-such-tab-1', false)).status, 404);
  assert.equal((await setVis('tab-foreground-1', 'no')).status, 400);

  const p = ask(port, permInput(), 5000);
  const { item } = await fg.waitFor(f => f.type === 'ask');
  const q = ask(port, askInput(), 5000);
  const { item: qItem } = await fg.waitFor(f => f.type === 'ask' && f.item.kind === 'question');
  assert.equal((await setVis('tab-background-1', true)).status, 200);
  assert.equal((await setVis('tab-foreground-1', false)).json.viewers, 1, 'the other tab is visible now');
  assert.equal((await pendingList(port)).json.length, 2);
  assert.deepEqual((await setVis('tab-background-1', false)).json, { ok: true, visible: false, viewers: 0 });
  assert.deepEqual((await q).json, { id: qItem.id, kind: 'question', decision: null, by: 'no-viewer' }, 'the question goes back to the terminal');
  assert.equal((await pendingList(port)).json.length, 1, 'the permission stays answerable');
  assert.equal((await setVis('tab-foreground-1', true)).json.viewers, 1, 'coming back counts again');
  bg.close(); fg.close();
  assert.deepEqual((await p).json, { id: item.id, kind: 'permission', decision: null, by: 'no-viewer' }, 'no dashboard open at all: released');
});

test('live: the page and `ready` carry the same boot id (a page left open across a restart reloads for a new token)', async () => {
  const port = await startServer(['--logs', fs.mkdtempSync(path.join(tmp, 'boot-'))]);
  const meta = /<meta name="office-boot" content="([0-9a-f]{16})">/.exec((await call(port, { path: '/' })).body)?.[1];
  const v = await viewer(port);
  const ready = JSON.parse(/event: ready\ndata: (.*)\n/.exec(v.raw)[1]);
  assert.ok(meta); assert.equal(ready.boot, meta);
  assert.ok(!v.raw.includes(await tokenOf(port)), 'the token itself never goes on the stream');
  v.close();
});

test('live: a reload (tab closes, a new one connects within the grace) keeps pending items', async () => {
  const port = await startServer(['--logs', fs.mkdtempSync(path.join(tmp, 'grace-'))]);
  const v1 = await viewer(port);
  const p = ask(port, permInput(), 5000);
  const { item } = await v1.waitFor(f => f.type === 'ask');
  v1.close();
  const v2 = await viewer(port);                          // the reloaded page, well inside the 300ms test grace
  await new Promise(r => setTimeout(r, 500));
  assert.equal((await pendingList(port)).json.length, 1, 'still waiting after the grace');
  assert.equal((await answer(port, item.id, { behavior: 'allow' })).status, 200);
  assert.equal((await p).json.decision.behavior, 'allow');
  v2.close();
});

test('live: closing the only visible tab (hidden one remains) releases the question after the grace, keeps the permission', async () => {
  const port = await startServer(['--logs', fs.mkdtempSync(path.join(tmp, 'close-'))]);
  const ref = { Referer: `http://127.0.0.1:${port}/` };
  const bg = await viewer(port, ref, '/events?vid=tab-bg-close-1&visible=0');
  const fg = await viewer(port, ref, '/events?vid=tab-fg-close-1');
  const p = ask(port, permInput(), 5000);
  const { item } = await bg.waitFor(f => f.type === 'ask' && f.item.kind === 'permission');
  const q = ask(port, askInput(), 5000);
  const { item: qItem } = await bg.waitFor(f => f.type === 'ask' && f.item.kind === 'question');
  fg.close();
  assert.deepEqual((await q).json, { id: qItem.id, kind: 'question', decision: null, by: 'no-viewer' });
  assert.match(serverOut.get(port)(), /last visible dashboard closed \(background tabs remain\), released 1 pending/);
  assert.deepEqual((await pendingList(port)).json.map(x => x.id), [item.id], 'the permission still waits for the background tab');
  assert.equal((await answer(port, item.id, { behavior: 'deny' })).status, 200);
  assert.equal((await p).json.decision.behavior, 'deny');
  bg.close();
});

test('live: a request nobody can hold is logged once with the reason (control characters masked)', async () => {
  const port = await startServer(['--logs', fs.mkdtempSync(path.join(tmp, 'nolog-'))]);
  assert.equal((await ask(port, permInput({ tool_name: 'Bash\n\u001b[31mX' }), 2000)).json.reason, 'no-viewer');
  const bg = await viewer(port, { Referer: `http://127.0.0.1:${port}/` }, '/events?vid=tab-bg-log-1&visible=0');
  assert.equal((await ask(port, askInput(), 2000)).json.reason, 'no-viewer');
  const out = serverOut.get(port)();
  assert.match(out, /대표실: Bash\?\?\[31mX \(0f1e2d3c\) not relayed: no dashboard open/);
  assert.match(out, /대표실: AskUserQuestion \(0f1e2d3c\) not relayed: dashboard in the background/);
  assert.ok(!out.includes('\u001b'), 'no raw escape reaches the log');
  bg.close();
});

test('live: a dashboard answer becomes a RelayDecided event in the history (a reload does not bring the card back)', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'decided-'));
  const port = await startServer(['--logs', logs]);
  const v = await viewer(port);
  const p = ask(port, permInput(), 5000);
  const { item } = await v.waitFor(f => f.type === 'ask');
  assert.equal((await answer(port, item.id, { behavior: 'allow' })).status, 200);
  await p;
  const until = Date.now() + 3000;
  while (!v.raw.includes('"ev":"RelayDecided"') && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  const ev = JSON.parse(/data: (\{[^\n]*"ev":"RelayDecided"[^\n]*\})/.exec(v.raw)[1]);
  assert.deepEqual([ev.sid, ev.tool, ev.answer], [SID, 'Bash', 'allow']);
  v.close();
  const v2 = await viewer(port);                          // a reload replays it
  assert.ok(v2.raw.includes('"ev":"RelayDecided"'));
  v2.close();
});

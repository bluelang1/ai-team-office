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
import { QUESTION_WAIT_DEFAULT, STOP_WAIT_DEFAULT } from '../relay.mjs';
import { Relay, parseWait, classifyInput, validateDecision, hookOutput, targetOf, cleanText, WAIT_DEFAULT, WAIT_MAX,
  checkCaller, parseLsof, fakeAncestryRunner, cleanInstruction, INSTRUCT_MAX, INSTRUCT_CAP, STOP_WAIT_MAX } from '../relay.mjs';
import { testAncestry } from '../server.mjs';
import { reportAsks } from '../public/ceo.js';

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
  assert.deepEqual(r.ask({ ...permInput(), hook_event_name: 'Stop' }), { none: 'no-report' }, 'a Stop without a report is no decision, never held');
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
  const { startedAt, ...snap } = v.ceo[0];
  assert.deepEqual(snap, { type: 'snapshot', items: [], ends: [{ sid: SID, tool: 'Bash', kind: 'permission', reason: 'no-viewer', at: snap.ends[0].at }] },
    'the request nobody could hold is explained in the snapshot');
  assert.ok(Number.isFinite(startedAt));
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
  assert.deepEqual((await ask(port, { hook_event_name: 'Stop', session_id: SID }, 1000)).json, { id: null, decision: null, reason: 'no-report' }, 'Stop: no report -> no decision at once');
  assert.equal((await ask(port, { hook_event_name: 'SubagentStop', session_id: SID, last_assistant_message: '할까요?' }, 1000)).status, 400);
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
  for (const [val, want] of [['060000', 60000], ['0800', 800], ['12345678901234567890', 540000]]) {
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

// ---------- Stop relay (kind instruct, hooks/ceo-stop.sh): send the next instruction from the dashboard ----------
const STOP_HOOK = fileURLToPath(new URL('../hooks/ceo-stop.sh', import.meta.url));
const ASKING = '정리했어요.\n- 테스트 통과\n다음 결정: PR #23을 머지할지 정해 주세요.';
const stopInput = (o = {}) => ({ session_id: SID, transcript_path: '/x.jsonl', cwd: '/w/demo', permission_mode: 'default',
  hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: ASKING, ...o });
function runStop(input, env) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn('bash', [STOP_HOOK], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', b => { out += b; }); p.stderr.on('data', b => { err += b; });
    p.on('close', code => resolve({ code, out, err, ms: Date.now() - t0 }));
    p.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

test('instruct: classifyInput uses the shared reportAsks (one implementation); validateDecision cleans and bounds the text', async () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../relay.mjs', import.meta.url)), 'utf8');
  assert.match(src, /import \{ reportAsks \} from '\.\/public\/ceo\.js'/, 'relay.mjs imports the dashboard heuristic');
  assert.doesNotMatch(src, /할까요|정해\\s\*주세요|다음\\s\*결정/, 'no second copy of the wording rules in relay.mjs');
  for (const body of [ASKING, '배포할까요?', '끝났어요.', '다음 결정: 없음', '```\nok?\n```', 'https://x.test/search?'])
    assert.equal(classifyInput(stopInput({ last_assistant_message: body })).kind === 'instruct', reportAsks(body), JSON.stringify(body));
  assert.deepEqual(classifyInput(stopInput({ agent_id: 'a1' })), { none: 'subagent' });
  assert.deepEqual(classifyInput(stopInput({ last_assistant_message: '' })), { none: 'no-report' });
  assert.deepEqual(classifyInput(stopInput({ last_assistant_message: '다 했어요.' })), { none: 'report-does-not-ask' });
  assert.equal(classifyInput(stopInput({ stop_hook_active: true })).kind, 'instruct', 'a continuation may be held again (human-answered)');
  const it = { kind: 'instruct' };
  assert.deepEqual(validateDecision(it, { text: '  머지\r\n해\u0007 주세요\t' }), { value: { text: '머지\n해  주세요' } });
  assert.equal(cleanInstruction('a b\u0000c\r\nd'), 'a b c\nd');
  assert.deepEqual(validateDecision(it, { text: 'x'.repeat(INSTRUCT_MAX) }).value.text.length, INSTRUCT_MAX);
  for (const bad of [{ text: '' }, { text: ' \n\t ' }, { text: 'x'.repeat(INSTRUCT_MAX + 1) }, { text: 7 }, { text: ['a'] }, { text: 'ok', behavior: 'allow' }, {}, null, 'go'])
    assert.ok(validateDecision(it, bad).error, JSON.stringify(bad));
  assert.deepEqual(hookOutput('instruct', null, { text: '진행해 주세요' }), { decision: 'block', reason: '진행해 주세요' });
  assert.deepEqual(hookOutput('instruct', null, null), {});

  const logFile = path.join(fs.mkdtempSync(path.join(tmp, 'ins-')), 'ceo-decisions.jsonl');
  const r = new Relay({ logFile, redact: true });
  const a = r.ask(stopInput(), 5000);
  assert.deepEqual([a.item.kind, a.item.tool, a.item.asks, a.item.msg], ['instruct', 'Stop', true, undefined], '--redact: no report text on the item');
  const ts = new Date(a.item.createdAt + 1000).toISOString();
  r.observe({ ev: 'Stop', sid: SID, ts });
  assert.equal(r.pending.size, 1, 'its own Stop line does not resolve it');
  assert.equal(r.answer(a.id, { text: '머지해 주세요' }).status, 200);
  assert.deepEqual(await a.wait, { decision: { text: '머지해 주세요' }, by: 'dashboard' });
  assert.deepEqual(JSON.parse(fs.readFileSync(logFile, 'utf8').trim()).decision, { instructed: true }, '--redact log keeps no text');
  const b = new Relay().ask(stopInput(), 5000);
  assert.equal(b.item.msg, ASKING, 'the report rides on the item for display');
  const c = new Relay(); const ci = c.ask(stopInput(), 5000);
  c.observe({ ev: 'UserPromptSubmit', sid: SID, ts: new Date(ci.item.createdAt + 1000).toISOString() });
  assert.deepEqual(await ci.wait, { decision: null, by: 'terminal' }, 'a prompt typed in the terminal resolves it');
});

test('live instruct: needs a VISIBLE dashboard; answer validation + guards; release; RelayDecided "instructed"', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'ins-live-'));
  const port = await startServer(['--logs', logs]);
  assert.deepEqual((await ask(port, stopInput(), 5000)).json, { id: null, decision: null, reason: 'no-viewer' }, 'no dashboard: never held');
  const v = await viewer(port);
  assert.deepEqual((await ask(port, stopInput({ last_assistant_message: '끝났어요.' }), 5000)).json, { id: null, decision: null, reason: 'report-does-not-ask' });
  const p = ask(port, stopInput(), 5000);
  const { item } = await v.waitFor(f => f.type === 'ask' && f.item.kind === 'instruct');
  assert.deepEqual([item.tool, item.asks, item.msg], ['Stop', true, ASKING]);
  for (const bad of [{ text: '' }, { text: 'x'.repeat(2001) }, { text: 3 }, { text: 'ok', behavior: 'allow' }, { behavior: 'allow' }, { answers: { a: 'b' } }])
    assert.equal((await answer(port, item.id, bad)).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal((await answer(port, item.id, { text: 'go' }, { Origin: 'http://evil.com' })).status, 403);
  assert.equal((await answer(port, item.id, { text: 'go' }, { Origin: `http://127.0.0.1:${port}` })).status, 403, 'no viewer token');
  const ok = await answer(port, item.id, { text: '머지해\r\n주세요' });
  assert.deepEqual([ok.status, ok.json.decision], [200, { text: '머지해\n주세요' }]);
  assert.equal((await answer(port, item.id, { text: 'again' })).status, 409, 'stale: one answer wins');
  assert.deepEqual((await p).json, { id: item.id, kind: 'instruct', decision: { text: '머지해\n주세요' }, by: 'dashboard' });
  const until = Date.now() + 3000;
  while (!v.raw.includes('"answer":"instructed"') && Date.now() < until) await new Promise(r => setTimeout(r, 50));
  assert.match(v.raw, /"ev":"RelayDecided"[^\n]*"answer":"instructed"/, 'replayed as RelayDecided');
  const p2 = ask(port, stopInput(), 5000);
  const f2 = await v.waitFor(f => f.type === 'ask' && f.item.kind === 'instruct' && f.item.id !== item.id);
  assert.equal((await release(port, f2.item.id)).status, 200);
  assert.deepEqual((await p2).json, { id: f2.item.id, kind: 'instruct', decision: null, by: 'dashboard' }, 'release = no decision');
  v.close();
  const agentPort = await startServer(['--logs', fs.mkdtempSync(path.join(tmp, 'ins-agent-'))], AGENT_TREE);
  const va = await viewer(agentPort);
  const p3 = ask(agentPort, stopInput(), 3000);
  const f3 = await va.waitFor(f => f.type === 'ask');
  assert.equal((await answer(agentPort, f3.item.id, { text: '진행해 주세요' })).status, 403, 'a Claude Code process tree cannot instruct itself');
  assert.equal((await p3).json.decision, null);
  va.close();
});

test('ceo-stop.sh: answer -> exact block JSON; no viewer / not asking / subagent / release / timeout / down / disabled -> nothing', async () => {
  const logs = fs.mkdtempSync(path.join(tmp, 'stop-pipe-'));
  const port = await startServer(['--logs', logs]);
  const env = { OFFICE_PORT: String(port), OFFICE_RELAY_STOP_WAIT_MS: '1500' };
  let r = await runStop(stopInput(), env);
  pipeLog.push([`Stop, no viewer (${r.ms}ms)`, JSON.stringify(r.out)]);
  assert.deepEqual([r.code, r.out], [0, '']); assert.ok(r.ms < 1500, `${r.ms}ms`);
  const v = await viewer(port);
  const fresh = x => x.type === 'ask' && x.item.kind === 'instruct' && !v.ceo.some(g => g.id === x.item.id && g.type !== 'ask');

  let run = runStop(stopInput(), env);
  let f = await v.waitFor(fresh);
  await curlAnswer(port, f.item.id, { text: '머지해 주세요' });
  r = await run;
  pipeLog.push(['Stop answered', r.out.trim()]);
  assert.equal(r.code, 0);
  assert.equal(r.out, '{"decision":"block","reason":"머지해 주세요"}\n', 'exactly the Stop block JSON, nothing else');

  run = runStop(stopInput({ stop_hook_active: true }), env);
  f = await v.waitFor(fresh);
  const evil = '"},"continue":false,"x":"\n두 번째 줄\u0007 \\u0000 `rm -rf` $(id)';
  await curlAnswer(port, f.item.id, { text: evil });
  r = await run;
  pipeLog.push(['Stop answered (quotes/newline/control)', r.out.trim()]);
  const j = JSON.parse(r.out);
  assert.deepEqual(Object.keys(j), ['decision', 'reason']); assert.equal(j.decision, 'block');
  assert.equal(j.reason, '"},"continue":false,"x":"\n두 번째 줄  \\u0000 `rm -rf` $(id)', 'quotes kept as text, \\n kept, BEL -> space');

  run = runStop(stopInput(), env);
  f = await v.waitFor(fresh);
  assert.equal((await release(port, f.item.id)).status, 200);
  r = await run;
  assert.deepEqual([r.code, r.out], [0, ''], '터미널에서 할게요 = nothing printed');

  r = await runStop(stopInput(), env);                                   // nobody answers
  pipeLog.push([`Stop timeout (${r.ms}ms)`, JSON.stringify(r.out)]);
  assert.deepEqual([r.code, r.out], [0, '']); assert.ok(r.ms >= 1400 && r.ms < 4000, `${r.ms}ms`);
  for (const [why, inp, e] of [['not asking', stopInput({ last_assistant_message: '다 했어요.' }), env], ['subagent', stopInput({ agent_id: 'a1', agent_type: 'lookup' }), env],
    ['SubagentStop', stopInput({ hook_event_name: 'SubagentStop' }), env], ['disabled', stopInput(), { ...env, OFFICE_RELAY_DISABLE: '1' }],
    ['server down', stopInput(), { OFFICE_PORT: '9', OFFICE_RELAY_STOP_WAIT_MS: '1500' }], ['not json', 'nope', env]]) {
    r = await runStop(inp, e);
    assert.deepEqual([r.code, r.out], [0, ''], why); assert.ok(r.ms < 2500, `${why} ${r.ms}ms`);
  }
  for (const [val, want] of [['060000', 60000], ['50', 100], ['999999999', 120000], ['600000', 320000], ['320000', 320000]]) {
    const o = runStop(stopInput({ last_assistant_message: '다 했어요.' }), { OFFICE_PORT: String(port), OFFICE_RELAY_STOP_WAIT_MS: val, OFFICE_RELAY_DEBUG: '1' });
    assert.match((await o).err, new RegExp(`wait_ms=${want} max_time=${Math.floor(want / 1000) + 5}\\b`), val);
  }
  v.close();
});

test('ceo-stop.sh builds its output itself: a hostile server reply cannot add fields, skip cleanup or exceed 2000 chars', async () => {
  let reply = {};
  const fake = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply)); }); });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const env = { OFFICE_PORT: String(fake.address().port), OFFICE_RELAY_STOP_WAIT_MS: '1000' };
  try {
    reply = { kind: 'instruct', decision: { text: `  a\r\nb\u0001c\u001b[31m${'가'.repeat(3000)}`, behavior: 'allow' }, hookSpecificOutput: { x: 1 }, continue: false };
    let r = await runStop(stopInput(), env);
    const j = JSON.parse(r.out);
    assert.deepEqual(Object.keys(j), ['decision', 'reason']);
    assert.equal(j.reason.slice(0, 8), 'a\nb c [3'); assert.equal(Array.from(j.reason).length, 2000, 'capped at 2000 characters');
    assert.doesNotMatch(j.reason, /[\u0000-\u0009\u000b-\u001f\u007f]/, 'no control characters except \\n');
    for (const bad of [{ kind: 'permission', decision: { text: 'x' } }, { kind: 'instruct', decision: { text: 5 } }, { kind: 'instruct', decision: { text: ' \u0001 ' } },
      { kind: 'instruct', decision: null }, { kind: 'instruct', decision: 'go' }]) {
      reply = bad; r = await runStop(stopInput(), env);
      assert.deepEqual([r.code, r.out], [0, ''], JSON.stringify(bad));
    }
  } finally { fake.close(); }
});

test('endings without a decision: expiry is logged with its wait, kept for the snapshot, skips broadcast as `ended`', async () => {
  const lines = [], frames = [];
  const r = new Relay({ log: (...a) => lines.push(a.join(' ')), broadcast: f => frames.push(f) });
  const a = r.ask(permInput(), 150);
  await a.wait;
  assert.ok(lines.some(l => l === `대표실: Bash (${SID.slice(0, 8)}) expired after 0s`), lines.join('\n'));
  assert.deepEqual(r.ends.map(e => [e.reason, e.tool, e.wait]), [['timeout', 'Bash', 150]]);
  assert.deepEqual(r.skip(permInput(), 'no-viewer') && frames.at(-1).type, 'ended');
  assert.equal(frames.at(-1).end.reason, 'no-viewer');
  assert.equal(r.skip({ hook_event_name: 'Stop', session_id: SID, last_assistant_message: '할까요?' }, 'no-viewer'), null, 'instruct skips are not recorded');
  assert.equal(r.skip({ nope: 1 }, 'no-viewer'), null);
  const b = r.ask(permInput(), 5000); r.withdraw(b.id);
  assert.equal(r.ends.at(-1).reason, 'withdrawn');
  const c = r.ask(permInput(), 5000); r.answer(c.id, { behavior: 'allow' });
  assert.equal(r.ends.length, 3, 'a decision is not an ending to explain');

  const logs = fs.mkdtempSync(path.join(tmp, 'ends-'));
  const port = await startServer(['--logs', logs]);
  await ask(port, permInput(), 1000);                                    // no dashboard: skipped
  const v = await viewer(port);
  const snap = v.ceo.find(f => f.type === 'snapshot');
  assert.deepEqual(snap.ends.map(e => [e.reason, e.tool]), [['no-viewer', 'Bash']], 'the snapshot carries today\'s endings');
  assert.ok(Number.isFinite(snap.startedAt));
  const p = ask(port, permInput(), 300);
  await p;
  const out = serverOut.get(port)();
  assert.match(out, /대표실: Bash \(0f1e2d3c\) expired after 0s/);
  v.close();
  const line = fs.readFileSync(path.join(logs, 'ceo-decisions.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
  assert.deepEqual([line.reason, line.wait], ['timeout', 300], 'the log line keeps the wait for replay after a restart');
});

test('dashboard instructions: at most 8 in a row per session (reset by a typed prompt / SessionEnd); Stop wait ≤ 320 s', async () => {
  assert.equal(INSTRUCT_CAP, 8); assert.equal(STOP_WAIT_MAX, 320000); assert.equal(WAIT_DEFAULT, 540000);
  const frames = [];
  const r = new Relay({ broadcast: f => frames.push(f) });
  const a0 = r.ask(stopInput(), 540000);
  assert.equal(a0.item.expiresAt - a0.item.createdAt, 320000, 'Stop wait clamped so curl (wait+5 s) stays under the 330 s hook timeout');
  r.answer(a0.id, { text: 'go 1' });
  for (let i = 2; i <= INSTRUCT_CAP; i++) { const a = r.ask(stopInput(), 1000); assert.ok(a.id, `#${i} held`); r.answer(a.id, { text: `go ${i}` }); }
  assert.deepEqual(r.ask(stopInput(), 1000), { none: 'cap' }, 'the 9th Stop in a row is not held');
  assert.deepEqual([frames.at(-1).type, frames.at(-1).end.reason, frames.at(-1).end.tool], ['ended', 'cap', 'Stop'], 'the card learns why');
  const other = r.ask(stopInput({ session_id: 'another-session' }), 1000);
  assert.ok(other.id, 'the cap is per session'); r.release(other.id);
  const rel = r.ask(stopInput(), 1000);
  assert.deepEqual(rel, { none: 'cap' });
  r.observe({ ev: 'UserPromptSubmit', sid: SID, ts: new Date().toISOString() });
  const again = r.ask(stopInput(), 1000);
  assert.ok(again.id, 'a prompt typed in the terminal resets the count'); r.release(again.id);
  const nr = r.ask(stopInput(), 1000); r.release(nr.id);
  assert.equal(r.instructs.get(SID) || 0, 0, 'a release (no instruction) does not count');
  r.instructs.set(SID, 8); r.observe({ ev: 'SessionEnd', sid: SID, ts: new Date().toISOString() });
  assert.equal(r.instructs.has(SID), false, 'SessionEnd resets too');
  assert.equal(r.skip(stopInput(), 'unchecked').reason, 'unchecked', 'no caller check on this machine: recorded for the card');
});

test('OFFICE_TEST_ANCESTRY is honoured only under the test runner; a real start with it set keeps the real check', async () => {
  assert.deepEqual(testAncestry({ OFFICE_TEST_ANCESTRY: 'Google Chrome,launchd', NODE_TEST_CONTEXT: 'child-v8' }), ['Google Chrome', 'launchd']);
  assert.equal(testAncestry({ OFFICE_TEST_ANCESTRY: 'Google Chrome,launchd' }), null, 'no test runner: ignored');
  assert.equal(testAncestry({}), null);
  // run as main WITHOUT the test-runner marker: the server says it ignores the fake tree
  const env = { ...process.env, OFFICE_TEST_ANCESTRY: 'Google Chrome,launchd' }; delete env.NODE_TEST_CONTEXT;
  const p = spawn(process.execPath, [SERVER, '--port', '0', '--no-usage', '--logs', fs.mkdtempSync(path.join(tmp, 'anc-'))], { stdio: ['ignore', 'pipe', 'pipe'], env });
  procs.push(p);
  const out = await new Promise((resolve, reject) => {
    let o = ''; const t = setTimeout(() => reject(new Error(o)), 5000);
    p.stdout.on('data', b => { o += b; if (/http:\/\/127\.0\.0\.1:\d+/.test(o)) { clearTimeout(t); resolve(o); } });
  });
  assert.match(out, /OFFICE_TEST_ANCESTRY ignored \(only honoured under the test runner\)/);
  const port = Number(/127\.0\.0\.1:(\d+)/.exec(out)[1]);
  const v = await viewer(port);
  const pr = ask(port, permInput(), 3000);
  const f = await v.waitFor(x => x.type === 'ask');
  const res = await answer(port, f.item.id, { behavior: 'allow' });
  if (process.env.CLAUDECODE || /claude/i.test(String(process.env._ || ''))) assert.equal(res.status, 403, 'under Claude Code the real check refuses this test process');
  else assert.ok([200, 403].includes(res.status));
  await pr; v.close(); p.kill();
});

test('waits: a permission prompt (terminal prompt shows alongside) is held up to 540 s by default; questions and Stop stay 120 s', async () => {
  assert.deepEqual([WAIT_DEFAULT, QUESTION_WAIT_DEFAULT, STOP_WAIT_DEFAULT], [540000, 120000, 120000]);
  assert.equal(parseWait(null, 'permission'), 540000); assert.equal(parseWait('', 'question'), 120000); assert.equal(parseWait('x', 'instruct'), 120000);
  assert.equal(parseWait('60000', 'question'), 60000, 'an explicit wait wins');
  const dbg = async (input, env) => (await runHook(input, { OFFICE_PORT: '9', OFFICE_RELAY_DEBUG: '1', ...env })).err;
  const clean = { OFFICE_RELAY_WAIT_MS: '', OFFICE_RELAY_QUESTION_WAIT_MS: '' };
  const strip = e => { const o = { ...e }; for (const k of Object.keys(clean)) if (!o[k]) delete o[k]; return o; };
  const base = { ...process.env }; delete base.OFFICE_RELAY_WAIT_MS; delete base.OFFICE_RELAY_QUESTION_WAIT_MS;
  const run = (input, env = {}) => new Promise(resolve => {
    const p = spawn('bash', [HOOK], { env: { ...base, OFFICE_PORT: '9', OFFICE_RELAY_DEBUG: '1', ...strip(env) }, stdio: ['pipe', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', b => { err += b; }); p.on('close', () => resolve(err)); p.stdin.end(JSON.stringify(input));
  });
  assert.match(await run(permInput()), /wait_ms=540000 max_time=545\b/, 'permission default = max (hook timeout must be >= 545: setup writes 600)');
  assert.match(await run(askInput()), /wait_ms=120000 max_time=125\b/, 'question default stays short (its terminal UI waits for the hook)');
  assert.match(await run(askInput(), { OFFICE_RELAY_WAIT_MS: '90000' }), /wait_ms=90000\b/, 'question follows OFFICE_RELAY_WAIT_MS when set');
  assert.match(await run(askInput(), { OFFICE_RELAY_WAIT_MS: '90000', OFFICE_RELAY_QUESTION_WAIT_MS: '60000' }), /wait_ms=60000\b/);
  void dbg;
  const skill = fs.readFileSync(fileURLToPath(new URL('../../skills/ai-team-setup/SKILL.md', import.meta.url)), 'utf8');
  assert.equal((skill.match(/ceo-relay\.sh\\\\?"","timeout":600\}/g) || []).length, 2, 'setup writes timeout 600 for both relay hooks');
  assert.match(skill, /Raise the timeout to 600/, 'and offers to raise an old 180');
});

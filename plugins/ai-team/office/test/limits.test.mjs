import './home.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildSnapshot, projOf, Limits } from '../limits.mjs';
import { familyOf } from '../usage.mjs';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'office-limits-'));
const procs = [];
after(() => { for (const p of procs) p.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const NOW = Math.floor(new Date().setHours(12, 0, 0, 0) / 1000);
const mk = (sid, at, extra = {}) => ({ sid, data: { session_id: sid, _captured_at: at, model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  context_window: { context_window_size: 1000000, used_percentage: 41, total_input_tokens: 409032 }, cost: { total_cost_usd: 1.5 },
  workspace: { project_dir: os.tmpdir(), current_dir: os.tmpdir() }, ...extra } });

test('limits: newest capture holding the window wins, per window', () => {
  const s = buildSnapshot([
    mk('a', NOW - 100, { rate_limits: { five_hour: { used_percentage: 10, resets_at: NOW + 1000 }, seven_day: { used_percentage: 50, resets_at: NOW + 9000 } } }),
    mk('b', NOW - 50, { rate_limits: { five_hour: { used_percentage: 28, resets_at: NOW + 2000 } } }),
    mk('c', NOW - 10),
  ], NOW);
  assert.deepEqual(s.account.five_hour, { pct: 28, resetsAt: NOW + 2000, capturedAt: NOW - 50 });
  assert.equal(s.account.seven_day.pct, 50);
  assert.equal(s.account.stale, false);
});

test('limits: past resets dropped, null pct kept, invalid input ignored', () => {
  const s = buildSnapshot([
    mk('a', NOW - 5, { rate_limits: { five_hour: { used_percentage: 90, resets_at: NOW - 1 }, seven_day: { used_percentage: null, resets_at: NOW + 5 } } }),
    { sid: 'x', data: null }, { sid: 'y', data: { no: 'capture' } },
  ], NOW);
  assert.equal(s.account.five_hour, null);
  assert.equal(s.account.seven_day.pct, null);
  assert.equal(s.sessions.length, 1);
});

test('limits: stale flags (account 15 min, session 10 min)', () => {
  const s = buildSnapshot([mk('a', NOW - 16 * 60), mk('b', NOW - 20 * 60)], NOW);
  assert.equal(s.account.stale, true);
  assert.deepEqual(s.sessions.map(x => [x.sid, x.stale]), [['a', true], ['b', true]]);
  const f = buildSnapshot([mk('a', NOW - 9 * 60), mk('b', NOW - 14 * 60)], NOW);
  assert.equal(f.account.stale, false);
  assert.equal(f.sessions[0].stale, false);
  assert.equal(buildSnapshot([], NOW).account.stale, true);
});

test('limits: sessions are today only, newest first, with ctx/family/cost; redact drops cost', () => {
  const yesterday = new Date(NOW * 1000).setHours(0, 0, 0, 0) / 1000 - 60;
  const s = buildSnapshot([mk('old', yesterday), mk('n1', NOW - 300), mk('n2', NOW - 100)], NOW);
  assert.deepEqual(s.sessions.map(x => x.sid), ['n2', 'n1']);
  assert.deepEqual(s.sessions[0].ctx, { size: 1000000, pct: 41, inTokens: 409032 });
  assert.equal(s.sessions[0].family, 'opus');
  assert.equal(s.sessions[0].model, 'Opus 5.5');
  assert.equal(s.sessions[0].costUsd, 1.5);
  const r = buildSnapshot([mk('n2', NOW - 100)], NOW, { redact: true });
  assert.equal('costUsd' in r.sessions[0], false);
  assert.equal(JSON.stringify(r).includes('transcript'), false);
});

test('limits: proj derivation project_dir > cwd > transcript_path', () => {
  assert.equal(projOf({ workspace: { project_dir: '/x/y/Proj' }, cwd: '/other/z' }), 'Proj');
  assert.equal(projOf({ cwd: '/a/b/Cwdproj' }), 'Cwdproj');
  assert.equal(projOf({ transcript_path: '/h/.claude/projects/-a-b/s.jsonl' }), '-a-b');
  assert.equal(projOf({}), null);
});

test('limits: Limits class tolerates invalid/partial files and sees changes', () => {
  const d = path.join(tmp, 'sl'); fs.mkdirSync(d);
  const now = Date.now() / 1000;
  fs.writeFileSync(path.join(d, 'bad.json'), '{"session_id":"bad","_capt');
  fs.writeFileSync(path.join(d, 'ok.json'), JSON.stringify(mk('ok', now).data));
  const l = new Limits({ dir: d });
  assert.deepEqual(l.snapshot(now).sessions.map(x => x.sid), ['ok']);
  fs.writeFileSync(path.join(d, 'bad.json'), JSON.stringify(mk('bad', now + 1).data));
  assert.deepEqual(l.snapshot(now + 2).sessions.map(x => x.sid), ['bad', 'ok']);
  assert.deepEqual(new Limits({ dir: path.join(tmp, 'missing') }).snapshot().sessions, []);
});

const get = (port, p) => new Promise((res, rej) => http.get({ port, path: p, host: '127.0.0.1' }, r => {
  let b = ''; r.on('data', c => b += c); r.on('end', () => res({ status: r.statusCode, body: b }));
}).on('error', rej));

test('server: GET /limits.json and --statusline flag', async () => {
  const d = path.join(tmp, 'sl2'); fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'a.json'), JSON.stringify(mk('a', Date.now() / 1000, { rate_limits: { five_hour: { used_percentage: 33, resets_at: Date.now() / 1000 + 3600 } } }).data));
  const p = spawn(process.execPath, [SERVER, '--port', '0', '--no-usage', '--logs', tmp, '--statusline', d], { stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(p);
  const port = await new Promise(res => { let b = ''; p.stdout.on('data', c => { b += c; const m = /127\.0\.0\.1:(\d+)/.exec(b); if (m) res(Number(m[1])); }); });
  const r = await get(port, '/limits.json');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.account.five_hour.pct, 33);
  assert.equal(j.sessions[0].sid, 'a');
});

// Statusline files are untrusted JSON: a non-string model id ({"toString":1} makes String() throw) or other odd field
// types must never throw out of buildSnapshot and take /limits.json or /events down with it.
const HOSTILE = now => [
  { _captured_at: now, model: { id: { toString: 1 } } },
  { _captured_at: now, model: { id: 42, display_name: ['x'] }, workspace: { project_dir: { toString: 1 } }, cwd: 7 },
  { _captured_at: now, model: 'opus', context_window: 'big', cost: { total_cost_usd: '9' }, rate_limits: { five_hour: 'x', seven_day: [1] } },
  { _captured_at: now, session_id: { toString: 1 }, model: null, workspace: 'w', transcript_path: { a: 1 } },
];
test('limits: non-string model ids and odd field types never throw', () => {
  const now = Date.now() / 1000;
  const s = buildSnapshot(HOSTILE(now).map((data, i) => ({ sid: `h${i}`, data })).concat([mk('good', now)]), now);
  assert.equal(s.sessions.length, 5);
  for (const x of s.sessions.filter(x => x.sid !== 'good')) { assert.equal(x.family, 'unknown'); assert.ok(x.model === null || typeof x.model === 'string'); }
  assert.equal(s.sessions.find(x => x.sid === 'good').family, 'opus');
  assert.deepEqual([familyOf({ toString: 1 }), familyOf(42), familyOf(null), familyOf(['opus'])], ['unknown', 'unknown', 'unknown', 'unknown']);
  assert.equal(projOf({ workspace: { project_dir: { toString: 1 } }, cwd: '/a/b/Real' }), 'Real');
});

test('server: hostile statusline files do not break /limits.json or /events', async () => {
  const d = path.join(tmp, 'sl3'); fs.mkdirSync(d);
  const now = Date.now() / 1000;
  HOSTILE(now).forEach((data, i) => fs.writeFileSync(path.join(d, `h${i}.json`), JSON.stringify(data)));
  fs.writeFileSync(path.join(d, 'raw.json'), `{"_captured_at":${now},"model":{"id":{"toString":1}}}`);
  const p = spawn(process.execPath, [SERVER, '--port', '0', '--no-usage', '--logs', tmp, '--statusline', d], { stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(p);
  const port = await new Promise(res => { let b = ''; p.stdout.on('data', c => { b += c; const m = /127\.0\.0\.1:(\d+)/.exec(b); if (m) res(Number(m[1])); }); });
  const r = await get(port, '/limits.json');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).sessions.length, 5);
  const ready = await new Promise((res, rej) => http.get({ port, path: '/events', host: '127.0.0.1' }, s => {
    let b = ''; s.on('data', c => { b += c; const m = /event: ready\ndata: (.*)\n/.exec(b); if (m) { s.destroy(); res(JSON.parse(m[1])); } });
  }).on('error', rej));
  assert.equal(ready.limits.sessions.length, 5);
  assert.equal(p.exitCode, null, 'server still up');
});

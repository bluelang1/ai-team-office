import './home.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_HOME } from './home.mjs';

// start.sh across a plugin update: the old version's server (another versioned folder) must be found by the
// new version's start.sh, so `restart` stops it and the NEW server.mjs runs. Uses the suite's temp HOME.
const OFFICE = path.dirname(fileURLToPath(new URL('../server.mjs', import.meta.url)));
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'start-test-')));
const PIDFILE = path.join(TEST_HOME, '.claude', 'ai-team-office', 'run', 'server.pid');

function install(version) {
  const dir = path.join(tmp, 'cache', 'ai-team', version, 'office');
  fs.cpSync(OFFICE, dir, { recursive: true, filter: src => !/[\\/](test|\.run|node_modules)$/.test(src) });
  return dir;
}
const OLD = install('0.0.1'), NEW = install('0.0.2');
const FLAGS = ['--port', '0', '--no-usage', '--logs', path.join(tmp, 'logs'), '--projects', path.join(tmp, 'projects')];
fs.mkdirSync(path.join(tmp, 'logs')); fs.mkdirSync(path.join(tmp, 'projects'));

const run = (dir, ...args) => spawnSync(path.join(dir, 'start.sh'), args, { env: { ...process.env, HOME: TEST_HOME }, encoding: 'utf8', timeout: 15000 });
const pid = () => Number(fs.readFileSync(PIDFILE, 'utf8').trim());
const cmdOf = p => { try { return execFileSync('ps', ['-p', String(p), '-o', 'command='], { encoding: 'utf8' }); } catch { return ''; } };
const alive = p => { try { process.kill(p, 0); return true; } catch { return false; } };

after(() => {
  // Kill every server started from this test's temp folders (also ones whose pid was overwritten on failure).
  spawnSync('pkill', ['-f', tmp + '/cache/']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('start.sh: the new version finds, restarts and replaces the old version server', () => {
  const s1 = run(OLD, 'start', ...FLAGS);
  assert.equal(s1.status, 0, s1.stdout + s1.stderr);
  const oldPid = pid();
  assert.match(cmdOf(oldPid), new RegExp(OLD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/server\\.mjs'));

  // A newer start.sh sees the old server as running (not "중지됨") and says it is another version.
  const st = run(NEW, 'status');
  assert.equal(st.status, 0, st.stdout);
  assert.match(st.stdout, new RegExp(`실행 중 pid ${oldPid}`));
  assert.match(st.stdout, /다른 버전 폴더에서 실행 중이에요/);
  const again = run(NEW, 'start', ...FLAGS);
  assert.match(again.stdout, /이미 실행 중/);
  assert.match(again.stdout, /restart/);

  const rs = run(NEW, 'restart', ...FLAGS);
  assert.equal(rs.status, 0, rs.stdout + rs.stderr);
  assert.match(rs.stdout, new RegExp(`중지함 pid ${oldPid}`));
  assert.equal(alive(oldPid), false, 'old server stopped');
  const newPid = pid();
  assert.notEqual(newPid, oldPid);
  assert.ok(cmdOf(newPid).includes(NEW + '/server.mjs'), 'new version server runs: ' + cmdOf(newPid));

  const st2 = run(NEW, 'status');
  assert.equal(st2.status, 0);
  assert.doesNotMatch(st2.stdout, /다른 버전/);

  const sp = run(NEW, 'stop');
  assert.match(sp.stdout, /중지함/);
  assert.equal(alive(newPid), false);
  assert.equal(run(NEW, 'status').status, 1);
});

test('start.sh: a pid file naming a non-office process is not treated as running', () => {
  fs.mkdirSync(path.dirname(PIDFILE), { recursive: true });
  fs.writeFileSync(PIDFILE, String(process.pid)); // this node test process: alive, but not office/server.mjs
  const st = run(NEW, 'status');
  assert.equal(st.status, 1);
  assert.match(st.stdout, /중지됨/);
  assert.equal(alive(process.pid), true);
  fs.rmSync(PIDFILE, { force: true });
});

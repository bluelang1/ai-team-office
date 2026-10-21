// Imported FIRST by every suite: points $HOME at a throwaway dir so no test (or server it spawns) ever reads or
// writes the real ~/.claude (config home ~/.claude/ai-team-office, legacy-config migration, default log dirs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.OFFICE_TEST_HOME) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'office-home-')));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  process.env.OFFICE_TEST_HOME = process.env.HOME = home;
  process.on('exit', () => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
}
export const TEST_HOME = process.env.OFFICE_TEST_HOME;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_MIN_AGE_MS, SWEEP_INTERVAL_MS, TEMP_CLEAN_ENV,
  applyTempCleanup, planTempCleanup, sweepEngineTempThrottled, tempCleanMode,
} = require('../scripts/temp-clean');
const clean = require('../scripts/project/clean');

const HOUR = 3600_000;

function tempRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-temp-clean-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function make(dir, name, ageMs, { file = true } = {}) {
  const full = path.join(dir, name);
  fs.mkdirSync(full, { recursive: true });
  if (file) fs.writeFileSync(path.join(full, 'chunk.bin'), Buffer.alloc(1024));
  const time = new Date(Date.now() - ageMs);
  fs.utimesSync(full, time, time);
  return full;
}

test('only stale Remotion and Chromium folders are planned; engine folders and young ones are kept', (t) => {
  const dir = tempRoot(t);
  const old = 13 * HOUR;
  const doomed = [
    make(dir, 'remotion-v4.0.504-assets-abc', old),
    make(dir, 'remotion-webpack-bundle-xyz', old),
    make(dir, 'puppeteer_dev_chrome_profile-123', old),
    make(dir, 'react-motion-render123', old),
  ];
  const kept = [
    make(dir, 'remotion-v4.0.504-assets-young', 2 * HOUR),
    make(dir, 'automontage-heavy', old),
    make(dir, 'automontage-heavy-test-1', old),
    make(dir, 'layer-project-1', old),
    make(dir, 'my-remotion-v4-assets', old),
  ];
  fs.writeFileSync(path.join(dir, 'remotion-v4.0.504-assets-file'), 'a file, not a folder');
  const planned = planTempCleanup({ tmpDir: dir }).map((entry) => entry.path).sort();
  assert.deepEqual(planned, [...doomed].sort());
  assert.equal(DEFAULT_MIN_AGE_MS, 12 * HOUR);
  const result = applyTempCleanup(planTempCleanup({ tmpDir: dir }), { measure: true });
  assert.equal(result.removed, 4);
  assert.equal(result.freedBytes, 4 * 1024);
  for (const file of doomed) assert.equal(fs.existsSync(file), false);
  for (const file of kept) assert.equal(fs.existsSync(file), true);
});

test('a symbolic link that looks like a Remotion folder is never followed or removed', (t) => {
  const dir = tempRoot(t);
  const target = make(dir, 'precious', 13 * HOUR);
  const link = path.join(dir, 'remotion-v4.0.504-assets-link');
  try {
    fs.symlinkSync(target, link, 'junction');
  } catch (error) {
    t.skip(`ссылку создать нельзя: ${error.code}`);
    return;
  }
  const time = new Date(Date.now() - 13 * HOUR);
  fs.lutimesSync?.(link, time, time);
  assert.deepEqual(planTempCleanup({ tmpDir: dir }), []);
  assert.equal(fs.existsSync(path.join(target, 'chunk.bin')), true);
});

test('the automatic sweep runs at most once an hour and can be switched off', (t) => {
  const dir = tempRoot(t);
  const queueDir = path.join(dir, 'queue');
  fs.mkdirSync(queueDir);
  const now = Date.now();
  make(dir, 'remotion-v4.0.504-assets-1', 13 * HOUR);
  assert.equal(sweepEngineTempThrottled({ queueDir, env: { [TEMP_CLEAN_ENV]: 'off' }, tmpDir: dir, now }), null);
  assert.equal(fs.existsSync(path.join(dir, 'remotion-v4.0.504-assets-1')), true);
  assert.equal(sweepEngineTempThrottled({ queueDir, env: {}, tmpDir: dir, now }).removed, 1);
  make(dir, 'remotion-v4.0.504-assets-2', 13 * HOUR);
  assert.equal(sweepEngineTempThrottled({ queueDir, env: {}, tmpDir: dir, now: now + 60_000 }), null, 'within the hour');
  assert.equal(sweepEngineTempThrottled({ queueDir, env: {}, tmpDir: dir, now: now + SWEEP_INTERVAL_MS + 1 }).removed, 1);
  assert.equal(sweepEngineTempThrottled({ queueDir: null, env: {}, tmpDir: dir, now }), null);
  assert.throws(() => tempCleanMode({ [TEMP_CLEAN_ENV]: 'sometimes' }), /auto или off/);
  assert.equal(sweepEngineTempThrottled({ queueDir, env: { [TEMP_CLEAN_ENV]: 'bad' }, tmpDir: dir, now }), null, 'never throws');
});

test('clean --temp reports by default and deletes only with --yes', (t) => {
  const dir = tempRoot(t);
  const stale = make(dir, 'remotion-v4.0.504-assets-1', 13 * HOUR);
  const young = make(dir, 'remotion-v4.0.504-assets-2', 3 * HOUR);
  const lines = [];
  const log = (line) => lines.push(line);
  assert.equal(clean.main(['--temp'], { log, error: log, tmpDir: dir }), 0);
  assert.match(lines.join('\n'), /старше 12 ч.*: 1 шт\., 0\.0 МБ[\s\S]*повторите с --yes/);
  assert.equal(fs.existsSync(stale), true);
  assert.equal(clean.main(['--temp', '--min-age-hours', '2', '--yes'], { log, error: log, tmpDir: dir }), 0);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(young), false);
  assert.match(lines.at(-1), /Удалено 2 папок/);
  assert.equal(clean.main(['--temp', '--min-age-hours', '0'], { log, error: log, tmpDir: dir }), 1);
  assert.equal(clean.main(['--temp', '--level', 'archive'], { log, error: log, tmpDir: dir }), 1);
});

test('queue tests never touch the machine TEMP: the isolation preload switches the sweep off', () => {
  assert.equal(process.env[TEMP_CLEAN_ENV], 'off');
});

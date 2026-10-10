// Чистка временных папок, которые Remotion и его Chromium оставляют в os.tmpdir().
//
// На Windows Remotion удаляет папку файлового сервера (remotion-v*-assets) синхронным rmSync, пока
// декодер OffthreadVideo ещё держит в ней файлы: удаление не удаётся, и после каждого рендера и кадра
// папка остаётся. К 2026-10-10 их набралось 595 – 25 ГБ. Сюда же webpack-бандлы Remotion CLI и
// профили headless Chromium.
//
// Удаляются только эти шаблоны и только старше minAgeMs (по умолчанию 12 ч – дольше любого рендера):
// папка идущего рендера моложе. Свои папки движка (automontage-*, очередь) не трогаются никогда.
// Автоматически – после каждой задачи очереди не чаще раза в час (sweepEngineTempThrottled);
// AUTOMONTAGE_TEMP_CLEAN=off выключает автоматику, ручная `automontage clean --temp` работает всегда.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEMP_CLEAN_ENV = 'AUTOMONTAGE_TEMP_CLEAN';
const TEMP_PATTERNS = Object.freeze([
  /^remotion-v[\d.]+-assets/,
  /^remotion-webpack-bundle-/,
  /^puppeteer_dev_chrome_profile-/,
  /^react-motion-render/,
]);
const DEFAULT_MIN_AGE_MS = 12 * 3600_000;
const SWEEP_INTERVAL_MS = 3600_000;
const SWEEP_MARKER = 'temp-sweep.json';

function tempCleanMode(env = process.env) {
  const raw = env[TEMP_CLEAN_ENV];
  if (raw === undefined || raw === '') return 'auto';
  const mode = String(raw).trim().toLowerCase();
  if (mode !== 'auto' && mode !== 'off') throw new Error(`${TEMP_CLEAN_ENV} принимает только auto или off`);
  return mode;
}

// Каталоги временной папки, подходящие под шаблоны и старше minAgeMs. Ссылки не идут в план:
// за ними может лежать что угодно.
function planTempCleanup({ tmpDir = os.tmpdir(), minAgeMs = DEFAULT_MIN_AGE_MS, now = Date.now(), fileSystem = fs } = {}) {
  let names;
  try { names = fileSystem.readdirSync(tmpDir); } catch (_) { return []; }
  const entries = [];
  for (const name of names) {
    if (!TEMP_PATTERNS.some((pattern) => pattern.test(name))) continue;
    const full = path.join(tmpDir, name);
    let stat;
    try { stat = fileSystem.lstatSync(full); } catch (_) { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    if (now - stat.mtimeMs < minAgeMs) continue;
    entries.push({ path: full, name, mtimeMs: stat.mtimeMs });
  }
  return entries;
}

function directorySize(dir, fileSystem = fs) {
  let total = 0;
  let names;
  try { names = fileSystem.readdirSync(dir); } catch (_) { return 0; }
  for (const name of names) {
    const full = path.join(dir, name);
    let stat;
    try { stat = fileSystem.lstatSync(full); } catch (_) { continue; }
    if (stat.isDirectory() && !stat.isSymbolicLink()) total += directorySize(full, fileSystem);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

// Удаление без ожидания повторов: занятая папка (идёт рендер, файл открыт) остаётся до следующего раза.
function applyTempCleanup(entries, { fileSystem = fs, measure = false } = {}) {
  let removed = 0;
  let freedBytes = 0;
  const failed = [];
  for (const entry of entries) {
    const bytes = measure ? directorySize(entry.path, fileSystem) : 0;
    try {
      fileSystem.rmSync(entry.path, { recursive: true, force: true, maxRetries: 0 });
      removed += 1;
      freedBytes += bytes;
    } catch (error) {
      failed.push({ path: entry.path, code: error?.code || 'ERROR' });
    }
  }
  return { removed, freedBytes, failed };
}

// Автоматическая чистка после задачи очереди: не чаще раза в SWEEP_INTERVAL_MS (метка в папке
// очереди), и никакая ошибка не мешает самой задаче.
function sweepEngineTempThrottled({ queueDir, env = process.env, now = Date.now(), tmpDir = os.tmpdir(), fileSystem = fs } = {}) {
  try {
    if (tempCleanMode(env) === 'off' || !queueDir) return null;
    const marker = path.join(queueDir, SWEEP_MARKER);
    try {
      const last = JSON.parse(fileSystem.readFileSync(marker, 'utf8')).at;
      if (Number.isFinite(last) && now - last < SWEEP_INTERVAL_MS && last <= now) return null;
    } catch (_) { /* первая чистка */ }
    fileSystem.writeFileSync(marker, `${JSON.stringify({ at: now })}\n`);
    return applyTempCleanup(planTempCleanup({ tmpDir, now, fileSystem }), { fileSystem });
  } catch (_) {
    return null;
  }
}

module.exports = {
  DEFAULT_MIN_AGE_MS, SWEEP_INTERVAL_MS, TEMP_CLEAN_ENV, TEMP_PATTERNS,
  applyTempCleanup, directorySize, planTempCleanup, sweepEngineTempThrottled, tempCleanMode,
};

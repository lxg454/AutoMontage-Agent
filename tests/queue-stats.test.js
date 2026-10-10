const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { queueStats, formatQueueStats, stageOf, formatDuration } = require('../scripts/queue-stats');

const NOW = Date.parse('2026-10-10T20:00:00Z');
const entry = (label, runS, waitS, endedAt = '2026-10-10T19:00:00Z') => ({
  label, ranMs: runS * 1000, waitedMs: waitS * 1000, endedAt,
});

test('stage names drop the project and keep two-word stages apart', () => {
  assert.equal(stageOf('layer render 2026.10.10_x/motion-v01'), 'layer render');
  assert.equal(stageOf('layer import 2026.10.10_x'), 'layer import');
  assert.equal(stageOf('motion final x'), 'motion final');
  assert.equal(stageOf('final x'), 'final');
  assert.equal(stageOf('preview x'), 'preview');
  assert.equal(stageOf('something else'), 'другое');
});

test('stats group by stage with medians, worst wait and recent window', () => {
  const rows = queueStats([
    entry('final a', 160, 0), entry('final b', 200, 600), entry('final c', 180, 30),
    entry('preview a', 210, 10),
    entry('preview old', 999, 999, '2026-09-01T00:00:00Z'),
    { label: 'broken' },
  ], { now: NOW });
  assert.deepEqual(rows.map((row) => row.stage), ['final', 'preview']);
  assert.equal(rows[0].count, 3);
  assert.equal(rows[0].medianRunMs, 180_000);
  assert.equal(rows[0].medianWaitMs, 30_000);
  assert.equal(rows[0].maxWaitMs, 600_000);
  assert.equal(queueStats([entry('preview old', 1, 1, '2026-09-01T00:00:00Z')], { days: null, now: NOW }).length, 1);
});

test('durations and an empty log read naturally', () => {
  assert.equal(formatDuration(42_000), '42 с');
  assert.equal(formatDuration(164_000), '2 мин 44 с');
  assert.equal(formatDuration(23_400_000), '6 ч 30 мин');
  assert.equal(formatQueueStats([]), 'Журнал очереди за 7 дн.: записей нет');
  assert.match(formatQueueStats([entry('final a', 164, 0)], { now: NOW }), /final: 1 шт\.; работа 2 мин 44 с/);
});

test('queue CLI prints stats from the timing log without creating slots', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-queue-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'timings.jsonl'), `${JSON.stringify({
    label: 'preview demo', lane: 'heavy', slot: 0, ranMs: 61_000, waitedMs: 0,
    startedAt: new Date(Date.now() - 61_000).toISOString(), endedAt: new Date().toISOString(),
  })}\nnot json\n`);
  const result = spawnSync(process.execPath, [require.resolve('../scripts/cli'), 'queue', 'stats'], {
    encoding: 'utf8', env: { ...process.env, AUTOMONTAGE_HEAVY_DIR: dir },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /preview: 1 шт\.; работа 1 мин 01 с/);
  assert.deepEqual(fs.readdirSync(dir), ['timings.jsonl']);
});

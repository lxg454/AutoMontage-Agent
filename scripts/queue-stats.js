// `automontage queue stats` – сводка журнала очереди (timings.jsonl): сколько задач каждого этапа
// прошло, сколько они ждали слот и сколько работали. Этап – label без имени проекта.
const STAGES = ['layer render', 'layer import', 'motion final', 'roughcut', 'preview', 'master', 'final'];

function stageOf(label) {
  const text = String(label || '');
  return STAGES.find((stage) => text === stage || text.startsWith(`${stage} `)) || 'другое';
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function formatDuration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} мин ${String(seconds % 60).padStart(2, '0')} с`;
  return `${Math.floor(minutes / 60)} ч ${String(minutes % 60).padStart(2, '0')} мин`;
}

function queueStats(entries, { days = 7, now = Date.now() } = {}) {
  const since = days === null ? -Infinity : now - days * 86_400_000;
  const groups = new Map();
  for (const entry of entries) {
    if (!entry || !Number.isFinite(entry.ranMs) || !Number.isFinite(entry.waitedMs)) continue;
    if (!(Date.parse(entry.endedAt) >= since)) continue;
    const stage = stageOf(entry.label);
    if (!groups.has(stage)) groups.set(stage, []);
    groups.get(stage).push(entry);
  }
  return [...groups.entries()].map(([stage, list]) => ({
    stage,
    count: list.length,
    medianRunMs: median(list.map((entry) => entry.ranMs)),
    medianWaitMs: median(list.map((entry) => entry.waitedMs)),
    maxWaitMs: Math.max(...list.map((entry) => entry.waitedMs)),
    totalRunMs: list.reduce((sum, entry) => sum + entry.ranMs, 0),
  })).sort((a, b) => b.totalRunMs - a.totalRunMs);
}

function formatQueueStats(entries, options = {}) {
  const rows = queueStats(entries, options);
  const period = options.days === null ? 'за всё время' : `за ${options.days ?? 7} дн.`;
  if (!rows.length) return `Журнал очереди ${period}: записей нет`;
  const lines = [`Журнал очереди ${period} (медиана работы / медиана ожидания / худшее ожидание):`];
  for (const row of rows) {
    lines.push(`${row.stage}: ${row.count} шт.; работа ${formatDuration(row.medianRunMs)}; `
      + `ожидание ${formatDuration(row.medianWaitMs)}; худшее ${formatDuration(row.maxWaitMs)}; `
      + `всего работы ${formatDuration(row.totalRunMs)}`);
  }
  return lines.join('\n');
}

module.exports = { queueStats, formatQueueStats, stageOf, formatDuration };

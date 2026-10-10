const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { acquireProjectMutationLease } = require('./project/workspace');

const { executionBusy, wasReleased, registerExecutionSlot } = require('./heavy-execution');

const HEAVY_QUEUE_BUSY = 'HEAVY_QUEUE_BUSY';
// Short jobs that mostly copy or remux: in their own lane they never wait behind a long render.
const LIGHT_LABEL = /^(?:layer import|roughcut|master) /;
// A waiter refreshes its ticket every poll; a ticket untouched this long belongs to a dead waiter.
const WAITER_STALE_MS = 60_000;
const TIMINGS_FILE = 'timings.jsonl';
const TIMINGS_MAX_BYTES = 2 * 1024 * 1024;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function integerSetting(env, name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  if (env[name] === undefined) return fallback;
  const raw = String(env[name]);
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name}: требуется целое число от ${min} до ${max}`);
  }
  return value;
}

function heavyQueueConfig(env = process.env) {
  return {
    dir: env.AUTOMONTAGE_HEAVY_DIR || path.join(os.tmpdir(), 'automontage-heavy'),
    slots: integerSetting(env, 'AUTOMONTAGE_HEAVY_SLOTS', 1, 1, 8),
    lightSlots: integerSetting(env, 'AUTOMONTAGE_LIGHT_SLOTS', 1, 0, 8),
    waitMs: integerSetting(env, 'AUTOMONTAGE_HEAVY_WAIT_MS', 3 * 3600_000, 0),
    pollMs: 5000,
  };
}

// Light jobs use their own `light-N` slots while AUTOMONTAGE_LIGHT_SLOTS > 0 (a config without the
// field, as older callers build it, has no light lane).
function laneFor(label, config) {
  return (config.lightSlots || 0) > 0 && LIGHT_LABEL.test(String(label || '')) ? 'light' : 'heavy';
}

function laneSlots(config, lane) {
  return lane === 'light'
    ? { prefix: 'light', count: config.lightSlots || 0 }
    : { prefix: 'slot', count: config.slots };
}

function tryAcquireHeavySlot({ label, config = heavyQueueConfig(), leaseOptions = {} }) {
  const lane = laneFor(label, config);
  const { prefix, count } = laneSlots(config, lane);
  for (let index = 0; index < count; index += 1) {
    const slotDir = path.join(config.dir, `${prefix}-${index}`);
    fs.mkdirSync(slotDir, { recursive: true });
    let lease;
    try {
      lease = acquireProjectMutationLease(slotDir, {
        ...leaseOptions,
        killProcess(pid, signal) {
          const owner = readJson(path.join(slotDir, '.project-mutation.lock'));
          if (owner && owner.pid === pid) {
            if (executionBusy(slotDir, owner)) return;
            if (wasReleased(slotDir, owner)) throw Object.assign(new Error('released'), { code: 'ESRCH' });
          }
          return (leaseOptions.killProcess || process.kill)(pid, signal);
        },
      });
    } catch (error) {
      if (error && error.code === 'PROJECT_MANIFEST_CONFLICT') continue;
      throw error;
    }
    const holderPath = path.join(slotDir, 'holder.json');
    try {
      fs.writeFileSync(holderPath, `${JSON.stringify({
        label, pid: lease.owner.pid, acquiredAt: lease.owner.acquiredAt,
      })}\n`);
    } catch (_) {
      // Metadata is advisory; the project mutation lease provides exclusion.
    }
    const execution = registerExecutionSlot(slotDir, lease.owner);
    let released = false;
    return {
      index,
      lane,
      waited: false,
      release() {
        if (released) return;
        execution.stop();
        if (executionBusy(slotDir, lease.owner)) {
          // Keep the atomic lease until the owned group ends, even if this process
          // remains alive. The token-scoped release marker permits later recovery.
          execution.deferRelease();
          released = true;
          return;
        }
        try {
          fs.unlinkSync(holderPath);
        } catch (_) {
          // A missing or unwritable description must not keep the slot occupied.
        }
        lease.release();
        released = true;
      },
    };
  }
  return null;
}

function readJson(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) return { invalid: true };
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : { invalid: true };
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return { invalid: true };
  }
}

function ownerIsDead(owner) {
  // Match the lease protocol's conservative recovery rule: only ESRCH proves death.
  if (owner.version !== 1 || owner.hostname !== os.hostname()
    || !Number.isInteger(owner.pid) || owner.pid <= 0
    || typeof owner.token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(owner.token)) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return Boolean(error && error.code === 'ESRCH');
  }
}

function listHeavySlots(config = heavyQueueConfig(), lane = 'heavy') {
  const { prefix, count } = laneSlots(config, lane);
  return Array.from({ length: count }, (_, index) => {
    const empty = { index, busy: false, label: null, pid: null, acquiredAt: null };
    const slotDir = path.join(config.dir, `${prefix}-${index}`);
    const owner = readJson(path.join(slotDir, '.project-mutation.lock'));
    if (!owner || ((ownerIsDead(owner) || wasReleased(slotDir, owner))
      && !executionBusy(slotDir, owner))) return empty;
    const holder = readJson(path.join(slotDir, 'holder.json'));
    const matchingHolder = holder && holder.pid === owner.pid && holder.acquiredAt === owner.acquiredAt;
    return {
      index,
      busy: true,
      label: matchingHolder && typeof holder.label === 'string' ? holder.label : null,
      pid: Number.isInteger(owner.pid) ? owner.pid : null,
      acquiredAt: typeof owner.acquiredAt === 'string' ? owner.acquiredAt : null,
    };
  });
}

function waitState(config, log, now, lane = 'heavy') {
  let startedAt;
  let lastHolder;
  return () => {
    const holders = listHeavySlots(config, lane).filter((slot) => slot.busy);
    const description = holders.map((slot) => slot.label || 'другая тяжёлая задача').join(', ')
      || 'другая тяжёлая задача';
    const currentTime = now();
    if (startedAt === undefined) startedAt = currentTime;
    if (config.waitMs === 0 || currentTime - startedAt >= config.waitMs) {
      const error = new Error(`машина занята: ${description}`);
      error.code = HEAVY_QUEUE_BUSY;
      throw error;
    }
    const signature = JSON.stringify(holders);
    if (signature !== lastHolder) {
      log(`очередь тяжёлых задач занята: ${description}; ожидаю свободный слот`);
      lastHolder = signature;
    }
  };
}

// Waiting tickets, the timing log and its rotation use the real clock: the injected `now` only
// drives the wait limit, so tests can shorten it without touching ticket ages.
function waitersDir(config, lane) {
  return path.join(config.dir, `waiting-${lane}`);
}

function pidGone(pid) {
  try { process.kill(pid, 0); return false; } catch (error) { return Boolean(error && error.code === 'ESRCH'); }
}

// Live waiting tickets of a lane, oldest first. Tickets of dead or silent waiters are removed,
// so a crashed waiter does not hold the line.
function listWaiters(config = heavyQueueConfig(), lane = 'heavy') {
  const dir = waitersDir(config, lane);
  const staleMs = Math.max(WAITER_STALE_MS, 6 * config.pollMs);
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort(); } catch (_) { return []; }
  const live = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let ticket = null;
    let stale;
    try {
      stale = Date.now() - fs.statSync(file).mtimeMs > staleMs;
      ticket = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (stale === undefined) continue; // removed between readdir and stat
      // A ticket that is being written right now is not yet a reason to drop it.
    }
    if (!stale && ticket && ticket.hostname === os.hostname()
      && Number.isInteger(ticket.pid) && ticket.pid > 0) stale = pidGone(ticket.pid);
    if (stale) {
      try { fs.unlinkSync(file); } catch (_) { /* another waiter removed it first */ }
      continue;
    }
    live.push({
      name,
      label: ticket && typeof ticket.label === 'string' ? ticket.label : null,
      pid: ticket && Number.isInteger(ticket.pid) ? ticket.pid : null,
      since: ticket && typeof ticket.since === 'string' ? ticket.since : null,
    });
  }
  return live;
}

const ownTickets = new Set();
let exitHookInstalled = false;

function enqueueWaiter(config, lane, label) {
  const dir = waitersDir(config, lane);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${String(Date.now()).padStart(15, '0')}-${String(process.pid).padStart(7, '0')}-${randomUUID()}.json`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({
    label, pid: process.pid, hostname: os.hostname(), since: new Date().toISOString(),
  }), { flag: 'wx' });
  ownTickets.add(file);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const own of ownTickets) {
        try { fs.unlinkSync(own); } catch (_) { /* already gone */ }
      }
    });
  }
  return {
    name,
    heartbeat() {
      const time = new Date();
      try { fs.utimesSync(file, time, time); } catch (_) { /* pruned: the order check below re-adds nothing */ }
    },
    remove() {
      ownTickets.delete(file);
      try { fs.unlinkSync(file); } catch (_) { /* already gone */ }
    },
  };
}

// First come, first served: a waiter tries a slot only while fewer older live waiters stand
// before it than its lane has free slots. A pruned ticket of a live waiter keeps the old
// behaviour (try whenever a slot is free) instead of waiting forever.
function myTurn(config, lane, ticket) {
  const position = listWaiters(config, lane).findIndex((waiter) => waiter.name === ticket.name);
  const free = listHeavySlots(config, lane).filter((slot) => !slot.busy).length;
  return position === -1 ? free > 0 : position < free;
}

function appendTiming(config, entry) {
  try {
    const file = path.join(config.dir, TIMINGS_FILE);
    try {
      if (fs.statSync(file).size > TIMINGS_MAX_BYTES) fs.renameSync(file, path.join(config.dir, 'timings.1.jsonl'));
    } catch (_) { /* no log yet */ }
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch (_) {
    // The timing log is diagnostics only and must never fail a render.
  }
}

// Every job taken through the queue leaves one line in timings.jsonl: how long it waited and ran.
function timed(slot, { config, label, waitStartedAt }) {
  const acquiredAt = Date.now();
  const release = slot.release;
  let logged = false;
  return {
    ...slot,
    release() {
      release.call(slot);
      if (logged) return;
      logged = true;
      const endedAt = Date.now();
      appendTiming(config, {
        label, lane: slot.lane, slot: slot.index,
        waitedMs: acquiredAt - waitStartedAt, ranMs: endedAt - acquiredAt,
        startedAt: new Date(acquiredAt).toISOString(), endedAt: new Date(endedAt).toISOString(),
      });
      // Мусор Remotion в TEMP (scripts/temp-clean.js): не чаще раза в час, ошибки не мешают задаче.
      require('./temp-clean').sweepEngineTempThrottled({ queueDir: config.dir });
    },
  };
}

function acquireHeavySlotSync({
  label, config = heavyQueueConfig(), log = console.log,
  sleepSync = (ms) => Atomics.wait(sleepBuffer, 0, 0, ms), now = Date.now,
}) {
  const lane = laneFor(label, config);
  const wait = waitState(config, log, now, lane);
  const waitStartedAt = Date.now();
  const ticket = enqueueWaiter(config, lane, label);
  let waited = false;
  try {
    while (true) {
      ticket.heartbeat();
      const slot = myTurn(config, lane, ticket) ? tryAcquireHeavySlot({ label, config }) : null;
      if (slot) return timed({ ...slot, waited }, { config, label, waitStartedAt });
      wait();
      waited = true;
      sleepSync(config.pollMs);
    }
  } finally {
    ticket.remove();
  }
}

async function acquireHeavySlot({
  label, config = heavyQueueConfig(), log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = Date.now,
}) {
  const lane = laneFor(label, config);
  const wait = waitState(config, log, now, lane);
  const waitStartedAt = Date.now();
  const ticket = enqueueWaiter(config, lane, label);
  let waited = false;
  try {
    while (true) {
      ticket.heartbeat();
      const slot = myTurn(config, lane, ticket) ? tryAcquireHeavySlot({ label, config }) : null;
      if (slot) return timed({ ...slot, waited }, { config, label, waitStartedAt });
      wait();
      waited = true;
      await sleep(config.pollMs);
    }
  } finally {
    ticket.remove();
  }
}

// Timing lines of queued jobs, oldest first; torn lines are skipped.
function readTimings(config = heavyQueueConfig()) {
  const entries = [];
  for (const name of ['timings.1.jsonl', TIMINGS_FILE]) {
    let text;
    try { text = fs.readFileSync(path.join(config.dir, name), 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch (_) { /* torn line */ }
    }
  }
  return entries;
}

module.exports = {
  heavyQueueConfig, tryAcquireHeavySlot, acquireHeavySlotSync,
  acquireHeavySlot, listHeavySlots, listWaiters, readTimings, laneFor, HEAVY_QUEUE_BUSY,
};

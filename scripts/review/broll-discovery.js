'use strict';
const { Readable } = require('node:stream');
const { createCandidateStore } = require('../broll/candidates');
const { normalizeSearch } = require('../broll/search-common');
const { providerInfo } = require('../broll/providers');
// Хосты медиа – только того провайдера, который нашёл кандидата.
const mediaHosts = (candidate) => {
  const info = providerInfo(candidate.provider);
  return [...new Set([...info.imageHosts, ...info.videoHosts])];
};
const { requestRemote, LIMITS } = require('../broll/remote');
const { validateProvenance } = require('../broll/provenance');
const { runMediaProcess } = require('./media-process');
async function probeProxyBytes({ bytes, signal }) {
  const result = await runMediaProcess({
    command: 'ffprobe',
    args: [
      '-v',
      'error',
      '-max_alloc',
      '67108864',
      '-probesize',
      '2097152',
      '-analyzeduration',
      '2000000',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      '-i',
      'pipe:0',
    ],
    stdin: bytes,
    signal,
    timeoutMs: 10000,
    maxStdoutBytes: 65536,
    maxStderrBytes: 65536,
  });
  const data = JSON.parse(result.stdout);
  return {
    ...data.streams?.find((s) => s.codec_type === 'video'),
    format_name: data.format?.format_name,
  };
}
function proxySignature(bytes, type) {
  if (type === 'image/jpeg')
    return (
      bytes.length >= 4 &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255
    );
  if (type === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (type === 'image/webp')
    return (
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP'
    );
  if (type === 'video/mp4') return bytes.toString('ascii', 4, 8) === 'ftyp';
  return false;
}
const BASE = ['baseRevision', 'baseHash', 'manifestHash'];
const PUBLIC_ERRORS = new Set([
  'BROLL_REQUEST_INVALID',
  'BROLL_SCENE_INVALID',
  'BROLL_CANDIDATE_UNAVAILABLE',
  'BROLL_SEARCH_STALE',
  'BROLL_SESSION_CLOSED',
  'BROLL_BUSY',
  'BROLL_REMOTE_ABORTED',
  'BROLL_REMOTE_TIMEOUT',
  'BROLL_REMOTE_REJECTED',
  'BROLL_PROVIDER_FAILED',
  'BROLL_RATE_LIMITED',
  'BROLL_KEY_MISSING',
  'BROLL_CONFIG_INVALID',
  'BROLL_PROVIDER_UNSUPPORTED',
  'BROLL_PROXY_INVALID',
  'BROLL_DOWNLOAD_INVALID',
  'STALE_REVIEW_BASE',
]);
function candidateProvenance(candidate) {
  return validateProvenance(
    Object.fromEntries(
      [
        'provider',
        'providerAssetId',
        'sourcePage',
        'author',
        'license',
        'queryOriginal',
        'queryEnglish',
        'retrievedAt',
        'rendition',
      ].map((k) => [k, candidate[k]]),
    ),
  );
}
function failure(code, status = 400) {
  return Object.assign(new Error(code), { code, status });
}
function shape(value, required, optional = []) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    required.some((k) => !Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => ![...required, ...optional].includes(k))
  )
    throw failure('BROLL_REQUEST_INVALID');
}
function createBrollDiscovery({
  provider,
  store = createCandidateStore(),
  download = requestRemote,
  importMedia,
  registerAsset,
  getSnapshot,
  importContext = {},
  maxConcurrent = 4,
  timeoutMs = 120000,
  probeProxy = probeProxyBytes,
}) {
  const scopes = new Map(),
    generations = new Map(),
    active = new Set(),
    activeOwners = new Map(),
    idleWaiters = new Set(),
    proxyQueue = [];
  let closed = false,
    selecting = false;
  function base(body) {
    if (
      !Number.isSafeInteger(body.baseRevision) ||
      body.baseRevision < 1 ||
      !['baseHash', 'manifestHash'].every(
        (k) => typeof body[k] === 'string' && /^[a-f0-9]{64}$/.test(body[k]),
      )
    )
      throw failure('BROLL_REQUEST_INVALID');
    const current = getSnapshot();
    if (BASE.some((k) => body[k] !== current[k]))
      throw failure('STALE_REVIEW_BASE', 409);
    if (
      !Number.isSafeInteger(body.sceneIndex) ||
      body.sceneIndex < 0 ||
      current.scenes?.[body.sceneIndex]?.scene !== 'broll'
    )
      throw failure('BROLL_SCENE_INVALID');
  }
  function scope(candidateId) {
    const entry = scopes.get(candidateId);
    if (!entry) throw failure('BROLL_CANDIDATE_UNAVAILABLE', 404);
    return entry;
  }
  function current(entry, candidateId) {
    base(entry.base);
    if (generations.get(entry.sceneIndex) !== entry.generation)
      throw failure('BROLL_SEARCH_STALE', 409);
    const candidate = store.get({
      candidateId,
      searchId: entry.searchId,
      sceneIndex: entry.sceneIndex,
    });
    if (!candidate) throw failure('BROLL_CANDIDATE_UNAVAILABLE', 404);
    return candidate;
  }
  async function operation(fn, signal, owner, queueProxy = false) {
    if (closed) throw failure('BROLL_SESSION_CLOSED', 409);
    const abort = new AbortController();
    const cancel = () => abort.abort();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, timeoutMs);
    if (owner) activeOwners.set(abort, owner);
    try {
      if (active.size >= maxConcurrent) {
        if (!queueProxy || proxyQueue.length >= 24)
          throw failure('BROLL_BUSY', 409);
        await new Promise((resolve, reject) => {
          const queued = {
            abort,
            admit() {
              abort.signal.removeEventListener('abort', onAbort);
              active.add(abort);
              resolve();
            },
          };
          const onAbort = () => {
            const index = proxyQueue.indexOf(queued);
            if (index >= 0) proxyQueue.splice(index, 1);
            reject(failure('BROLL_REMOTE_ABORTED', 409));
          };
          if (abort.signal.aborted) {
            onAbort();
            return;
          }
          abort.signal.addEventListener('abort', onAbort, { once: true });
          proxyQueue.push(queued);
        });
      } else active.add(abort);
      if (abort.signal.aborted) throw failure('BROLL_REMOTE_ABORTED', 409);
      const result = await fn(abort.signal);
      if (abort.signal.aborted) throw failure('BROLL_REMOTE_ABORTED', 409);
      return result;
    } catch (error) {
      if (
        abort.signal.aborted &&
        !['STALE_REVIEW_BASE', 'BROLL_SEARCH_STALE'].includes(error?.code)
      )
        throw failure('BROLL_REMOTE_ABORTED', 409);
      if (PUBLIC_ERRORS.has(error?.code))
        throw failure(
          error.code,
          [400, 404, 409, 413, 415, 422, 507].includes(error.status)
            ? error.status
            : 502,
        );
      if (/^MEDIA_IMPORT_/.test(error?.code || ''))
        throw failure(
          'BROLL_IMPORT_FAILED',
          [400, 409, 413, 415, 422, 507].includes(error.status)
            ? error.status
            : 422,
        );
      throw failure('BROLL_PROVIDER_FAILED', 502);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      active.delete(abort);
      activeOwners.delete(abort);
      while (proxyQueue.length && active.size < maxConcurrent) {
        const queued = proxyQueue.shift();
        if (!queued.abort.signal.aborted) queued.admit();
      }
      if (!active.size && !proxyQueue.length) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    }
  }
  return {
    get busy() {
      return selecting;
    },
    async search(body, signal) {
      shape(
        body,
        [...BASE, 'sceneIndex', 'queryOriginal', 'queryEnglish', 'mediaKind'],
        ['orientation', 'minDurationSec', 'minWidth', 'minHeight', 'page'],
      );
      base(body);
      const { baseRevision, baseHash, manifestHash, sceneIndex, ...filters } =
        body;
      let query;
      try {
        query = normalizeSearch(filters);
      } catch {
        throw failure('BROLL_REQUEST_INVALID');
      }
      if (closed) throw failure('BROLL_SESSION_CLOSED', 409);
      if (active.size >= maxConcurrent) throw failure('BROLL_BUSY', 409);
      const generation = (generations.get(sceneIndex) || 0) + 1;
      generations.set(sceneIndex, generation);
      for (const [abort, owner] of activeOwners) {
        if (owner.sceneIndex === sceneIndex) abort.abort();
      }
      for (const [id, entry] of scopes)
        if (entry.sceneIndex === sceneIndex) scopes.delete(id);
      return operation(
        async (signal) => {
          const result = await provider.search({ ...query, signal });
          base(body);
          if (generations.get(sceneIndex) !== generation)
            throw failure('BROLL_SEARCH_STALE', 409);
          if (signal.aborted) throw failure('BROLL_REMOTE_ABORTED', 409);
          const shelf = store.replace({
            sceneIndex,
            query,
            candidates: result.candidates,
          });
          for (const card of shelf.candidates)
            scopes.set(card.id, {
              candidateId: card.id,
              base: { baseRevision, baseHash, manifestHash, sceneIndex },
              sceneIndex,
              generation,
              searchId: shelf.searchId,
            });
          // Keep the proxy lookup bounded to the same capacity as the candidate store.
          for (const [id, entry] of scopes)
            if (
              !store.get({
                candidateId: id,
                searchId: entry.searchId,
                sceneIndex: entry.sceneIndex,
              })
            )
              scopes.delete(id);
          return {
            ...shelf,
            nextPage: Number.isInteger(result.nextPage)
              ? result.nextPage
              : null,
          };
        },
        signal,
        { sceneIndex, generation },
      );
    },
    reject(body) {
      shape(body, ['searchId', 'candidateId']);
      const entry = scope(body.candidateId);
      current(entry, body.candidateId);
      if (entry.searchId !== body.searchId)
        throw failure('BROLL_CANDIDATE_UNAVAILABLE', 404);
      for (const [abort, owner] of activeOwners) {
        if (owner.candidateId === body.candidateId) abort.abort();
      }
      store.reject(body);
      scopes.delete(body.candidateId);
      return { ok: true };
    },
    async proxy(candidateId, kind, signal) {
      if (!['thumbnail', 'preview'].includes(kind))
        throw failure('BROLL_REQUEST_INVALID');
      const entry = scope(candidateId),
        candidate = current(entry, candidateId),
        url = candidate[`${kind}Url`];
      if (!url || url === candidate.downloadUrl)
        throw failure('BROLL_CANDIDATE_UNAVAILABLE', 404);
      return operation(
        async (signal) => {
          current(entry, candidateId);
          const response = await download({
            url,
            allowedHosts: mediaHosts(candidate),
            maxBytes: LIMITS[kind],
            timeoutMs: 20000,
            signal,
            expectedMimeTypes:
              kind === 'thumbnail' || candidate.mediaKind === 'image'
                ? ['image/jpeg', 'image/png', 'image/webp']
                : ['video/mp4'],
          });
          current(entry, candidateId);
          try {
            if (
              !Buffer.isBuffer(response.bytes) ||
              response.bytes.length > LIMITS[kind] ||
              !proxySignature(response.bytes, response.contentType)
            )
              throw new Error();
            const probe = await probeProxy({ bytes: response.bytes, signal });
            const codecs = {
              'image/jpeg': ['mjpeg'],
              'image/png': ['png'],
              'image/webp': ['webp'],
              'video/mp4': ['h264', 'hevc', 'av1'],
            };
            if (
              !codecs[response.contentType]?.includes(probe.codec_name) ||
              !Number.isSafeInteger(probe.width) ||
              !Number.isSafeInteger(probe.height) ||
              probe.width < 1 ||
              probe.height < 1 ||
              probe.width > 4096 ||
              probe.height > 4096 ||
              probe.width * probe.height > 8388608
            )
              throw new Error();
          } catch {
            throw failure('BROLL_PROXY_INVALID', 422);
          }
          current(entry, candidateId);
          return { bytes: response.bytes, contentType: response.contentType };
        },
        signal,
        entry,
        true,
      );
    },
    async select(body, signal) {
      shape(body, [...BASE, 'sceneIndex', 'searchId', 'candidateId']);
      base(body);
      const entry = scope(body.candidateId);
      if (
        entry.sceneIndex !== body.sceneIndex ||
        entry.searchId !== body.searchId
      )
        throw failure('BROLL_CANDIDATE_UNAVAILABLE', 404);
      const candidate = current(entry, body.candidateId);
      if (selecting) throw failure('BROLL_BUSY', 409);
      selecting = true;
      try {
        return await operation(
          async (signal) => {
            const response = await download({
              url: candidate.downloadUrl,
              allowedHosts: mediaHosts(candidate),
              maxBytes: LIMITS[candidate.mediaKind],
              timeoutMs: 60000,
              signal,
              expectedMimeTypes: [candidate.rendition.mimeType],
            });
            current(entry, body.candidateId);
            base(body);
            if (signal.aborted) throw failure('BROLL_REMOTE_ABORTED', 409);
            const provenance = candidateProvenance(candidate);
            const extension = {
              'image/jpeg': 'jpg',
              'image/png': 'png',
              'image/webp': 'webp',
              'video/mp4': 'mp4',
            }[candidate.rendition.mimeType];
            if (
              !extension ||
              !Buffer.isBuffer(response.bytes) ||
              !response.bytes.length ||
              response.bytes.length > LIMITS[candidate.mediaKind]
            )
              throw failure('BROLL_DOWNLOAD_INVALID', 422);
            const imported = await importMedia({
              ...importContext,
              request: Readable.from([response.bytes]),
              signal,
              provenance,
              headers: {
                'content-length': String(response.bytes.length),
                'content-type': candidate.rendition.mimeType,
                'x-automontage-filename': `${candidate.provider}-${candidate.providerAssetId}.${extension}`,
              },
            });
            current(entry, body.candidateId);
            base(body);
            if (signal.aborted) throw failure('BROLL_REMOTE_ABORTED', 409);
            return registerAsset(imported);
          },
          signal,
          entry,
        );
      } finally {
        selecting = false;
      }
    },
    waitIdle() {
      return active.size
        ? new Promise((resolve) => idleWaiters.add(resolve))
        : Promise.resolve();
    },
    close() {
      closed = true;
      for (const abort of activeOwners.keys()) abort.abort();
      store.clear();
      scopes.clear();
    },
  };
}
module.exports = { createBrollDiscovery, candidateProvenance };

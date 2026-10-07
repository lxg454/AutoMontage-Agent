'use strict';
// Клиент Pixabay API (https://pixabay.com/api/docs/) для поиска B-roll: фото и видео.
// Ключ Pixabay передаётся только query-параметром key в запрос к pixabay.com/api/ без редиректов;
// в кандидатах, ошибках и кэше его нет. Правила API требуют кэшировать ответы поиска 24 часа –
// одинаковый запрос в течение суток берётся из памяти процесса, а не из сети.
const crypto = require('node:crypto');
const { requestRemote, LIMITS, failure } = require('./remote');
const {
  normalizedText, safeUrl, normalizeSearch, eligible, validDuration, selectVideoFiles, validSize, imageMime,
} = require('./search-common');
// cdn.pixabay.com – превью фото, видео и их обложки; pixabay.com/get/ – временные ссылки на фото 640/1280 px.
const IMAGE_HOSTS = Object.freeze(['cdn.pixabay.com', 'pixabay.com']);
const VIDEO_HOSTS = Object.freeze(['cdn.pixabay.com']);
const MEDIA_HOSTS = Object.freeze(['cdn.pixabay.com', 'pixabay.com']);
const PAGE_HOSTS = Object.freeze(['pixabay.com']);
const API_HOST = 'pixabay.com';
const PER_PAGE = 12;
// Ориентацию видео (и квадрат у фото) Pixabay не фильтрует: берём окно пошире и отбираем сами,
// иначе вертикальных роликов в первых 12 результатах почти не бывает. До 12 подходящих на страницу.
const WIDE_PAGE = 100;
const LARGE_SIDE = 1280;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 200;
const IMAGE_EXT = /\.(?:jpg|jpeg|png|webp)$/i;
const RENDITIONS = ['large', 'medium', 'small', 'tiny'];

function createSearchCache({ now = Date.now, ttlMs = CACHE_TTL_MS, limit = CACHE_LIMIT } = {}) {
  const entries = new Map();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (now() - entry.at >= ttlMs) { entries.delete(key); return undefined; }
      return entry.value;
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { at: now(), value });
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}
const sharedCache = createSearchCache();

// Pixabay отвечает 429 на запросы чаще примерно раза в секунду: запросы к API идут по одному,
// с паузой между ними; на 429 ждём Retry-After (не дольше 15 с) и повторяем не больше двух раз.
const MIN_GAP_MS = 1100;
const RETRIES = 2;
const DEFAULT_RETRY_SEC = 3;
const MAX_RETRY_SEC = 15;
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('BROLL_REMOTE_ABORTED'));
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(failure('BROLL_REMOTE_ABORTED')); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}
function createRequestGate({ now = Date.now, wait = sleep, minGapMs = MIN_GAP_MS } = {}) {
  let chain = Promise.resolve(), last = -Infinity;
  return function run(task, signal) {
    const turn = chain.then(async () => {
      const pause = last + minGapMs - now();
      if (pause > 0) await wait(pause, signal);
      for (let attempt = 0; ; attempt++) {
        try {
          return await task();
        } catch (error) {
          if (error?.code !== 'BROLL_REMOTE_RATE_LIMITED' || attempt >= RETRIES) throw error;
          const seconds = Math.min(error.retryAfterSec ?? DEFAULT_RETRY_SEC, MAX_RETRY_SEC);
          await wait(Math.max(seconds * 1000, minGapMs), signal);
        } finally {
          last = now();
        }
      }
    });
    chain = turn.catch(() => {});
    return turn;
  };
}
const sharedGate = createRequestGate();

// Размер largeImageURL: длинная сторона ужата до 1280 px, маленькие оригиналы не растягиваются.
function largeSize(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return null;
  const scale = Math.min(1, LARGE_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function normalizeCandidate(item, search, preferSize, videoHosts) {
  if (!Number.isSafeInteger(item?.id) || item.id <= 0) return null;
  if (!Number.isSafeInteger(item.user_id) || item.user_id <= 0) return null;
  const sourcePage = safeUrl(item.pageURL, PAGE_HOSTS, undefined, 500);
  const authorName = normalizedText(item.user, 300);
  if (!sourcePage || !authorName) return null;
  const source = new URL(sourcePage);
  if (source.search || !source.pathname.startsWith(search.mediaKind === 'image' ? '/photos/' : '/videos/'))
    return null;
  // Профиль автора строится из числового user_id, а не из текста ответа.
  const authorUrl = `https://pixabay.com/users/${item.user_id}/`;
  let rendition, thumbnailUrl, previewUrl, durationSec = null;
  if (search.mediaKind === 'image') {
    const size = largeSize(item.imageWidth, item.imageHeight);
    if (!size || !eligible(size.width, size.height, search)) return null;
    const downloadUrl = safeUrl(item.largeImageURL, IMAGE_HOSTS, IMAGE_EXT);
    thumbnailUrl = safeUrl(item.previewURL, IMAGE_HOSTS, IMAGE_EXT);
    previewUrl = safeUrl(item.webformatURL, IMAGE_HOSTS, IMAGE_EXT);
    rendition = { id: 'large', ...size, mimeType: imageMime(downloadUrl), downloadUrl };
  } else {
    durationSec = item.duration;
    if (!validDuration(durationSec, search)) return null;
    const videos = item.videos && typeof item.videos === 'object' ? item.videos : {};
    const files = RENDITIONS.map((id) => ({ id, ...videos[id], link: videos[id]?.url }))
      .filter((f) => typeof f.link === 'string' && f.link);
    const picked = selectVideoFiles(files, search, preferSize, videoHosts);
    if (!picked) return null;
    const { selected, preview } = picked;
    rendition = { id: selected.id, width: selected.width, height: selected.height, mimeType: 'video/mp4', downloadUrl: selected.link };
    thumbnailUrl = [selected, ...RENDITIONS.map((id) => videos[id])]
      .map((f) => safeUrl(f?.thumbnail, IMAGE_HOSTS, IMAGE_EXT)).find(Boolean) || null;
    previewUrl = preview?.link || null;
  }
  if (!rendition.downloadUrl || !thumbnailUrl) return null;
  const { downloadUrl, ...identity } = rendition;
  return {
    provider: 'pixabay',
    providerAssetId: String(item.id),
    sourcePage,
    author: { name: authorName, url: authorUrl },
    license: { name: 'Pixabay Content License', url: 'https://pixabay.com/service/license-summary/' },
    queryOriginal: search.queryOriginal,
    queryEnglish: search.queryEnglish,
    retrievedAt: new Date().toISOString(),
    rendition: identity,
    mediaKind: search.mediaKind,
    width: identity.width,
    height: identity.height,
    durationSec,
    hasAudio: null,
    thumbnailUrl,
    previewUrl,
    downloadUrl,
  };
}

function createPixabayProvider({
  apiKey, request = requestRemote, preferSize, videoHosts = VIDEO_HOSTS, cache = sharedCache, gate = sharedGate,
} = {}) {
  return {
    async search(input) {
      if (!apiKey) throw failure('BROLL_KEY_MISSING');
      const search = normalizeSearch(input);
      if (preferSize !== undefined && !validSize(preferSize)) throw failure('BROLL_SEARCH_INVALID');
      const url = new URL(search.mediaKind === 'image' ? 'https://pixabay.com/api/' : 'https://pixabay.com/api/videos/');
      url.searchParams.set('q', search.queryEnglish);
      url.searchParams.set('lang', 'en');
      url.searchParams.set('safesearch', 'true');
      url.searchParams.set('page', String(search.page));
      const localFilter = Boolean(search.orientation) && (search.mediaKind === 'video' || search.orientation === 'square');
      const pageSize = localFilter ? WIDE_PAGE : PER_PAGE;
      url.searchParams.set('per_page', String(pageSize));
      if (search.mediaKind === 'image') {
        url.searchParams.set('image_type', 'photo');
        // У Pixabay нет квадратной ориентации: квадрат отбирается после ответа.
        if (search.orientation === 'landscape') url.searchParams.set('orientation', 'horizontal');
        if (search.orientation === 'portrait') url.searchParams.set('orientation', 'vertical');
      } else {
        url.searchParams.set('video_type', 'film');
      }
      // Ключ кэша – адрес без ключа API плюс его хэш: разные ключи не делят ответы, сам ключ не хранится.
      const cacheKey = `${crypto.createHash('sha256').update(apiKey).digest('hex')}|${url.href}`;
      try {
        let data = cache?.get(cacheKey);
        if (!data) {
          const withKey = new URL(url.href);
          withKey.searchParams.set('key', apiKey);
          const response = await gate(() => request({
            url: withKey.href,
            allowedHosts: [API_HOST],
            headers: { Accept: 'application/json' },
            signal: search.signal,
            maxBytes: LIMITS.api,
            timeoutMs: 15000,
            expectedMimeTypes: ['application/json'],
            maxRedirects: 0,
          }), search.signal);
          data = JSON.parse(response.bytes.toString('utf8'));
          if (!data || !Array.isArray(data.hits) || !Number.isSafeInteger(data.totalHits) || data.totalHits < 0)
            throw failure();
          cache?.set(cacheKey, data);
        }
        const candidates = [], seen = new Set();
        for (const item of data.hits.slice(0, WIDE_PAGE)) {
          const candidate = normalizeCandidate(item, search, preferSize ?? null, videoHosts);
          if (candidate && !JSON.stringify(candidate).includes(apiKey) && !seen.has(candidate.providerAssetId)) {
            seen.add(candidate.providerAssetId);
            candidates.push(candidate);
          }
          if (candidates.length === PER_PAGE) break;
        }
        // Pixabay отдаёт не больше 500 результатов на запрос (totalHits).
        const nextPage = search.page < 1000 && search.page * pageSize < Math.min(data.totalHits, 500)
          ? search.page + 1 : null;
        return { candidates, nextPage };
      } catch (error) {
        throw failure(
          error?.code === 'BROLL_REMOTE_ABORTED' ? 'BROLL_REMOTE_ABORTED'
            : error?.code === 'BROLL_REMOTE_RATE_LIMITED' ? 'BROLL_RATE_LIMITED'
              : 'BROLL_PROVIDER_FAILED',
        );
      }
    },
  };
}

module.exports = {
  createPixabayProvider,
  createSearchCache,
  createRequestGate,
  IMAGE_HOSTS,
  VIDEO_HOSTS,
  MEDIA_HOSTS,
  PAGE_HOSTS,
};

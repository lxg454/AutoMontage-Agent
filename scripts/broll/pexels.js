'use strict';
const { requestRemote, LIMITS, failure } = require('./remote');
const {
  normalizedText, safeUrl, normalizeSearch, eligible, validDuration, selectVideoFiles, validSize, imageMime,
} = require('./search-common');
// Exact documented Pexels rendition hosts; undocumented redirect CDNs fail closed.
const IMAGE_HOSTS = Object.freeze([
  'images.pexels.com',
  'static-videos.pexels.com',
]);
const VIDEO_HOSTS = Object.freeze(['videos.pexels.com', 'player.vimeo.com']);
const MEDIA_HOSTS = Object.freeze([...IMAGE_HOSTS, ...VIDEO_HOSTS]);
const PAGE_HOSTS = Object.freeze(['www.pexels.com', 'pexels.com']);
function normalizeCandidate(item, search, preferSize = null, videoHosts = VIDEO_HOSTS) {
  if (!Number.isSafeInteger(item?.id) || item.id <= 0) return null;
  const sourcePage = safeUrl(item.url, PAGE_HOSTS, undefined, 500);
  const author =
    search.mediaKind === 'image'
      ? { name: item.photographer, url: item.photographer_url }
      : item.user;
  const authorUrl = safeUrl(author?.url, PAGE_HOSTS, undefined, 500);
  const authorName = normalizedText(author?.name, 300);
  if (!sourcePage || !authorUrl || !authorName) return null;
  const source = new URL(sourcePage),
    profile = new URL(authorUrl);
  if (
    source.search ||
    profile.search ||
    !source.pathname.startsWith(
      search.mediaKind === 'image' ? '/photo/' : '/video/',
    ) ||
    !profile.pathname.startsWith('/@')
  )
    return null;
  let rendition,
    thumbnailUrl,
    previewUrl,
    durationSec = null;
  if (search.mediaKind === 'image') {
    if (!eligible(item.width, item.height, search)) return null;
    const downloadUrl = safeUrl(
      item.src?.original,
      IMAGE_HOSTS,
      /\.(?:jpg|jpeg|png|webp)$/i,
    );
    thumbnailUrl = safeUrl(
      item.src?.tiny || item.src?.small,
      IMAGE_HOSTS,
      /\.(?:jpg|jpeg|png|webp)$/i,
    );
    previewUrl = safeUrl(
      item.src?.medium,
      IMAGE_HOSTS,
      /\.(?:jpg|jpeg|png|webp)$/i,
    );
    rendition = {
      id: 'original',
      width: item.width,
      height: item.height,
      mimeType: imageMime(downloadUrl),
      downloadUrl,
    };
  } else {
    durationSec = item.duration;
    if (!validDuration(durationSec, search)) return null;
    const files = (Array.isArray(item.video_files) ? item.video_files : []).filter(
      (f) => f && Number.isSafeInteger(f.id) && f.file_type === 'video/mp4',
    );
    const picked = selectVideoFiles(files, search, preferSize, videoHosts);
    if (!picked) return null;
    const { selected, preview } = picked;
    rendition = {
      id: String(selected.id),
      width: selected.width,
      height: selected.height,
      mimeType: 'video/mp4',
      downloadUrl: selected.link,
    };
    thumbnailUrl =
      safeUrl(item.image, IMAGE_HOSTS, /\.(?:jpg|jpeg|png|webp)$/i) ||
      safeUrl(
        item.video_pictures?.[0]?.picture,
        IMAGE_HOSTS,
        /\.(?:jpg|jpeg|png|webp)$/i,
      );
    previewUrl = preview?.link || null;
  }
  if (!rendition.downloadUrl || !thumbnailUrl) return null;
  const { downloadUrl, ...identity } = rendition;
  return {
    provider: 'pexels',
    providerAssetId: String(item.id),
    sourcePage,
    author: { name: authorName, url: authorUrl },
    license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
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
function createPexelsProvider({ apiKey, request = requestRemote, preferSize, videoHosts = VIDEO_HOSTS } = {}) {
  return {
    async search(input) {
      if (!apiKey) throw failure('BROLL_KEY_MISSING');
      const search = normalizeSearch(input);
      if (preferSize !== undefined && !validSize(preferSize)) throw failure('BROLL_SEARCH_INVALID');
      const url = new URL(
        search.mediaKind === 'image'
          ? 'https://api.pexels.com/v1/search'
          : 'https://api.pexels.com/v1/videos/search',
      );
      url.searchParams.set('query', search.queryEnglish);
      url.searchParams.set('page', String(search.page));
      url.searchParams.set('per_page', '12');
      if (search.orientation)
        url.searchParams.set('orientation', search.orientation);
      try {
        const response = await request({
          url: url.href,
          allowedHosts: ['api.pexels.com'],
          headers: { Authorization: apiKey, Accept: 'application/json' },
          signal: search.signal,
          maxBytes: LIMITS.api,
          timeoutMs: 15000,
          expectedMimeTypes: ['application/json'],
          maxRedirects: 0,
        });
        const data = JSON.parse(response.bytes.toString('utf8'));
        const items = data[search.mediaKind === 'image' ? 'photos' : 'videos'];
        if (!Array.isArray(items)) throw failure();
        const candidates = [],
          seen = new Set();
        for (const item of items.slice(0, 80)) {
          const candidate = normalizeCandidate(item, search, preferSize ?? null, videoHosts);
          if (
            candidate &&
            !JSON.stringify(candidate).includes(apiKey) &&
            !seen.has(candidate.providerAssetId)
          ) {
            seen.add(candidate.providerAssetId);
            candidates.push(candidate);
          }
          if (candidates.length === 12) break;
        }
        let nextPage = null;
        const next = safeUrl(data.next_page, ['api.pexels.com']);
        if (next) {
          const parsed = new URL(next);
          if (
            parsed.pathname === url.pathname &&
            Number(parsed.searchParams.get('page')) === search.page + 1 &&
            search.page < 1000
          )
            nextPage = search.page + 1;
        }
        return { candidates, nextPage };
      } catch (error) {
        throw failure(
          error?.code === 'BROLL_REMOTE_ABORTED'
            ? 'BROLL_REMOTE_ABORTED'
            : error?.code === 'BROLL_REMOTE_RATE_LIMITED'
              ? 'BROLL_RATE_LIMITED'
              : 'BROLL_PROVIDER_FAILED',
        );
      }
    },
  };
}
module.exports = {
  createPexelsProvider,
  normalizeSearch,
  IMAGE_HOSTS,
  VIDEO_HOSTS,
  MEDIA_HOSTS,
  PAGE_HOSTS,
};

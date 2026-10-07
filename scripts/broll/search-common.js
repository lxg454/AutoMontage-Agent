'use strict';
// Общие для всех провайдеров стока правила: проверка запроса, безопасные ссылки и выбор рендишна видео.
// Провайдер (pexels.js, pixabay.js) только переводит ответ своего API в эти правила.
const { validateUrl, failure } = require('./remote');
const CONTROL = /[\p{Cc}\p{Cf}]/u;
function normalizedText(value, maxBytes) {
  if (typeof value !== 'string' || CONTROL.test(value)) return null;
  const normalized = value.normalize('NFKC').trim();
  return normalized && !CONTROL.test(normalized) && Buffer.byteLength(normalized, 'utf8') <= maxBytes
    ? normalized : null;
}
function safeUrl(value, hosts, extension, maxBytes = 2048) {
  try {
    if (typeof value !== 'string' || CONTROL.test(value) || Buffer.byteLength(value, 'utf8') > maxBytes) return null;
    const url = validateUrl(value, hosts);
    return Buffer.byteLength(url.href, 'utf8') <= maxBytes && (!extension || extension.test(url.pathname)) ? url.href : null;
  } catch {
    return null;
  }
}
function normalizeSearch(input) {
  const queryEnglish = normalizedText(input?.queryEnglish, 200);
  const queryOriginal = normalizedText(input?.queryOriginal, 500);
  if (
    !input ||
    !queryEnglish ||
    !queryOriginal ||
    !['image', 'video'].includes(input.mediaKind) ||
    (input.orientation &&
      !['landscape', 'portrait', 'square'].includes(input.orientation))
  )
    throw failure('BROLL_SEARCH_INVALID');
  const search = { ...input, page: input.page ?? 1 };
  for (const key of ['minDurationSec', 'minWidth', 'minHeight'])
    if (
      search[key] !== undefined &&
      (!Number.isFinite(search[key]) || search[key] < 0 || search[key] > 100000)
    )
      throw failure('BROLL_SEARCH_INVALID');
  if (!Number.isInteger(search.page) || search.page < 1 || search.page > 1000)
    throw failure('BROLL_SEARCH_INVALID');
  search.queryEnglish = queryEnglish;
  search.queryOriginal = queryOriginal;
  return search;
}
function eligible(width, height, search) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 32768 ||
    height > 32768 ||
    width < (search.minWidth || 0) ||
    height < (search.minHeight || 0)
  )
    return false;
  return (
    !search.orientation ||
    (search.orientation === 'landscape'
      ? width > height
      : search.orientation === 'portrait'
        ? height > width
        : width === height)
  );
}
const validDuration = (durationSec, search) =>
  Number.isFinite(durationSec) && durationSec > 0 && durationSec <= 1800 &&
  durationSec >= (search.minDurationSec || 0);
// files: [{ id, width, height, link }] уже с проверенным типом mp4. Возвращает выбранный файл для
// скачивания и меньший отдельный файл для предпросмотра (не больше 960 px) или null.
function selectVideoFiles(rawFiles, search, preferSize, videoHosts) {
  const files = rawFiles.filter(
    (f) =>
      f &&
      safeUrl(f.link, videoHosts, /\.mp4$/i) &&
      eligible(f.width, f.height, {}) &&
      f.width <= 4096 && f.height <= 4096 &&
      f.width * f.height <= 8847360,
  );
  const fitting = files
    .filter((f) => eligible(f.width, f.height, search))
    .sort((a, b) => b.width * b.height - a.width * a.height);
  // preferSize (слой motion-kit): самый маленький mp4, покрывающий кадр сторона к стороне; иначе самый большой.
  const covers = (f) => Math.min(f.width, f.height) >= Math.min(preferSize.width, preferSize.height)
    && Math.max(f.width, f.height) >= Math.max(preferSize.width, preferSize.height);
  const selected = (preferSize && fitting.filter(covers).at(-1)) || fitting[0];
  if (!selected) return null;
  const preview = files
    .filter(
      (f) =>
        f.link !== selected.link &&
        f.width * f.height < selected.width * selected.height &&
        f.width <= 960 &&
        f.height <= 960,
    )
    .sort((a, b) => a.width * a.height - b.width * b.height)[0];
  return { selected, preview: preview || null };
}
const validSize = (size) => size !== null && typeof size === 'object'
  && [size.width, size.height].every((side) => Number.isSafeInteger(side) && side > 0 && side <= 32768);
const imageMime = (downloadUrl) =>
  downloadUrl && /\.png$/i.test(new URL(downloadUrl).pathname)
    ? 'image/png'
    : downloadUrl && /\.webp$/i.test(new URL(downloadUrl).pathname)
      ? 'image/webp'
      : 'image/jpeg';
module.exports = {
  CONTROL,
  normalizedText,
  safeUrl,
  normalizeSearch,
  eligible,
  validDuration,
  selectVideoFiles,
  validSize,
  imageMime,
};

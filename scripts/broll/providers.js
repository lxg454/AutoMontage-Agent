'use strict';
// Реестр провайдеров стока: по config.provider выбирает клиент, его хосты и подписи.
// Review, сток слоя и живая приёмка берут провайдера только отсюда.
const pexels = require('./pexels');
const pixabay = require('./pixabay');
const { failure } = require('./remote');

const REGISTRY = Object.freeze({
  pexels: Object.freeze({
    name: 'pexels',
    label: 'Pexels',
    create: pexels.createPexelsProvider,
    imageHosts: pexels.IMAGE_HOSTS,
    videoHosts: pexels.VIDEO_HOSTS,
    // Сток слоя берёт только прямые mp4: player.vimeo.com и прочие посредники отсекаются.
    directVideoHosts: Object.freeze(['videos.pexels.com']),
    pageHosts: pexels.PAGE_HOSTS,
  }),
  pixabay: Object.freeze({
    name: 'pixabay',
    label: 'Pixabay',
    create: pixabay.createPixabayProvider,
    imageHosts: pixabay.IMAGE_HOSTS,
    videoHosts: pixabay.VIDEO_HOSTS,
    directVideoHosts: pixabay.VIDEO_HOSTS,
    pageHosts: pixabay.PAGE_HOSTS,
  }),
});
// Все хосты медиа всех провайдеров: кандидат уже прошёл проверку хостов своего провайдера,
// этот список – вторая граница при скачивании превью и выбранного файла.
const MEDIA_HOSTS = Object.freeze([...new Set(Object.values(REGISTRY)
  .flatMap((entry) => [...entry.imageHosts, ...entry.videoHosts]))]);
const PAGE_HOSTS = Object.freeze([...new Set(Object.values(REGISTRY).flatMap((entry) => entry.pageHosts))]);

function providerInfo(name) {
  if (!Object.hasOwn(REGISTRY, name)) throw failure('BROLL_PROVIDER_UNSUPPORTED');
  return REGISTRY[name];
}
function createSearchProvider(config, options = {}) {
  return providerInfo(config?.provider).create({ ...options, apiKey: config.apiKey });
}
module.exports = { REGISTRY, MEDIA_HOSTS, PAGE_HOSTS, providerInfo, createSearchProvider };

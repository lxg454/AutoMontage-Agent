const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPixabayProvider: createReal, createSearchCache, createRequestGate } = require('../scripts/broll/pixabay');
// Без настоящих пауз: очередь запросов проверяется отдельно в конце файла.
const instantGate = () => createRequestGate({ wait: async () => {}, minGapMs: 0 });
const createPixabayProvider = (options) => createReal({ gate: instantGate(), ...options });
const { validateProvenance } = require('../scripts/broll/provenance');
const { failure } = require('../scripts/broll/remote');

// Форма ответа – как у настоящего Pixabay API (фото и видео), без сети.
const KEY = 'fixture-pixabay-secret';
const photo = {
  id: 2592859,
  pageURL: 'https://pixabay.com/photos/bokeh-lights-wet-gutter-2592859/',
  type: 'photo',
  previewURL: 'https://cdn.pixabay.com/photo/2017/08/06/14/12/bokeh-lights-2592859_150.jpg',
  webformatURL: 'https://pixabay.com/get/g7473e5f0_640.jpg',
  largeImageURL: 'https://pixabay.com/get/g5debb0ef_1280.jpg',
  imageWidth: 3980,
  imageHeight: 4975,
  user_id: 894430,
  user: 'StockSnap',
};
const rendition = (name, width, height) => ({
  url: `https://cdn.pixabay.com/video/2024/05/18/212404_${name}.mp4`,
  width, height, size: 1000,
  thumbnail: `https://cdn.pixabay.com/video/2024/05/18/212404_${name}.jpg`,
});
const video = {
  id: 212404,
  pageURL: 'https://pixabay.com/videos/id-212404/',
  type: 'film',
  duration: 12,
  videos: {
    large: rendition('large', 2160, 1440),
    medium: rendition('medium', 1620, 1080),
    small: rendition('small', 1080, 720),
    tiny: rendition('tiny', 810, 540),
  },
  user_id: 21058920,
  user: '素君',
};
const search = { queryOriginal: 'огни города', queryEnglish: 'city lights', mediaKind: 'image' };
const reply = (body) => ({ bytes: Buffer.from(JSON.stringify(body)) });
const provider = (hits, options = {}) => {
  const calls = [];
  const instance = createPixabayProvider({
    apiKey: KEY,
    cache: createSearchCache(),
    request: async (req) => { calls.push(req); return reply({ totalHits: 500, hits }); },
    ...options,
  });
  return { instance, calls };
};
const provenanceOf = (c) => Object.fromEntries(['provider', 'providerAssetId', 'sourcePage', 'author', 'license',
  'queryOriginal', 'queryEnglish', 'retrievedAt', 'rendition'].map((k) => [k, c[k]]));

test('missing key is a typed error before any request', async () => {
  await assert.rejects(createPixabayProvider({ request: () => assert.fail('no request') }).search(search), { code: 'BROLL_KEY_MISSING' });
});

test('photo search: documented endpoint, key only in the API URL, no redirects, safe search', async () => {
  const { instance, calls } = provider([photo]);
  const { candidates, nextPage } = await instance.search({ ...search, orientation: 'portrait' });
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://pixabay.com/api/');
  assert.equal(url.searchParams.get('key'), KEY);
  assert.equal(url.searchParams.get('q'), 'city lights');
  assert.equal(url.searchParams.get('image_type'), 'photo');
  assert.equal(url.searchParams.get('orientation'), 'vertical');
  assert.equal(url.searchParams.get('safesearch'), 'true');
  assert.equal(url.searchParams.get('per_page'), '12');
  assert.deepEqual(calls[0].allowedHosts, ['pixabay.com']);
  assert.equal(calls[0].maxRedirects, 0);
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(candidates.length, 1);
  assert.equal(nextPage, 2);
  const [c] = candidates;
  assert.equal(c.provider, 'pixabay');
  assert.equal(c.providerAssetId, '2592859');
  // largeImageURL – длинная сторона 1280 px.
  assert.deepEqual([c.width, c.height, c.rendition.id, c.rendition.mimeType], [1024, 1280, 'large', 'image/jpeg']);
  assert.equal(c.downloadUrl, photo.largeImageURL);
  assert.equal(c.thumbnailUrl, photo.previewURL);
  assert.equal(c.previewUrl, photo.webformatURL);
  assert.deepEqual(c.author, { name: 'StockSnap', url: 'https://pixabay.com/users/894430/' });
  assert.equal(c.license.name, 'Pixabay Content License');
  assert.ok(!JSON.stringify(c).includes(KEY));
  assert.doesNotThrow(() => validateProvenance(provenanceOf(c)));
});

test('square orientation is filtered locally because Pixabay has no square filter', async () => {
  const square = { ...photo, id: 7, pageURL: 'https://pixabay.com/photos/square-7/', imageWidth: 2000, imageHeight: 2000 };
  const { instance, calls } = provider([photo, square]);
  const { candidates } = await instance.search({ ...search, orientation: 'square' });
  assert.equal(new URL(calls[0].url).searchParams.get('orientation'), null);
  assert.deepEqual(candidates.map((c) => c.providerAssetId), ['7']);
  assert.deepEqual([candidates[0].width, candidates[0].height], [1280, 1280]);
});

test('hostile hosts, query strings, wrong page kinds and bad ids are dropped', async () => {
  const hostile = [
    { ...photo, id: 1, pageURL: 'https://evil.example/photos/x-1/' },
    { ...photo, id: 2, largeImageURL: 'https://evil.example/get/x_1280.jpg' },
    { ...photo, id: 3, previewURL: 'https://127.0.0.1/x.jpg' },
    { ...photo, id: 4, pageURL: 'https://pixabay.com/photos/x-4/?ref=1' },
    { ...photo, id: 5, pageURL: 'https://pixabay.com/videos/x-5/' },
    { ...photo, id: -1 },
    { ...photo, id: 6, user_id: 'x' },
    { ...photo, id: 8, user: 'Author‮' },
    { ...photo, id: 9, largeImageURL: 'http://pixabay.com/get/x_1280.jpg' },
  ];
  const { instance } = provider(hostile);
  assert.deepEqual((await instance.search(search)).candidates, []);
});

test('video search: largest rendition by default, smallest distinct preview, thumbnail from cdn', async () => {
  const { instance, calls } = provider([video]);
  const [c] = (await instance.search({ ...search, mediaKind: 'video', orientation: 'landscape', minDurationSec: 10 })).candidates;
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/api/videos/');
  assert.equal(url.searchParams.get('video_type'), 'film');
  assert.equal(url.searchParams.get('orientation'), null);
  assert.deepEqual([c.rendition.id, c.width, c.height], ['large', 2160, 1440]);
  assert.equal(c.downloadUrl, video.videos.large.url);
  assert.equal(c.previewUrl, video.videos.tiny.url);
  assert.equal(c.thumbnailUrl, video.videos.large.thumbnail);
  assert.equal(c.durationSec, 12);
  assert.equal(c.author.url, 'https://pixabay.com/users/21058920/');
  assert.doesNotThrow(() => validateProvenance(provenanceOf(c)));
});

test('video filters: orientation, duration, missing renditions and foreign hosts', async () => {
  const empty = { ...video, id: 2, videos: { large: { url: '', width: 0, height: 0, thumbnail: '' }, tiny: { ...video.videos.tiny, url: 'https://evil.example/a.mp4' } } };
  const { instance } = provider([video, empty]);
  assert.deepEqual((await instance.search({ ...search, mediaKind: 'video', orientation: 'portrait' })).candidates, []);
  assert.deepEqual((await instance.search({ ...search, mediaKind: 'video', minDurationSec: 13 })).candidates, []);
  assert.deepEqual((await instance.search({ ...search, mediaKind: 'video' })).candidates.map((c) => c.providerAssetId), ['212404']);
});

test('preferSize picks the smallest rendition that still covers the layer frame', async () => {
  const { instance } = provider([video], { preferSize: { width: 1000, height: 600 } });
  const [c] = (await instance.search({ ...search, mediaKind: 'video' })).candidates;
  assert.equal(c.rendition.id, 'small');
});

test('identical searches are served from the 24 h cache; key is not part of the cache entry', async () => {
  let now = 0;
  const cache = createSearchCache({ now: () => now });
  const { instance, calls } = provider([photo], { cache });
  await instance.search(search);
  await instance.search(search);
  assert.equal(calls.length, 1);
  await instance.search({ ...search, page: 2 });
  assert.equal(calls.length, 2);
  now = 24 * 60 * 60 * 1000;
  await instance.search(search);
  assert.equal(calls.length, 3);
  // Другой ключ не берёт чужие ответы из кэша.
  const other = createPixabayProvider({ apiKey: 'another-key', cache, request: async (req) => { calls.push(req); return reply({ totalHits: 1, hits: [photo] }); } });
  await other.search(search);
  assert.equal(calls.length, 4);
});

test('pagination stops at the 500-result window of Pixabay', async () => {
  const { instance } = provider([photo]);
  assert.equal((await instance.search({ ...search, page: 41 })).nextPage, 42);
  assert.equal((await instance.search({ ...search, page: 42 })).nextPage, null);
  const few = createPixabayProvider({ apiKey: KEY, cache: null, request: async () => reply({ totalHits: 3, hits: [photo] }) });
  assert.equal((await few.search(search)).nextPage, null);
});

test('SECURITY: errors never echo the key or body; 429 becomes BROLL_RATE_LIMITED; bad JSON is a provider failure', async () => {
  const run = (request) => createPixabayProvider({ apiKey: KEY, cache: null, request }).search(search);
  await assert.rejects(run(async () => { throw new Error(`boom ${KEY}`); }), (e) => e.message === 'BROLL_PROVIDER_FAILED');
  await assert.rejects(run(async () => { throw failure('BROLL_REMOTE_RATE_LIMITED'); }), { code: 'BROLL_RATE_LIMITED', message: 'BROLL_RATE_LIMITED' });
  await assert.rejects(run(async () => { throw failure('BROLL_REMOTE_ABORTED'); }), { code: 'BROLL_REMOTE_ABORTED' });
  await assert.rejects(run(async () => ({ bytes: Buffer.from('[ERROR 400] key') })), { code: 'BROLL_PROVIDER_FAILED' });
  await assert.rejects(run(async () => reply({ hits: 'x', totalHits: 1 })), { code: 'BROLL_PROVIDER_FAILED' });
});

test('SECURITY: a payload that echoes the key in metadata is dropped', async () => {
  const { instance } = provider([{ ...photo, user: KEY }]);
  assert.deepEqual((await instance.search(search)).candidates, []);
});

test('gate sends API requests one at a time with a minimum gap', async () => {
  let clock = 0, active = 0, maxActive = 0;
  const waits = [];
  const gate = createRequestGate({ now: () => clock, minGapMs: 1100, wait: async (ms) => { waits.push(ms); clock += ms; } });
  const task = async () => { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return 'ok'; };
  assert.deepEqual(await Promise.all([gate(task), gate(task), gate(task)]), ['ok', 'ok', 'ok']);
  assert.equal(maxActive, 1);
  assert.deepEqual(waits, [1100, 1100]);
});

test('gate retries 429 after Retry-After (capped), then gives up with the rate-limit code', async () => {
  const waits = [];
  const gate = createRequestGate({ now: () => 0, minGapMs: 0, wait: async (ms) => { waits.push(ms); } });
  let calls = 0;
  const flaky = async () => { calls++; if (calls < 3) throw Object.assign(failure('BROLL_REMOTE_RATE_LIMITED'), { retryAfterSec: calls === 1 ? 4 : 60 }); return 'ok'; };
  assert.equal(await gate(flaky), 'ok');
  assert.deepEqual(waits, [4000, 15000]);
  calls = 0; waits.length = 0;
  const always = async () => { calls++; throw failure('BROLL_REMOTE_RATE_LIMITED'); };
  await assert.rejects(gate(always), { code: 'BROLL_REMOTE_RATE_LIMITED' });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [3000, 3000]);
  // Другие ошибки не повторяются, а очередь после ошибки продолжает работать.
  calls = 0;
  await assert.rejects(gate(async () => { calls++; throw failure('BROLL_REMOTE_REJECTED'); }), { code: 'BROLL_REMOTE_REJECTED' });
  assert.equal(calls, 1);
  assert.equal(await gate(async () => 'next'), 'next');
});

test('a cancelled search stops waiting in the queue', async () => {
  const gate = createRequestGate({ now: () => 0, minGapMs: 0 });
  const controller = new AbortController();
  const pending = gate(async () => { throw failure('BROLL_REMOTE_RATE_LIMITED'); }, controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { code: 'BROLL_REMOTE_ABORTED' });
});

test('video orientation and square photos ask for a wide window and keep at most 12 fitting results', async () => {
  const portrait = (id) => ({ ...video, id, pageURL: `https://pixabay.com/videos/id-${id}/`,
    videos: { large: rendition('large', 1080, 1920), tiny: rendition('tiny', 360, 640) } });
  const hits = [video, ...Array.from({ length: 20 }, (_, i) => portrait(1000 + i))];
  const { instance, calls } = provider(hits);
  const { candidates, nextPage } = await instance.search({ ...search, mediaKind: 'video', orientation: 'portrait' });
  assert.equal(new URL(calls[0].url).searchParams.get('per_page'), '100');
  assert.equal(candidates.length, 12);
  assert.ok(candidates.every((c) => c.height > c.width));
  assert.equal(nextPage, 2);
  await instance.search({ ...search, mediaKind: 'video' });
  assert.equal(new URL(calls[1].url).searchParams.get('per_page'), '12');
  await instance.search({ ...search, orientation: 'square' });
  assert.equal(new URL(calls[2].url).searchParams.get('per_page'), '100');
  assert.equal((await instance.search({ ...search, mediaKind: 'video', orientation: 'portrait', page: 5 })).nextPage, null);
});

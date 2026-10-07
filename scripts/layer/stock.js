// automontage layer stock – сток Pexels или Pixabay в слой: поиск тем же клиентом, что B-roll discovery
// в Review (scripts/broll/providers.js, requestRemote с разрешёнными хостами и лимитом размера), обрезка и
// кадрирование под слой без звука в public/stock/<провайдер>-<id>.mp4 и строка источника в public/SOURCE.md.
// Ключ PEXELS_API_KEY или PIXABAY_API_KEY необязателен: без него команда объясняет, как положить клип вручную.
// Ключ читается локально (окружение, затем .env движка) и никуда, кроме запроса к API своего стока,
// не попадает: ни в сообщения, ни в SOURCE.md, ни на CDN с видео.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadBrollConfig, KEYS } = require('../broll/config');
const { createSearchProvider, providerInfo } = require('../broll/providers');
const { validateProvenance } = require('../broll/provenance');
const { LIMITS, requestRemote } = require('../broll/remote');
const { probeVideo } = require('../media-probe');
const { buildLayerManifest } = require('../motion-kit-node');
const { runTool } = require('../process');
const { formatNumber, markdownCell, readLayerJson, resolveLayer, sha256File } = require('./common');

const ENGINE_ROOT = path.join(__dirname, '..', '..');
const FLAGS = { 'project-dir': 'value', layer: 'value', query: 'value', 'query-original': 'value', sec: 'value', insert: 'value', pick: 'value', list: 'bool' };
const DEFAULT_SEC = 2.5;
const MIN_SEC = 0.5;
const MAX_SEC = 60;
const ASSET_ID = /^[1-9]\d{0,19}$/u;
const MANUAL = 'выберите другой --pick или положите клип вручную в public/stock/';

// Коды ошибок scripts/broll/* – по-русски и без подробностей ответа: в них никогда нет ключа.
// label – имя стока для сообщений; до чтения настроек провайдер ещё не известен.
const messages = (label = 'Сток') => ({
  BROLL_CONFIG_INVALID: 'PIXABAY_API_KEY, PEXELS_API_KEY или .env движка неверного вида (пробелы, управляющие символы, файл больше 64 КБ) – проверьте запись; значение ключа не показываем',
  BROLL_PROVIDER_UNSUPPORTED: 'BROLL_SEARCH_PROVIDER: поддерживаются pexels и pixabay',
  BROLL_SEARCH_INVALID: '--query и --query-original: пустой, слишком длинный или со служебными символами запрос',
  BROLL_PROVIDER_FAILED: `${label} не ответил или отказал (ключ, лимит запросов или сеть) – повторите позже или положите клип вручную`,
  BROLL_RATE_LIMITED: `${label} просит подождать: слишком много запросов подряд – повторите через минуту`,
  BROLL_REMOTE_TIMEOUT: `${label} не ответил вовремя – повторите позже, ${MANUAL}`,
  BROLL_REMOTE_ABORTED: `запрос к ${label} прерван`,
  BROLL_REMOTE_REJECTED: `скачать клип не вышло (чужой хост, не video/mp4, больше 256 МБ или обрыв) – ${MANUAL}`,
});
// Ошибка без известного кода (чужой провайдер, сбой внутри запроса) – общее русское сообщение: сырой текст
// мог бы унести ключ или ответ сервера. Исходник остаётся в cause для отладки.
function explain(error, prefix, label) {
  const table = messages(label);
  const known = typeof error?.code === 'string' && Object.hasOwn(table, error.code);
  return new Error(`${prefix}${known ? table[error.code] : `неожиданная ошибка – повторите позже, ${MANUAL}`}`, { cause: error });
}

// Сторож ключа: короткий «ключ» совпал бы с любым текстом, поэтому только от 8 символов.
const leaks = (text, apiKey) => typeof apiKey === 'string' && apiKey.length >= 8 && String(text).includes(apiKey);

// Длина клипа: явный --sec, иначе длина вставки --insert (вверх до 0,1 с), иначе 2,5 с.
function clipSeconds(options, layerDir, buildManifest) {
  let insertSec = null;
  if (options.insert !== undefined) {
    const manifest = buildManifest(layerDir);
    const stocks = manifest.inserts.filter((i) => i.kind === 'stock');
    const insert = stocks.find((i) => i.id === options.insert);
    if (!insert) {
      throw new Error(`вставки ${options.insert} нет среди stock-вставок plan.js: ${stocks.map((i) => i.id).join(', ') || 'их нет – добавьте { kind: \'stock\' } в inserts'}`);
    }
    insertSec = Math.ceil(((insert.to - insert.from) / manifest.fps) * 10 - 1e-9) / 10;
  }
  if (options.sec !== undefined) {
    const sec = Number(options.sec);
    if (!/^\d+(\.\d+)?$/u.test(options.sec) || !(sec >= MIN_SEC) || sec > MAX_SEC) {
      throw new Error(`--sec: число секунд от ${formatNumber(MIN_SEC)} до ${MAX_SEC}`);
    }
    return { sec, insertSec };
  }
  return { sec: insertSec === null ? DEFAULT_SEC : Math.min(insertSec, MAX_SEC), insertSec };
}

function loadConfig(env, root, { layerName, layer, sec }) {
  try {
    return loadBrollConfig({ env, root: root ?? undefined });
  } catch (error) {
    if (error?.code !== 'BROLL_KEY_MISSING') throw explain(error, '');
    throw new Error([
      'Ключ стока (PIXABAY_API_KEY или PEXELS_API_KEY) не задан – поиск стока необязателен, монтаж работает и без него.',
      `Без ключа: положите свой клип (mp4, ${layer.width}×${layer.height}, не короче ${formatNumber(sec)} с) в ${layerName}/public/stock/,`,
      'пропишите его src во вставке { kind: \'stock\' } в src/plan.js и добавьте строку в public/SOURCE.md',
      '(файл | лицензия, автор | ссылка на источник | SHA-256).',
      'С ключом: добавьте PIXABAY_API_KEY или PEXELS_API_KEY в окружение или в .env движка и повторите команду.',
    ].join(' '));
  }
}

// Прямая https-ссылка на mp4 разрешённого хоста – только такие кандидаты попадают в --list и --pick.
function isDirect(candidate, hosts) {
  let url;
  try { url = new URL(candidate?.downloadUrl); } catch { return false; }
  return url.protocol === 'https:' && !url.port && !url.username && !url.password
    && hosts.includes(url.hostname) && /\.mp4$/iu.test(url.pathname);
}

// Те же девять полей provenance, что candidateProvenance в scripts/review/broll-discovery.js
// собирает для Review: слой их проверяет напрямую через validateProvenance (scripts/broll/provenance),
// а не через Review-модуль – код слоя не должен зависеть от кода Review.
const PROVENANCE_KEYS = ['provider', 'providerAssetId', 'sourcePage', 'author', 'license', 'queryOriginal', 'queryEnglish', 'retrievedAt', 'rendition'];

// id идёт в имя файла, поэтому только цифры; источник, автор и лицензия – тем же контрактом provenance,
// что у B-roll в Review (https-адреса, NFKC-текст без управляющих символов, рендишн).
function assertCandidate(candidate, info) {
  let provenance = null;
  try { provenance = validateProvenance(Object.fromEntries(PROVENANCE_KEYS.map((key) => [key, candidate[key]]))); } catch { provenance = null; }
  const onSite = (url) => info.pageHosts.includes(new URL(url).hostname);
  if (!provenance || provenance.provider !== info.name || !ASSET_ID.test(provenance.providerAssetId)
    || !onSite(provenance.sourcePage) || !onSite(provenance.author.url)) {
    throw new Error(`кандидат ${info.label} без числового id или с неверными источником, автором или лицензией – выберите другой --pick`);
  }
  return provenance;
}

// Адрес внутри Markdown-ссылки: скобки закодированы, чтобы не закрыть ссылку раньше времени.
const linkUrl = (url) => markdownCell(url).replace(/\(/gu, '%28').replace(/\)/gu, '%29');
const linkText = (text) => markdownCell(text).replace(/[[\]]/gu, '\\$&');

// Папки назначения – настоящие папки слоя, не симлинки наружу.
function realDir(dir, label) {
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Error(`${label} должна быть папкой, а не симлинком или файлом`);
  if (!stat) fs.mkdirSync(dir);
}

// mp4 начинается с бокса ftyp: HTML-страница ошибки или пустой ответ с типом video/mp4 сюда не пройдут.
const looksLikeMp4 = (bytes) => Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.length <= LIMITS.video
  && bytes.subarray(4, 8).toString('latin1') === 'ftyp';

// Любая ошибка команды проходит через сторож ключа: значения PEXELS_API_KEY и PIXABAY_API_KEY не уходят в сообщение.
async function run(options, deps = {}) {
  const env = deps.env || process.env;
  try {
    return await fetchStock(options, deps, env);
  } catch (error) {
    let message = String(error?.message);
    for (const key of Object.values(KEYS).map((name) => env[name])) {
      if (leaks(message, key)) message = message.split(key).join('***');
    }
    if (message === String(error?.message)) throw error;
    throw new Error(message);
  }
}

async function fetchStock(options, deps, env) {
  const log = deps.log || console.log;
  const root = Object.hasOwn(deps, 'root') ? deps.root : ENGINE_ROOT;
  const { layerDir, layerName } = resolveLayer(options);
  if (!options.query) throw new Error('нужен --query (английский запрос для стока)');
  const pick = options.pick === undefined ? 1 : Number(options.pick);
  if (!Number.isSafeInteger(pick) || pick < 1 || !/^\d+$/u.test(String(options.pick ?? 1))) throw new Error('--pick: номер кандидата из --list, от 1');
  const layer = readLayerJson(layerDir);
  const { sec, insertSec } = clipSeconds(options, layerDir, deps.buildLayerManifest || buildLayerManifest);
  const config = loadConfig(env, root, { layerName, layer, sec });
  const { apiKey } = config;
  const info = providerInfo(config.provider);
  const label = info.label;
  const queryOriginal = options['query-original'] || options.query;

  // preferSize: самый маленький рендишн, покрывающий кадр слоя, – не качаем UHD ради кадра 540×960.
  // videoHosts: directVideoHosts – только прямые mp4 стока даже смотрят внутрь выбора рендишна; иначе
  // preferSize мог бы предпочесть меньший, но зеркальный (у Pexels – player.vimeo.com) файл, и весь кандидат
  // потом отсеивался бы isDirect() ниже, хотя у него был подходящий прямой файл покрупнее.
  const create = deps.createProvider || ((settings) => createSearchProvider(config, settings));
  const provider = create({ apiKey, preferSize: { width: layer.width, height: layer.height }, videoHosts: info.directVideoHosts });
  const orientation = layer.height > layer.width ? 'portrait' : layer.height < layer.width ? 'landscape' : 'square';
  let found;
  try {
    ({ candidates: found } = await provider.search({ mediaKind: 'video', queryEnglish: options.query, queryOriginal, orientation, minDurationSec: sec }));
  } catch (error) {
    throw explain(error, `поиск ${label}: `, label);
  }
  if (!Array.isArray(found) || !found.length) throw new Error(`${label} ничего не нашёл: переформулируйте --query`);
  const candidates = found.filter((c) => isDirect(c, info.directVideoHosts));
  if (!candidates.length) throw new Error(`у найденных роликов ${label} нет прямой ссылки на mp4 (${info.directVideoHosts.join(', ')}) – переформулируйте --query или положите клип вручную в public/stock/`);
  if (options.list) {
    candidates.forEach((c, i) => log(markdownCell(`${i + 1}. ${c.providerAssetId} ${c.width}×${c.height} ${c.durationSec} с – ${c.author?.name} ${c.sourcePage}`)));
    return 0;
  }
  const candidate = candidates[pick - 1];
  if (!candidate) throw new Error(`--pick вне списка 1–${candidates.length}`);
  const provenance = assertCandidate(candidate, info);

  const publicDir = path.join(layerDir, 'public');
  realDir(publicDir, 'public/');
  realDir(path.join(publicDir, 'stock'), 'public/stock/');
  const name = `${info.name}-${candidate.providerAssetId}.mp4`;
  const target = path.join(publicDir, 'stock', name);
  const exists = () => new Error(`stock/${name} уже есть (клип другой вставки) – не перезаписываем: выберите другой --pick или удалите старый файл, если он больше не нужен`);
  if (fs.existsSync(target)) throw exists();

  let response;
  try {
    // Без headers и без ключа в адресе: ключ уходит только в API стока, CDN с видео его не видит.
    response = await (deps.request || requestRemote)({ url: candidate.downloadUrl, allowedHosts: info.videoHosts,
      maxBytes: LIMITS.video, timeoutMs: 120_000, expectedMimeTypes: ['video/mp4'] });
  } catch (error) {
    throw explain(error, `скачивание клипа ${label}: `, label);
  }
  if (response?.contentType !== 'video/mp4' || !looksLikeMp4(response.bytes)) {
    throw new Error(`${label} отдал не mp4-видео (другой тип, пустой ответ или больше 256 МБ) – выберите другой --pick`);
  }

  const outDir = path.join(layerDir, 'out');
  realDir(outDir, 'out/');
  const tag = `stock-${candidate.providerAssetId}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const download = path.join(outDir, `${tag}.download.mp4`);
  const normalized = path.join(outDir, `${tag}.mp4`);
  try {
    fs.writeFileSync(download, response.bytes, { flag: 'wx' });
    let probe;
    try { probe = probeVideo(download, { stage: 'layer stock probe' }); } catch { probe = null; }
    if (!probe || probe.width > 4096 || probe.height > 4096) {
      throw new Error(`скачанный файл ${label} не читается как видео до 4096 px – выберите другой --pick`);
    }
    const { width, height, fps } = layer;
    runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', download, '-t', String(sec),
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps}`,
      '-an', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', normalized], { stage: 'layer stock normalize' });
    // COPYFILE_EXCL: файл с тем же именем, появившийся за время скачивания, не перезаписывается.
    try {
      fs.copyFileSync(normalized, target, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code === 'EEXIST') throw exists();
      throw error;
    }
  } finally {
    fs.rmSync(download, { force: true });
    fs.rmSync(normalized, { force: true });
  }

  // В SOURCE.md – измеренная длина готового клипа и отрезок исходного ролика, а не запрошенная длина.
  const duration = probeVideo(target, { stage: 'layer stock result' }).duration;
  const { license, author, sourcePage, retrievedAt, queryEnglish } = provenance;
  const total = Number.isFinite(candidate.durationSec) ? ` из ${formatNumber(candidate.durationSec)} с` : '';
  // Четыре ячейки, как шапка SOURCE.md от layer new: файл | лицензия / автор | источник | SHA-256.
  const credit = `[${linkText(license.name)}](${linkUrl(license.url)}), [${linkText(author.name)}](${linkUrl(author.url)})`;
  const origin = markdownCell(`${sourcePage}; запрос «${queryOriginal}» (${queryEnglish}, ${orientation}); получено ${retrievedAt}; 0–${formatNumber(duration)} с${total}`);
  const row = `| \`stock/${name}\` | ${credit} | ${origin} | ${sha256File(target)} |`;
  // Сторож на случай чужого провайдера: ключ не должен попасть в файл, который уходит вместе со слоем.
  if (leaks(row, apiKey)) {
    fs.rmSync(target, { force: true });
    throw new Error(`ответ ${label} содержит ключ – строка источника не записана, клип удалён`);
  }
  const sourceFile = path.join(publicDir, 'SOURCE.md');
  const header = fs.existsSync(sourceFile) ? ''
    : '# Источники материалов слоя\n\n| Файл | Лицензия / автор | Источник | SHA-256 или команда |\n|---|---|---|---|\n';
  fs.appendFileSync(sourceFile, `${header}${row}\n`);

  const where = options.insert ? `вставке ${options.insert}` : 'вставке { kind: \'stock\' }';
  log(`✅ сток stock/${name} (${formatNumber(duration)} с): поставьте src: 'stock/${name}' ${where} в src/plan.js`);
  // Ролик стока мог оказаться короче заявленного: сверяем измеренную длину с запрошенной всегда.
  if (duration < sec - 1 / layer.fps) {
    log(`⚠️ клип ${formatNumber(duration)} с короче запрошенных ${formatNumber(sec)} с – последний кадр замрёт; ${MANUAL}`);
  } else if (insertSec !== null && duration < insertSec - 1 / layer.fps) {
    log(`⚠️ клип ${formatNumber(duration)} с короче вставки ${options.insert} (${formatNumber(insertSec)} с) – последний кадр замрёт`);
  }
  return 0;
}

module.exports = { FLAGS, run };

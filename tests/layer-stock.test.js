const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { toolAvailable, runTool } = require('./helpers/media-fixtures');
const { makeLayerProject } = require('./helpers/layer-project');
const { probeVideo } = require('../scripts/media-probe');
const { failure } = require('../scripts/broll/remote');
const { hashFile } = require('../scripts/pult/files');
const newLayer = require('../scripts/layer/new');
const stock = require('../scripts/layer/stock');

// Сеть в тестах не трогаем: поиск (createProvider) и скачивание (request) – подмены; root: null – не читать
// .env движка (на машине разработчика в нём может лежать настоящий PEXELS_API_KEY).
const hasFfmpeg = toolAvailable('ffmpeg') && toolAvailable('ffprobe');
const KEY = 'not-a-real-key';
const candidate = { provider: 'pexels', providerAssetId: '12345', rendition: { id: '7', width: 1080, height: 1920, mimeType: 'video/mp4' }, sourcePage: 'https://www.pexels.com/video/12345/', author: { name: 'Автор', url: 'https://www.pexels.com/@a' },
  license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' }, width: 1080, height: 1920, durationSec: 8,
  downloadUrl: 'https://videos.pexels.com/video-files/12345/a.mp4', queryOriginal: 'люди за ноутбуком', queryEnglish: 'people laptop', retrievedAt: '2026-01-01T00:00:00.000Z' };

async function scaffold(t) {
  const project = makeLayerProject(t);
  process.env.AUTOMONTAGE_SFX_DIR = project.sfxDir;
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': project.projectDir }, { log: () => {}, warn: () => {} });
  const downloaded = path.join(project.root, 'download.mp4');
  runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30:d=4',
    '-f', 'lavfi', '-i', 'sine=duration=4', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', downloaded]);
  const layerDir = path.join(project.projectDir, 'motion-v01');
  const out = [];
  const deps = (extra = {}) => ({ env: { PEXELS_API_KEY: KEY }, root: null, log: (line) => out.push(String(line)),
    createProvider: () => ({ search: async () => ({ candidates: [candidate] }) }),
    request: async () => ({ bytes: fs.readFileSync(downloaded), contentType: 'video/mp4' }), ...extra });
  const runStock = (options = {}, extra = {}) => stock.run({ 'project-dir': project.projectDir, layer: 'motion-v01', query: 'people laptop', ...options }, deps(extra));
  const clip = path.join(layerDir, 'public', 'stock', 'pexels-12345.mp4');
  const sourceMd = () => fs.readFileSync(path.join(layerDir, 'public', 'SOURCE.md'), 'utf8');
  const leftovers = () => (fs.existsSync(path.join(layerDir, 'out')) ? fs.readdirSync(path.join(layerDir, 'out')) : []);
  return { ...project, layerDir, downloaded, out, deps, runStock, clip, sourceMd, leftovers };
}

// Ячейки строки Markdown-таблицы: экранированный \| разделителем не считается.
const cells = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/);
const audioStreams = (file) => spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim();
const lavfiClip = (file, input) => runTool('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', input, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
const countFrames = (file) => Number(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim());

test('without PEXELS_API_KEY the command explains that stock search is optional', { skip: !hasFfmpeg }, async (t) => {
  const { projectDir, layerDir } = await scaffold(t);
  const before = fs.readFileSync(path.join(layerDir, 'public', 'SOURCE.md'), 'utf8');
  await assert.rejects(stock.run({ 'project-dir': projectDir, layer: 'motion-v01', query: 'people laptop', insert: 'stock-1' }, { env: {}, root: null }),
    (error) => {
      assert.match(error.message, /PIXABAY_API_KEY или PEXELS_API_KEY\) не задан/);
      assert.match(error.message, /необязател/);
      // Как обойтись без ключа: свой клип в public/stock/ и строка источника в SOURCE.md, длина – по вставке.
      assert.match(error.message, /public\/stock\//);
      assert.match(error.message, /SOURCE\.md/);
      assert.match(error.message, /не короче 2 с/);
      return true;
    });
  assert.equal(fs.readFileSync(path.join(layerDir, 'public', 'SOURCE.md'), 'utf8'), before);
});

test('a picked Pexels clip is cropped to the layer, muted and recorded with its provenance', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, sourceMd, downloaded, leftovers } = await scaffold(t);
  let providerConfig;
  const extra = {
    createProvider: (config) => { providerConfig = config; return { search: async (input) => {
      assert.equal(input.orientation, 'portrait');
      assert.equal(input.mediaKind, 'video');
      assert.equal(input.queryEnglish, 'people laptop');
      assert.equal(input.queryOriginal, 'люди за ноутбуком');
      assert.equal(input.minDurationSec, 2);
      return { candidates: [candidate] };
    } }; },
    request: async (req) => {
      assert.equal(req.url, candidate.downloadUrl);
      assert.deepEqual(req.expectedMimeTypes, ['video/mp4']);
      assert.ok(req.allowedHosts.includes('videos.pexels.com'));
      assert.equal(req.headers, undefined, 'ключ не уходит на CDN');
      return { bytes: fs.readFileSync(downloaded), contentType: 'video/mp4' };
    } };
  assert.equal(await runStock({ 'query-original': 'люди за ноутбуком', sec: '2' }, extra), 0);
  assert.equal(providerConfig.apiKey, KEY);
  // Рендишн – самый маленький, что покрывает кадр слоя, а не UHD.
  assert.deepEqual(providerConfig.preferSize, { width: 540, height: 960 });
  const probe = probeVideo(clip);
  assert.deepEqual([probe.width, probe.height, probe.fps], [540, 960, 25]);
  assert.ok(Math.abs(probe.duration - 2) < 0.1);
  assert.equal(audioStreams(clip), '', 'в клипе нет звуковой дорожки');
  const source = sourceMd();
  assert.match(source, /^\| `stock\/pexels-12345\.mp4` \| \[Pexels License\]\(https:\/\/www\.pexels\.com\/license\/\), \[Автор\]\(https:\/\/www\.pexels\.com\/@a\) \| https:\/\/www\.pexels\.com\/video\/12345\/; запрос «люди за ноутбуком» \(people laptop, portrait\); получено 2026-01-01T00:00:00\.000Z; 0–2 с из 8 с \| [a-f0-9]{64} \|$/m);
  assert.ok(source.includes(hashFile(clip)), 'sha256 – от готового клипа в public/stock');
  // Строка не шире шапки: GFM молча отбросил бы лишнюю ячейку.
  const table = source.split('\n').filter((line) => line.startsWith('|'));
  const width = cells(table[0]).length;
  assert.equal(width, 4);
  for (const line of table) assert.equal(cells(line).length, width, line);
  assert.ok(!source.includes(KEY), 'ключ не попадает в SOURCE.md');
  assert.deepEqual(leftovers(), [], 'временные файлы скачивания убраны');
});

test('--insert stock-1 without --sec cuts the clip to the length of that insert', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, out } = await scaffold(t);
  let asked;
  const extra = { createProvider: () => ({ search: async (input) => { asked = input.minDurationSec; return { candidates: [candidate] }; } }) };
  assert.equal(await runStock({ insert: 'stock-1' }, extra), 0);
  // Вставка шаблона stock-1 длится 2 с (3,6–5,6 с на 6-секундном исходнике).
  assert.equal(asked, 2);
  assert.ok(Math.abs(probeVideo(clip).duration - 2) < 0.1, String(probeVideo(clip).duration));
  assert.ok(out.some((line) => /stock-1/.test(line) && /stock\/pexels-12345\.mp4/.test(line)), out.join('\n'));
});

test('BAD CASE: an unknown --insert names the stock inserts of the plan', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  await assert.rejects(runStock({ insert: 'stock-9' }), /вставки stock-9 нет.*stock-1/s);
});

test('BAD CASE: bad --sec and --pick are refused before any request', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  const never = { createProvider: () => { throw new Error('поиск не должен начаться'); } };
  await assert.rejects(runStock({ sec: '0' }, never), /--sec/);
  await assert.rejects(runStock({ sec: 'abc' }, never), /--sec/);
  await assert.rejects(runStock({ pick: '0' }, never), /--pick/);
  await assert.rejects(runStock({ query: undefined }, never), /--query/);
});

test('--list prints candidates and downloads nothing', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, out } = await scaffold(t);
  const request = async () => { throw new Error('--list ничего не скачивает'); };
  assert.equal(await runStock({ list: true }, { request }), 0);
  assert.ok(out.some((line) => line.includes('12345') && line.includes('Автор')), out.join('\n'));
  assert.ok(!fs.existsSync(clip));
});

test('BAD CASE: a second fetch of the same clip does not overwrite the existing file', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, sourceMd } = await scaffold(t);
  assert.equal(await runStock({ sec: '2' }), 0);
  const sha = hashFile(clip);
  const rows = sourceMd().split('\n').filter((line) => line.includes('pexels-12345')).length;
  await assert.rejects(runStock({ sec: '3' }), /stock\/pexels-12345\.mp4 уже есть/);
  assert.equal(hashFile(clip), sha);
  assert.equal(sourceMd().split('\n').filter((line) => line.includes('pexels-12345')).length, rows);
});

test('BAD CASE: a download that is not an mp4 video is refused and leaves nothing behind', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, sourceMd, leftovers } = await scaffold(t);
  const before = sourceMd();
  await assert.rejects(runStock({}, { request: async () => ({ bytes: Buffer.from('<html>nope</html>'), contentType: 'text/html' }) }), /не mp4/);
  await assert.rejects(runStock({}, { request: async () => ({ bytes: Buffer.from('<html>nope</html>'), contentType: 'video/mp4' }) }), /не mp4/);
  await assert.rejects(runStock({}, { request: async () => ({ bytes: Buffer.alloc(0), contentType: 'video/mp4' }) }), /не mp4/);
  assert.ok(!fs.existsSync(clip));
  assert.equal(sourceMd(), before);
  assert.deepEqual(leftovers(), []);
});

test('BAD CASE: a candidate with an unsafe id or a non-mp4 link is refused', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, layerDir } = await scaffold(t);
  const searchWith = (patch) => ({ createProvider: () => ({ search: async () => ({ candidates: [{ ...candidate, ...patch }] }) }) });
  await assert.rejects(runStock({}, searchWith({ providerAssetId: '../../evil' })), /кандидат Pexels/);
  await assert.rejects(runStock({}, searchWith({ downloadUrl: 'https://videos.pexels.com/video-files/12345/a.mov' })), /прямой ссылки на mp4/);
  await assert.rejects(runStock({}, searchWith({ sourcePage: 'https://evil.example/video/12345/' })), /кандидат Pexels/);
  await assert.rejects(runStock({}, searchWith({ author: { name: 'Автор', url: 'http://www.pexels.com/@a' } })), /кандидат Pexels/);
  assert.deepEqual(fs.readdirSync(path.join(layerDir, 'public', 'stock')), ['placeholder.mp4']);
});

test('SECURITY: provider and download failures never echo the key', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, out } = await scaffold(t);
  const failing = (code) => ({ createProvider: () => ({ search: async () => { throw failure(code); } }) });
  for (const code of ['BROLL_PROVIDER_FAILED', 'BROLL_REMOTE_TIMEOUT', 'BROLL_SEARCH_INVALID']) {
    await assert.rejects(runStock({}, failing(code)), (error) => {
      assert.ok(!error.message.includes(KEY));
      assert.doesNotMatch(error.message, /^BROLL_/);
      return true;
    });
  }
  await assert.rejects(runStock({}, { request: async () => { throw failure('BROLL_REMOTE_REJECTED'); } }), (error) => {
    assert.match(error.message, /скачать клип/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
  // Ключ с пробелами или управляющими символами – отказ без его значения.
  await assert.rejects(runStock({}, { env: { PEXELS_API_KEY: `${KEY} bad` } }), (error) => {
    assert.match(error.message, /PEXELS_API_KEY/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
  assert.ok(!out.join('\n').includes(KEY));
});

test('BAD CASE: nothing found asks to rephrase the query', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  await assert.rejects(runStock({}, { createProvider: () => ({ search: async () => ({ candidates: [] }) }) }), /ничего не нашёл/);
});

test('a download shorter than the requested length warns and records the measured segment', { skip: !hasFfmpeg }, async (t) => {
  const { root, runStock, clip, sourceMd, out } = await scaffold(t);
  const short = path.join(root, 'short.mp4');
  lavfiClip(short, 'testsrc2=s=320x240:r=30:d=1.2');
  assert.equal(await runStock({ sec: '3' }, { request: async () => ({ bytes: fs.readFileSync(short), contentType: 'video/mp4' }) }), 0);
  assert.ok(Math.abs(probeVideo(clip).duration - 1.2) < 0.05);
  assert.ok(out.some((line) => /⚠️ клип 1,2 с короче запрошенных 3 с/.test(line)), out.join('\n'));
  assert.match(sourceMd(), /; 0–1,2 с из 8 с \|/);
});

test('--insert on a 60-frame window at 30000/1001 fps asks for 2,1 s and yields 63 frames', { skip: !hasFfmpeg }, async (t) => {
  const project = makeLayerProject(t, { fps: '30000/1001' });
  process.env.AUTOMONTAGE_SFX_DIR = project.sfxDir;
  t.after(() => { delete process.env.AUTOMONTAGE_SFX_DIR; });
  await newLayer.run({ 'project-dir': project.projectDir }, { log: () => {}, warn: () => {} });
  const layerDir = path.join(project.projectDir, 'motion-v01');
  // 3,003 с и 5,005 с – ровно кадры 90 и 150: окно 60 кадров = 2,002 с → вверх до 2,1 с.
  fs.writeFileSync(path.join(layerDir, 'src', 'plan.js'), "export default function buildPlan({ face }) { return { camera: { face, shots: [{ at: 0, preset: 'W', drift: 'none' }] }, items: [], "
    + "inserts: [{ id: 'odd', kind: 'stock', from: 3.003, to: 5.005, src: 'stock/placeholder.mp4' }] }; }\n");
  const downloaded = path.join(project.root, 'download.mp4');
  lavfiClip(downloaded, 'testsrc2=s=320x240:r=30:d=4');
  let asked;
  assert.equal(await stock.run({ 'project-dir': project.projectDir, layer: 'motion-v01', query: 'people laptop', insert: 'odd' }, {
    env: { PEXELS_API_KEY: KEY }, root: null, log: () => {},
    createProvider: () => ({ search: async (input) => { asked = input.minDurationSec; return { candidates: [candidate] }; } }),
    request: async () => ({ bytes: fs.readFileSync(downloaded), contentType: 'video/mp4' }) }), 0);
  assert.equal(asked, 2.1);
  assert.equal(countFrames(path.join(layerDir, 'public', 'stock', 'pexels-12345.mp4')), 63);
});

test('an --insert longer than the --sec limit is capped at 60 s', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  let asked;
  const stop = new Error('stop after search');
  await assert.rejects(runStock({ insert: 'long' }, {
    buildLayerManifest: () => ({ fps: 25, inserts: [{ id: 'long', kind: 'stock', from: 0, to: 25 * 90 }] }),
    createProvider: () => ({ search: async (input) => { asked = input.minDurationSec; throw stop; } }) }));
  assert.equal(asked, 60);
});

test('BAD CASE: --sec under 0,5 s is refused', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  await assert.rejects(runStock({ sec: '0.4' }), /--sec.*0,5/);
});

test('only direct mp4 links of videos.pexels.com are listed and picked', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, out, layerDir } = await scaffold(t);
  const vimeo = { ...candidate, providerAssetId: '111', downloadUrl: 'https://player.vimeo.com/external/111.sd.mp4' };
  const evil = { ...candidate, providerAssetId: '222', downloadUrl: 'https://evil.example/video-files/222/a.mp4' };
  const searchWith = (list) => ({ createProvider: () => ({ search: async () => ({ candidates: list }) }) });
  assert.equal(await runStock({ list: true }, searchWith([vimeo, evil, candidate])), 0);
  assert.deepEqual(out.filter((line) => /^\d+\./.test(line)).map((line) => line.split(' ')[1]), ['12345']);
  await assert.rejects(runStock({}, searchWith([vimeo, evil])), /прямой ссылки на mp4/);
  assert.deepEqual(fs.readdirSync(path.join(layerDir, 'public', 'stock')), ['placeholder.mp4']);
  assert.equal(await runStock({ pick: '1', sec: '1' }, searchWith([vimeo, candidate])), 0);
  assert.ok(fs.existsSync(path.join(layerDir, 'public', 'stock', 'pexels-12345.mp4')));
});

test('BAD CASE: public/stock as a symlink out of the layer is refused', { skip: !hasFfmpeg }, async (t) => {
  const { root, runStock, layerDir } = await scaffold(t);
  const stockDir = path.join(layerDir, 'public', 'stock');
  fs.rmSync(stockDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'elsewhere'));
  fs.symlinkSync(path.join(root, 'elsewhere'), stockDir);
  await assert.rejects(runStock({ sec: '1' }), /public\/stock\/ должна быть папкой/);
  assert.deepEqual(fs.readdirSync(path.join(root, 'elsewhere')), []);
});

test('BAD CASE: a clip with the same id written during the download is not overwritten', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip, downloaded } = await scaffold(t);
  const request = async () => { fs.writeFileSync(clip, 'другой процесс'); return { bytes: fs.readFileSync(downloaded), contentType: 'video/mp4' }; };
  await assert.rejects(runStock({ sec: '1' }, { request }), (error) => {
    assert.match(error.message, /^stock\/pexels-12345\.mp4 уже есть/);
    assert.doesNotMatch(error.message, /EEXIST/);
    assert.ok(!error.message.includes(path.sep + 'motion-v01'), 'без абсолютных путей');
    return true;
  });
  assert.equal(fs.readFileSync(clip, 'utf8'), 'другой процесс');
});

test('SECURITY: unexpected errors become a Russian message without the key', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  const check = (error) => {
    assert.ok(!error.message.includes(KEY), error.message);
    assert.doesNotMatch(error.message, /boom/);
    assert.match(error.message, /[а-я]/);
    return true;
  };
  await assert.rejects(runStock({}, { createProvider: () => ({ search: async () => { throw new Error(`boom ${KEY}`); } }) }), check);
  await assert.rejects(runStock({}, { request: async () => { throw new TypeError(`boom ${KEY}`); } }), check);
});

test('a timeout suggests another --pick or a manual clip', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  await assert.rejects(runStock({}, { request: async () => { throw failure('BROLL_REMOTE_TIMEOUT'); } }), /--pick.*public\/stock\//s);
});

test('a short key is not mistaken for a leak in the provenance row', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, clip } = await scaffold(t);
  // «e» есть в любом адресе pexels.com: сторож ключа не должен удалить клип.
  assert.equal(await runStock({ sec: '1' }, { env: { PEXELS_API_KEY: 'e' } }), 0);
  assert.ok(fs.existsSync(clip));
});

test('layer code does not depend on Review code', () => {
  // scripts/layer/* – общий движок; scripts/review/* – только браузерный Review. Слой проверяет
  // provenance напрямую через scripts/broll/provenance, а не через scripts/review/broll-discovery.
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'layer', 'stock.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\.\/review\//);
});

test('control and format characters of the query never reach SOURCE.md', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, sourceMd } = await scaffold(t);
  assert.equal(await runStock({ sec: '1', 'query-original': 'люди\u202e за\tноутбуком | ok' }), 0);
  const row = sourceMd().split('\n').find((line) => line.includes('pexels-12345'));
  assert.doesNotMatch(row, /[\u202e\t]/u);
  // Таб – граница слов, а не мусор: он становится пробелом, а не пропадает («за ноутбуком»,
  // а не слитное «заноутбуком»).
  assert.match(row, /«люди за ноутбуком \\\| ok»/);
});

// Pixabay: тот же путь слоя, только хосты, имя файла и лицензия свои; ключ PIXABAY_API_KEY не утекает.
const pixabayCandidate = { ...candidate, provider: 'pixabay', providerAssetId: '212404',
  sourcePage: 'https://pixabay.com/videos/id-212404/', author: { name: 'Автор', url: 'https://pixabay.com/users/21058920/' },
  license: { name: 'Pixabay Content License', url: 'https://pixabay.com/service/license-summary/' },
  rendition: { id: 'small', width: 1080, height: 1920, mimeType: 'video/mp4' },
  downloadUrl: 'https://cdn.pixabay.com/video/2024/05/18/212404_small.mp4' };
const PIXABAY_KEY = 'pixabay-not-a-real-key';

test('with only PIXABAY_API_KEY a Pixabay clip lands as pixabay-<id>.mp4 with its license', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, layerDir, sourceMd, downloaded } = await scaffold(t);
  let providerConfig;
  const extra = { env: { PIXABAY_API_KEY: PIXABAY_KEY },
    createProvider: (config) => { providerConfig = config; return { search: async () => ({ candidates: [pixabayCandidate] }) }; },
    request: async (req) => {
      assert.ok(req.allowedHosts.includes('cdn.pixabay.com'));
      assert.ok(!req.allowedHosts.includes('videos.pexels.com'));
      assert.ok(!req.url.includes(PIXABAY_KEY), 'ключ не уходит на CDN');
      return { bytes: fs.readFileSync(downloaded), contentType: 'video/mp4' };
    } };
  assert.equal(await runStock({ sec: '1' }, extra), 0);
  assert.equal(providerConfig.apiKey, PIXABAY_KEY);
  assert.deepEqual(providerConfig.videoHosts, ['cdn.pixabay.com']);
  assert.ok(fs.existsSync(path.join(layerDir, 'public', 'stock', 'pixabay-212404.mp4')));
  assert.match(sourceMd(), /`stock\/pixabay-212404\.mp4` \| \[Pixabay Content License\]\(https:\/\/pixabay\.com\/service\/license-summary\/\)/);
  assert.ok(!sourceMd().includes(PIXABAY_KEY));
});

test('BAD CASE: a Pexels candidate is refused while Pixabay is the configured provider', { skip: !hasFfmpeg }, async (t) => {
  const { runStock, layerDir } = await scaffold(t);
  const extra = { env: { PIXABAY_API_KEY: PIXABAY_KEY }, createProvider: () => ({ search: async () => ({ candidates: [candidate] }) }) };
  await assert.rejects(runStock({ sec: '1' }, extra), /у найденных роликов Pixabay нет прямой ссылки на mp4/);
  assert.deepEqual(fs.readdirSync(path.join(layerDir, 'public', 'stock')), ['placeholder.mp4']);
});

test('SECURITY: PIXABAY_API_KEY never reaches an error message; rate limit is explained', { skip: !hasFfmpeg }, async (t) => {
  const { runStock } = await scaffold(t);
  const env = { PIXABAY_API_KEY: PIXABAY_KEY };
  await assert.rejects(runStock({}, { env, createProvider: () => ({ search: async () => { throw new Error(`boom ${PIXABAY_KEY}`); } }) }),
    (error) => { assert.ok(!error.message.includes(PIXABAY_KEY), error.message); return true; });
  await assert.rejects(runStock({}, { env, createProvider: () => ({ search: async () => { throw failure('BROLL_RATE_LIMITED'); } }) }),
    /Pixabay просит подождать/);
});

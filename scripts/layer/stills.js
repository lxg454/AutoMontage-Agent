// automontage layer stills – контрольные кадры слоя одним запуском: слой собирается webpack один раз,
// Chromium открывается один раз, и все кадры снимаются в нём подряд. Раньше каждый кадр был отдельным
// `npx remotion still`: заново бандл и новый браузер, 15–35 с на кадр (замер 2026-10-10, i7-8700).
// Кадры – motion-vNN/out/still-<кадр>.png, как и раньше. В очередь тяжёлых задач команда не встаёт:
// она не кодирует видео и держит процессор секунды, а не минуты.
//
// Remotion вызывается через Node API, а не CLI: API не читает .env движка вовсе (envVariables пустые),
// поэтому флаг --env-file=config/remotion-public.env здесь не нужен.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../env');
const { gpuMode } = require('../gpu');
const { includeInstalledSource, withMotionKitAlias } = require('../remotion-webpack');
const { readLayerJson, relative, resolveLayer } = require('./common');

const FLAGS = { 'project-dir': 'value', layer: 'value', frames: 'value', sec: 'value' };
const MAX_STILLS = 60;

// «30,120, 450» или секунды «1,4.5» (× fps слоя, вниз до целого кадра). Повторы убираются, порядок сохраняется.
function parseFrameList({ frames, sec }, { fps, durationInFrames }) {
  if (Boolean(frames) === Boolean(sec)) throw new Error('нужен ровно один из флагов --frames 30,120 или --sec 1,4.5');
  const raw = String(frames || sec).split(',').map((item) => item.trim()).filter(Boolean);
  if (!raw.length) throw new Error('список кадров пуст');
  const list = raw.map((item) => {
    const pattern = frames ? /^\d+$/u : /^\d+(?:\.\d+)?$/u;
    if (!pattern.test(item)) throw new Error(`${frames ? '--frames' : '--sec'}: «${item.slice(0, 20)}» – не число`);
    const frame = frames ? Number(item) : Math.floor(Number(item) * fps + 1e-6);
    if (!(frame >= 0 && frame < durationInFrames)) {
      throw new Error(`кадр ${frame} вне слоя: допустимо 0…${durationInFrames - 1}`);
    }
    return frame;
  });
  const unique = [...new Set(list)];
  if (unique.length > MAX_STILLS) throw new Error(`не больше ${MAX_STILLS} кадров за запуск (получено ${unique.length})`);
  return unique;
}

// Webpack-настройка та же, что у remotion.config.js для CLI: свой src из установленного пакета и
// псевдоним @automontage/motion-kit.
function webpackOverride(config) {
  const sourceDirectory = path.join(ROOT, 'src');
  return withMotionKitAlias(includeInstalledSource(config, sourceDirectory), path.join(sourceDirectory, 'motion-kit'));
}

// Публичный renderStill на каждый кадр поднимает свой файловый сервер с декодером OffthreadVideo и при
// закрытии синхронно удаляет его временную папку. На Windows декодер в этот момент ещё держит в ней файлы:
// rmSync ждёт повторов ~3,6 с на кадр (профиль 2026-10-10), а папка remotion-v*-assets остаётся в TEMP.
// Поэтому сервер поднимается один раз на весь запуск через RenderInternals и отдаётся каждому кадру –
// так же Remotion сам переиспользует сервер внутри renderMedia. Нет внутреннего API (другая версия
// Remotion) – обычный renderStill: медленнее, но тот же результат.
function makeStillRenderer(renderer, { serveUrl, chromiumOptions, browser }) {
  const internals = renderer.RenderInternals;
  const reusable = internals && typeof internals.prepareServer === 'function'
    && typeof internals.internalRenderStill === 'function';
  if (!reusable) {
    return {
      render: ({ composition, frame, output }) => renderer.renderStill({
        serveUrl, composition, frame, output, puppeteerInstance: browser, chromiumOptions,
        overwrite: true, logLevel: 'error', onBrowserLog: () => {},
      }),
      close: async () => {},
    };
  }
  const { NoReactInternals } = require('remotion/no-react');
  const serialize = (data) => NoReactInternals.serializeJSONWithSpecialTypes({ indent: undefined, staticBase: null, data }).serializedString;
  let serverPromise = null;
  const server = () => {
    serverPromise ||= internals.prepareServer({
      webpackConfigOrServeUrl: serveUrl, port: null, remotionRoot: ROOT, offthreadVideoThreads: 2,
      logLevel: 'error', indent: false, offthreadVideoCacheSizeInBytes: null, binariesDirectory: null,
      forceIPv4: false, sampleRate: 48000,
    });
    return serverPromise;
  };
  return {
    async render({ composition, frame, output }) {
      return internals.internalRenderStill({
        composition, browserExecutable: null, cancelSignal: null, chromiumOptions, envVariables: {},
        frame, imageFormat: 'png', indent: false, serializedInputPropsWithCustomSchema: serialize({}),
        jpegQuality: 80, onBrowserLog: null, onDownload: null, output, overwrite: true, port: null,
        puppeteerInstance: browser, scale: 1, server: await server(), serveUrl, timeoutInMilliseconds: 30_000,
        logLevel: 'error', serializedResolvedPropsWithCustomSchema: serialize(composition.props || {}),
        offthreadVideoCacheSizeInBytes: null, binariesDirectory: null, onBrowserDownload: null,
        onArtifact: null, chromeMode: 'headless-shell', offthreadVideoThreads: null,
        mediaCacheSizeInBytes: null, licenseKey: null, onLog: internals.defaultOnLog, isProduction: null,
      });
    },
    async close() {
      if (serverPromise) await (await serverPromise).closeServer(false);
    },
  };
}

async function renderStills({ entryPoint, publicDir, composition: compositionId, frames, outDir, bundleDir, remotion, log }) {
  const { bundle } = remotion.bundler;
  const { openBrowser, selectComposition } = remotion.renderer;
  const startedAt = Date.now();
  const serveUrl = await bundle({ entryPoint, publicDir, outDir: bundleDir, webpackOverride });
  const gl = gpuMode() === 'off' || process.platform !== 'win32' ? null : 'angle';
  const chromiumOptions = gl ? { gl } : {};
  const browser = await openBrowser('chrome', { logLevel: 'error', chromiumOptions });
  const renderer = makeStillRenderer(remotion.renderer, { serveUrl, chromiumOptions, browser });
  try {
    const composition = await selectComposition({ serveUrl, id: compositionId, puppeteerInstance: browser, chromiumOptions, logLevel: 'error' });
    const written = [];
    for (const frame of frames) {
      const output = path.join(outDir, `still-${frame}.png`);
      await renderer.render({ composition, frame, output });
      written.push(output);
    }
    log(`кадров: ${written.length} за ${((Date.now() - startedAt) / 1000).toFixed(1)} с`);
    return written;
  } finally {
    await renderer.close();
    await browser.close({ silent: true });
  }
}

async function run(options, deps = {}) {
  const log = deps.log || console.log;
  const { projectDir, layerDir, layerName } = resolveLayer(options);
  const layer = readLayerJson(layerDir);
  const frames = parseFrameList(options, layer);
  const outDir = path.join(layerDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.lstatSync(outDir).isDirectory()) throw new Error(`${relative(projectDir, outDir)} должна быть папкой, а не ссылкой`);
  // Бандл кладём внутрь слоя (out/.bundle) и пересобираем поверх: без outDir bundle() оставлял бы
  // remotion-webpack-bundle-* в TEMP после каждого запуска.
  const bundleDir = path.join(outDir, '.bundle');
  const remotion = deps.remotion || { bundler: require('@remotion/bundler'), renderer: require('@remotion/renderer') };
  let written;
  try {
    written = await (deps.renderStills || renderStills)({
      entryPoint: path.join(layerDir, 'src', 'index.jsx'), publicDir: path.join(layerDir, 'public'),
      composition: layer.composition, frames, outDir, bundleDir, remotion, log,
    });
  } finally {
    // В бандле копия public/ (на Windows Remotion копирует её целиком, это десятки МБ). Кэш webpack
    // живёт в node_modules/.cache, поэтому следующий запуск без этой папки не медленнее.
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
  for (const file of written) log(relative(projectDir, file));
  log(`✅ layer stills ${layerName}: ${written.length} кадр.`);
  return 0;
}

module.exports = { FLAGS, MAX_STILLS, makeStillRenderer, parseFrameList, renderStills, run, webpackOverride };

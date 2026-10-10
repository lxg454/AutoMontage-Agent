const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeLayerProject } = require('./helpers/layer-project');
const { MAX_STILLS, makeStillRenderer, parseFrameList, run } = require('../scripts/layer/stills');

const LAYER = { fps: 25, durationInFrames: 150 };

test('frame list: --frames as is, --sec times fps rounded down, duplicates dropped', () => {
  assert.deepEqual(parseFrameList({ frames: '30, 120,30,0' }, LAYER), [30, 120, 0]);
  assert.deepEqual(parseFrameList({ sec: '1,4.5,0.03,5.99' }, LAYER), [25, 112, 0, 149]);
});

test('frame list refuses both or neither flag, junk, frames outside the layer and too many frames', () => {
  assert.throws(() => parseFrameList({}, LAYER), /ровно один/);
  assert.throws(() => parseFrameList({ frames: '1', sec: '1' }, LAYER), /ровно один/);
  assert.throws(() => parseFrameList({ frames: '1.5' }, LAYER), /не число/);
  assert.throws(() => parseFrameList({ frames: '-1' }, LAYER), /не число/);
  assert.throws(() => parseFrameList({ sec: '1e3' }, LAYER), /не число/);
  assert.throws(() => parseFrameList({ frames: '150' }, LAYER), /вне слоя: допустимо 0…149/);
  assert.throws(() => parseFrameList({ sec: '6' }, LAYER), /вне слоя/);
  assert.throws(() => parseFrameList({ frames: ' , ' }, LAYER), /пуст/);
  const many = Array.from({ length: MAX_STILLS + 1 }, (_, i) => i).join(',');
  assert.throws(() => parseFrameList({ frames: many }, { fps: 25, durationInFrames: 1000 }), /не больше/);
});

test('run renders all frames of the layer in one call and removes the bundle copy afterwards', async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t, { seconds: 6 });
  const previous = process.env.AUTOMONTAGE_SFX_DIR;
  process.env.AUTOMONTAGE_SFX_DIR = sfxDir;
  t.after(() => {
    if (previous === undefined) delete process.env.AUTOMONTAGE_SFX_DIR;
    else process.env.AUTOMONTAGE_SFX_DIR = previous;
  });
  assert.equal(await require('../scripts/layer/new').run({ 'project-dir': projectDir }), 0);
  const layerDir = path.join(projectDir, 'motion-v01');
  const layer = JSON.parse(fs.readFileSync(path.join(layerDir, 'layer.json'), 'utf8'));
  const calls = [];
  const logs = [];
  const code = await run({ 'project-dir': projectDir, layer: 'motion-v01', sec: '0.5,2' }, {
    log: (line) => logs.push(line),
    remotion: {},
    renderStills: async (args) => {
      calls.push(args);
      fs.mkdirSync(args.bundleDir, { recursive: true });
      fs.writeFileSync(path.join(args.bundleDir, 'index.html'), '');
      return args.frames.map((frame) => {
        const file = path.join(args.outDir, `still-${frame}.png`);
        fs.writeFileSync(file, 'png');
        return file;
      });
    },
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1, 'one bundle and one browser for all frames');
  assert.deepEqual(calls[0].frames, [Math.floor(0.5 * layer.fps), 2 * layer.fps]);
  assert.equal(calls[0].composition, layer.composition);
  assert.equal(calls[0].entryPoint, path.join(layerDir, 'src', 'index.jsx'));
  assert.equal(calls[0].publicDir, path.join(layerDir, 'public'));
  assert.equal(calls[0].outDir, path.join(layerDir, 'out'));
  assert.equal(fs.existsSync(calls[0].bundleDir), false);
  assert.ok(logs.includes(`motion-v01/out/still-${2 * layer.fps}.png`));
});

test('the bundle copy is removed even when rendering fails', async (t) => {
  const { projectDir, sfxDir } = makeLayerProject(t, { seconds: 6 });
  const previous = process.env.AUTOMONTAGE_SFX_DIR;
  process.env.AUTOMONTAGE_SFX_DIR = sfxDir;
  t.after(() => {
    if (previous === undefined) delete process.env.AUTOMONTAGE_SFX_DIR;
    else process.env.AUTOMONTAGE_SFX_DIR = previous;
  });
  assert.equal(await require('../scripts/layer/new').run({ 'project-dir': projectDir }), 0);
  let bundleDir;
  await assert.rejects(run({ 'project-dir': projectDir, layer: 'motion-v01', frames: '1' }, {
    log: () => {}, remotion: {},
    renderStills: async (args) => {
      bundleDir = args.bundleDir;
      fs.mkdirSync(bundleDir, { recursive: true });
      throw new Error('chromium crashed');
    },
  }), /chromium crashed/);
  assert.equal(fs.existsSync(bundleDir), false);
});

test('one file server serves every frame and is closed once', async () => {
  const events = [];
  const server = { serveUrl: 'http://localhost:1', closeServer: async (force) => { events.push(`close ${force}`); } };
  const renderer = {
    RenderInternals: {
      prepareServer: async (config) => { events.push(`prepare ${config.webpackConfigOrServeUrl}`); return server; },
      internalRenderStill: async (options) => {
        assert.equal(options.server, server);
        assert.equal(options.puppeteerInstance, 'browser');
        assert.deepEqual(options.envVariables, {}, 'no engine .env reaches the browser');
        assert.equal(options.licenseKey, null);
        events.push(`frame ${options.frame}`);
      },
      defaultOnLog: () => {},
    },
    renderStill: () => assert.fail('public renderStill must not be used'),
  };
  const stills = makeStillRenderer(renderer, { serveUrl: '/bundle', chromiumOptions: {}, browser: 'browser' });
  for (const frame of [1, 2, 3]) await stills.render({ composition: { props: {} }, frame, output: `f${frame}.png` });
  await stills.close();
  assert.deepEqual(events, ['prepare /bundle', 'frame 1', 'frame 2', 'frame 3', 'close false']);
});

test('without Remotion internals every frame falls back to the public renderStill', async () => {
  const frames = [];
  const renderer = {
    renderStill: async (options) => {
      assert.equal(options.puppeteerInstance, 'browser');
      assert.equal(options.overwrite, true);
      frames.push(options.frame);
    },
  };
  const stills = makeStillRenderer(renderer, { serveUrl: '/bundle', chromiumOptions: {}, browser: 'browser' });
  await stills.render({ composition: {}, frame: 4, output: 'f4.png' });
  await stills.close();
  assert.deepEqual(frames, [4]);
});

// Настоящий Remotion (опт-ин, как tests/layer-render-still.test.js): кадр с общим сервером побайтно
// совпадает по пикселям с кадром публичного renderStill.
test('real stills through the shared server match the public renderStill pixel for pixel', {
  skip: process.env.AUTOMONTAGE_TEST_MOTION_RENDER !== '1', timeout: 300_000,
}, async (t) => {
  const { spawnSync } = require('node:child_process');
  const { projectDir, sfxDir } = makeLayerProject(t, { seconds: 6 });
  process.env.AUTOMONTAGE_SFX_DIR = sfxDir;
  assert.equal(await require('../scripts/layer/new').run({ 'project-dir': projectDir }), 0);
  assert.equal(await run({ 'project-dir': projectDir, layer: 'motion-v01', frames: '15,90' }, { log: () => {} }), 0);
  const layerDir = path.join(projectDir, 'motion-v01');
  const { bundle } = require('@remotion/bundler');
  const { openBrowser, renderStill, selectComposition } = require('@remotion/renderer');
  const { webpackOverride } = require('../scripts/layer/stills');
  const serveUrl = await bundle({ entryPoint: path.join(layerDir, 'src', 'index.jsx'), publicDir: path.join(layerDir, 'public'), webpackOverride });
  const browser = await openBrowser('chrome', { logLevel: 'error' });
  t.after(() => browser.close({ silent: true }));
  const composition = await selectComposition({ serveUrl, id: 'Layer', puppeteerInstance: browser });
  for (const frame of [15, 90]) {
    const reference = path.join(layerDir, `reference-${frame}.png`);
    await renderStill({ serveUrl, composition, frame, output: reference, puppeteerInstance: browser, overwrite: true });
    const psnr = spawnSync('ffmpeg', ['-hide_banner', '-i', reference, '-i', path.join(layerDir, 'out', `still-${frame}.png`),
      '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.match(psnr.stderr, /average:inf/, `frame ${frame} differs`);
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  FAST_LAYER_ENV, MIX_GAIN_DB, SAFE_16x9, SAFE_9x16, fadeFramesForFps,
  fastLayerCommand, fastLayerMode, planFastLayer, renderLayerOrRemotion, watermarkFilter,
} = require('../scripts/fast-layer');

const PUBLIC = path.join('/', 'lease', 'public');
const layerProbe = (overrides = {}) => ({
  width: 1080, height: 1920, fps: 30, rotation: 0, videoCodec: 'h264', pixelFormat: 'yuv420p',
  durationSec: 79.8, hasAudio: true, ...overrides,
});
const props = (scene = {}, media = {}, extra = {}) => ({
  width: 1080, height: 1920, fps: 30, durationInFrames: 2394, audioSrc: '.automontage/x/media-1.mp4',
  scenes: [{
    scene: 'broll', start: 0, end: 79.8,
    brollMedia: { kind: 'video', src: '.automontage/x/media-2.mp4', trimStartSec: 0, fit: 'cover', audioMode: 'mix', overlay: 'none', ...media },
    ...scene,
  }],
  ...extra,
});
const plan = (overrides = {}, probe = () => layerProbe()) => planFastLayer({
  composition: 'ReelScenes', props: props(), publicDir: PUBLIC, probe, env: {}, ...overrides,
});

test('constants mirror the Remotion composition they replace', () => {
  const broll = fs.readFileSync(require.resolve('../src/scenes/BrollMedia.jsx'), 'utf8');
  assert.match(broll, new RegExp(`MIX_GAIN = 10 \\*\\* \\(${MIX_GAIN_DB} / 20\\)`));
  assert.match(broll, /Math\.max\(1, Math\.round\(0\.12 \* fps\)\)/);
  assert.equal(fadeFramesForFps(30), 4);
  assert.equal(fadeFramesForFps(25), 3);
  const safe = fs.readFileSync(require.resolve('../src/scenes/safezone.js'), 'utf8');
  assert.match(safe, new RegExp(`SAFE_9x16 = \\{ top: ${SAFE_9x16.top}, bottom: \\d+, left: \\d+, right: ${SAFE_9x16.right} \\}`));
  assert.match(safe, new RegExp(`SAFE_16x9 = \\{ top: ${SAFE_16x9.top}, bottom: \\d+, left: \\d+, right: ${SAFE_16x9.right} \\}`));
  const director = fs.readFileSync(require.resolve('../src/SceneDirector.jsx'), 'utf8');
  assert.match(director, /ЧЕРНОВИК/);
  assert.match(director, /top: safe\.top,\s*right: safe\.right/);
});

test('a full-length clean kit layer is planned with voice, layer audio and its exact paths', () => {
  const { plan: result, reason } = plan();
  assert.equal(reason, null);
  assert.deepEqual(result, {
    layerPath: path.join(PUBLIC, '.automontage/x/media-2.mp4'),
    voicePath: path.join(PUBLIC, '.automontage/x/media-1.mp4'),
    fps: 30, width: 1080, height: 1920, durationInFrames: 2394, durationSec: 79.8,
    layerAudio: true, watermark: false,
  });
  assert.equal(plan({ props: props({}, {}, { draftPreview: true }) }).plan.watermark, true);
  assert.equal(plan({ props: props({}, { audioMode: 'mute' }) }).plan.layerAudio, false);
  assert.equal(plan({}, (file) => layerProbe(file.endsWith('media-1.mp4') ? { hasAudio: false } : {})).plan.voicePath, null);
});

test('anything Remotion would draw or mix differently stays on Remotion', () => {
  const cases = [
    [{ composition: 'Dynamic' }, /композиция/],
    [{ range: { kind: 'excerpt' } }, /фрагмент/],
    [{ scale: 0.5 }, /масштаб/],
    [{ props: { ...props(), scenes: [...props().scenes, ...props().scenes] } }, /не одна сцена/],
    [{ props: props({}, {}, { musicSrc: 'm.mp3' }) }, /музыка/],
    [{ props: props({}, {}, { debug: true }) }, /отладка/],
    [{ props: props({ scene: 'split' }) }, /не broll/],
    [{ props: props({ start: 1 }) }, /не на весь ролик/],
    [{ props: props({ end: 70 }) }, /не на весь ролик/],
    [{ props: props({}, { overlay: 'default' }) }, /оформление/],
    [{ props: props({}, { overlay: undefined }) }, /оформление/],
    [{ props: props({}, { kind: 'image' }) }, /оформление/],
    [{ props: props({}, { fit: 'contain' }) }, /обрезан или вписан/],
    [{ props: props({}, { trimStartSec: 2 }) }, /обрезан или вписан/],
    [{ props: props({}, { audioMode: 'replace' }) }, /звук слоя replace/],
    [{ props: props({}, { src: 'https://example.com/a.mp4' }) }, /не локальный/],
    [{ env: { [FAST_LAYER_ENV]: 'off' } }, /=off/],
  ];
  for (const [overrides, reason] of cases) {
    const result = plan(overrides);
    assert.equal(result.plan, null, String(reason));
    assert.match(result.reason, reason);
  }
  for (const [probe, reason] of [
    [{ width: 1920, height: 1080 }, /размер или FPS/],
    [{ fps: 25 }, /размер или FPS/],
    [{ rotation: 90 }, /размер или FPS/],
    [{ videoCodec: 'hevc' }, /H\.264/],
    [{ pixelFormat: 'yuv420p10le' }, /H\.264/],
    [{ durationSec: 79.7 }, /короче/],
  ]) {
    const result = plan({}, () => layerProbe(probe));
    assert.equal(result.plan, null);
    assert.match(result.reason, reason);
  }
  assert.throws(() => fastLayerMode({ [FAST_LAYER_ENV]: 'yes' }), /auto или off/);
});

test('final command copies the layer video and mixes voice with the faded layer at −18 dB', () => {
  const { plan: planned } = plan();
  const { command, args } = fastLayerCommand(planned, { output: 'raw.mp4' });
  assert.equal(command, 'ffmpeg');
  assert.deepEqual(args.slice(0, 9), ['-hide_banner', '-loglevel', 'error', '-y', '-i', planned.layerPath, '-i', planned.voicePath, '-filter_complex']);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /\[1:a\]atrim=0:79\.800000,asetpts=PTS-STARTPTS.*\[voice\]/);
  assert.match(graph, /\[0:a\]atrim=0:79\.800000.*volume=-18dB,afade=t=in:st=0:d=0\.133333,afade=t=out:st=79\.633333:d=0\.133333\[layer\]/);
  // Огибающая Remotion: последний кадр (2393) тихий, затухание начинается за fade кадров до него.
  assert.equal(((2394 - 1 - fadeFramesForFps(30)) / 30).toFixed(6), '79.633333');
  assert.match(graph, /\[voice\]\[layer\]amix=inputs=2:normalize=0:duration=first:dropout_transition=0\[aout\]/);
  assert.deepEqual(args.slice(args.indexOf('-map')), [
    '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k', '-ar', '48000',
    '-t', '79.800000', '-movflags', '+faststart', 'raw.mp4',
  ]);
});

test('draft preview burns the watermark and re-encodes; a muted layer without voice has no audio', () => {
  const { plan: draft } = plan({ props: props({}, {}, { draftPreview: true }) });
  assert.throws(() => fastLayerCommand(draft, { output: 'raw.mp4' }), /encoderArgs/);
  const { args } = fastLayerCommand(draft, { output: 'raw.mp4', encoderArgs: ['-c:v', 'h264_nvenc'] });
  assert.match(args[args.indexOf('-filter_complex') + 1], /\[0:v\]drawtext=.*ЧЕРНОВИК.*\[vout\]/);
  assert.ok(args.includes('[vout]') && args.includes('h264_nvenc') && !args.includes('copy'));
  const silent = fastLayerCommand({ ...plan().plan, voicePath: null, layerAudio: false }, { output: 'o.mp4' }).args;
  assert.equal(silent.includes('-filter_complex'), false);
  assert.equal(silent.includes('-c:a'), false);
  assert.deepEqual(silent.slice(silent.indexOf('-map')), ['-map', '0:v:0', '-c:v', 'copy', '-t', '79.800000', '-movflags', '+faststart', 'o.mp4']);
});

test('watermark sits at the top-right corner of the safe zone with the composition font size', () => {
  const portrait = watermarkFilter({ width: 1080, height: 1920 });
  assert.match(portrait, /fontsize=28:/);
  assert.match(portrait, /x=w-130-tw-17:y=250\+11$/);
  assert.match(portrait, /Onest\.ttf'/);
  assert.match(watermarkFilter({ width: 1920, height: 1080 }), /x=w-80-tw-17:y=60\+11$/);
});

test('render step: fast path returns zero audio advance, Remotion keeps its own and gets the command', () => {
  const runs = [];
  const run = (command, args, options) => runs.push({ command, args, options });
  const base = {
    composition: 'ReelScenes', publicDir: PUBLIC, output: 'raw.mp4', crf: 28, run, log: () => {},
    stage: 'preview', remotionAudioAdvanceMs: 42.5, env: {},
    remotionCommand: { command: 'npx', args: ['remotion', 'render'] },
  };
  const fast = renderLayerOrRemotion({ ...base, props: props(), probe: () => layerProbe() });
  assert.deepEqual(fast, { fast: true, reason: null, audioAdvanceMs: 0 });
  assert.equal(runs.at(-1).command, 'ffmpeg');
  assert.equal(runs.at(-1).options.stage, 'preview fast layer');

  const slow = renderLayerOrRemotion({ ...base, props: props({}, { overlay: 'default' }), probe: () => layerProbe() });
  assert.equal(slow.fast, false);
  assert.equal(slow.audioAdvanceMs, 42.5);
  assert.deepEqual(runs.at(-1).args, ['remotion', 'render']);

  const unreadable = renderLayerOrRemotion({ ...base, props: props(), probe: () => { throw new Error('ENOENT'); } });
  assert.equal(unreadable.fast, false);
  assert.match(unreadable.reason, /слой не прочитан \(ENOENT\)/);
  assert.equal(runs.at(-1).command, 'npx');

  assert.throws(() => renderLayerOrRemotion({ ...base, props: props(), env: { [FAST_LAYER_ENV]: 'bad' } }), /auto или off/);
});

test('render step: the watermarked preview encodes through the GPU helper with the preview CRF', () => {
  const calls = [];
  const gpu = {
    h264EncoderArgs: (options) => { calls.push(options); return ['-c:v', options.nvenc ? 'h264_nvenc' : 'libx264']; },
    runH264: (build, { run, stage }) => { const command = build(true); run(command.command, command.args, { stage }); },
  };
  const runs = [];
  const result = renderLayerOrRemotion({
    composition: 'ReelScenes', props: props({}, {}, { draftPreview: true }), publicDir: PUBLIC,
    output: 'raw.mp4', crf: 28, run: (command, args) => runs.push(args), log: () => {}, stage: 'preview',
    remotionAudioAdvanceMs: 42.5, remotionCommand: null, probe: () => layerProbe(), gpu, env: {},
  });
  assert.equal(result.fast, true);
  assert.deepEqual(calls, [{ crf: 28, preset: 'medium', nvenc: true }]);
  assert.ok(runs[0].includes('h264_nvenc'));
});

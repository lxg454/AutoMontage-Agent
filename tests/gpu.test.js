const test = require('node:test');
const assert = require('node:assert/strict');

const {
  detectGpu,
  gpuMode,
  h264EncoderArgs,
  nvencRemotionOverride,
  probeNvenc,
  resetGpuCache,
  runH264,
} = require('../scripts/gpu');
const { limitedRangeOverride } = require('../scripts/remotion-ffmpeg-override');
const { filterScriptCommand } = require('../scripts/trim-media');
const { finishEncodeCommand } = require('../scripts/finish');
const { concatChunksCommand } = require('../scripts/render-chunks');
const { normalizeArgs } = require('../scripts/layer/render');

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('AUTOMONTAGE_GPU: auto по умолчанию, off выключает, мусор – ошибка', () => {
  assert.equal(gpuMode({}), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: '' }), 'auto');
  assert.equal(gpuMode({ AUTOMONTAGE_GPU: ' OFF ' }), 'off');
  assert.throws(() => gpuMode({ AUTOMONTAGE_GPU: 'cuda' }), /auto или off/);
});

test('detectGpu: off не запускает пробу, auto пробует один раз и даёт ANGLE только на Windows', () => {
  resetGpuCache();
  let probes = 0;
  const probe = () => { probes += 1; return true; };
  assert.deepEqual(detectGpu({ env: { AUTOMONTAGE_GPU: 'off' }, platform: 'win32', probe }), { gl: null, nvenc: false });
  assert.equal(probes, 0);
  assert.deepEqual(detectGpu({ env: {}, platform: 'win32', ffmpeg: 'a', probe }), { gl: 'angle', nvenc: true });
  detectGpu({ env: {}, platform: 'win32', ffmpeg: 'a', probe });
  assert.equal(probes, 1, 'результат пробы кэшируется');
  assert.deepEqual(detectGpu({ env: {}, platform: 'linux', ffmpeg: 'b', probe: () => false }), { gl: null, nvenc: false });
  resetGpuCache();
});

test('probeNvenc: успех только при коде 0 без ошибки запуска', () => {
  const calls = [];
  const spawn = (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; };
  assert.equal(probeNvenc('ff', spawn), true);
  assert.equal(calls[0].command, 'ff');
  assert.equal(valueAfter(calls[0].args, '-c:v'), 'mjpeg', 'вход – JPEG, как кадры Remotion');
  assert.equal(calls[0].args[calls[0].args.lastIndexOf('-c:v') + 1], 'h264_nvenc');
  assert.ok(Buffer.isBuffer(calls[0].options.input) && calls[0].options.input.length > 100);
  assert.equal(probeNvenc('ff', () => ({ status: 1 })), false);
  assert.equal(probeNvenc('ff', () => ({ status: null, error: new Error('ENOENT') })), false);
});

test('h264EncoderArgs: x264 без изменений, NVENC со сдвигом качества по пресету и 8-битным yuv420p', () => {
  assert.deepEqual(h264EncoderArgs({ crf: 20, preset: 'veryfast' }), ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20']);
  const nv = h264EncoderArgs({ crf: 14, preset: 'medium', nvenc: true });
  assert.equal(valueAfter(nv, '-c:v'), 'h264_nvenc');
  assert.equal(valueAfter(nv, '-preset'), 'p5');
  assert.equal(valueAfter(nv, '-cq'), '17');
  assert.equal(valueAfter(h264EncoderArgs({ crf: 20, preset: 'veryfast', nvenc: true }), '-cq'), '26');
  assert.equal(valueAfter(h264EncoderArgs({ crf: 50, preset: 'ultrafast', nvenc: true }), '-cq'), '51');
  assert.equal(valueAfter(nv, '-b:v'), '0');
  assert.equal(valueAfter(nv, '-pix_fmt'), 'yuv420p');
  assert.ok(!h264EncoderArgs({ crf: 14, nvenc: true, pixFmt: false }).includes('-pix_fmt'));
  assert.throws(() => h264EncoderArgs({ crf: 0 }), /crf/);
  assert.throws(() => h264EncoderArgs({ crf: 18, preset: 'placebo2', nvenc: true }), /пресет/);
});

test('nvencRemotionOverride: libx264 Remotion → NVENC, -crf переходит в -cq (+3, как medium), остальное на месте', () => {
  const args = ['-r', '25', '-i', '-', '-c:v', 'libx264', '-colorspace:v', 'bt709', '-pix_fmt', 'yuvj420p',
    '-preset', 'faster', '-crf', '23', '-y', 'out.mp4'];
  const out = nvencRemotionOverride(args);
  assert.equal(valueAfter(out, '-c:v'), 'h264_nvenc');
  assert.equal(valueAfter(out, '-cq'), '26');
  assert.ok(!out.includes('-crf') && !out.includes('libx264'));
  assert.equal(out.filter((arg) => arg === '-preset').length, 1, 'x264-пресет убран, остался пресет NVENC');
  assert.equal(valueAfter(out, '-pix_fmt'), 'yuvj420p', 'формат пикселей задаёт Remotion');
  assert.deepEqual(out.slice(-2), ['-y', 'out.mp4']);
  assert.equal(valueAfter(nvencRemotionOverride(['-c:v', 'libx264', 'o.mp4']), '-cq'), '21', 'без -crf – дефолт Remotion 18');
  const copy = ['-i', 'a.mp4', '-c:v', 'copy', 'b.mp4'];
  assert.equal(nvencRemotionOverride(copy), copy, 'команды без libx264 не трогаются');
});

test('limited range и NVENC вместе: фильтр диапазона остаётся при подмене кодера', () => {
  const args = ['-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-y', 'out.mp4'];
  const out = nvencRemotionOverride(limitedRangeOverride({ type: 'stitcher', args }));
  assert.equal(valueAfter(out, '-vf'), 'scale=out_range=tv,format=yuv420p');
  assert.equal(valueAfter(out, '-color_range'), 'tv');
  assert.equal(valueAfter(out, '-c:v'), 'h264_nvenc');
});

test('runH264: NVENC первым, при сбое тот же шаг на libx264; без NVENC – сразу CPU', () => {
  const runs = [];
  const warnings = [];
  const build = (nvenc) => ({ command: 'ffmpeg', args: [nvenc ? 'nv' : 'cpu'] });
  const failing = (command, args, options) => {
    runs.push({ args, options });
    if (args[0] === 'nv') throw new Error('No NVENC capable devices found\nдлинный хвост');
  };
  runH264(build, { run: failing, nvenc: true, warn: (m) => warnings.push(m), stage: 'trim encode', options: { cwd: 'x' } });
  assert.deepEqual(runs.map((r) => r.args[0]), ['nv', 'cpu']);
  assert.deepEqual(runs[1].options, { cwd: 'x', stage: 'trim encode' });
  assert.match(warnings[0], /trim encode: NVENC не сработал \(No NVENC capable devices found\) – кодирую на CPU/);

  runs.length = 0;
  runH264(build, { run: failing, nvenc: false, warn: () => assert.fail('без NVENC предупреждать не о чем') });
  assert.deepEqual(runs.map((r) => r.args[0]), ['cpu']);

  const cpuError = () => { throw new Error('битый вход'); };
  assert.throws(() => runH264(build, { run: cpuError, nvenc: true, warn: () => {} }), /битый вход/);
});

test('кодеры движка на NVENC: master, proxy, нормализация слоя, финиш и склейка частей', () => {
  const master = filterScriptCommand(['in.mp4'], 'out.mp4', 'f.txt', { nvenc: true }).args;
  assert.equal(valueAfter(master, '-c:v'), 'h264_nvenc');
  assert.equal(valueAfter(master, '-cq'), '26');
  assert.equal(valueAfter(master, '-c:a'), 'aac');
  const proxy = filterScriptCommand(['in.mp4'], 'out.mp4', 'f.txt', { encoder: 'proxy', nvenc: true }).args;
  assert.equal(valueAfter(proxy, '-preset'), 'p1');
  assert.ok(proxy.includes('+faststart'));
  assert.equal(valueAfter(filterScriptCommand(['in.mp4'], 'o.mp4', 'f.txt').args, '-c:v'), 'libx264', 'по умолчанию CPU');

  const layer = normalizeArgs('raw.mp4', 'out.mp4', 48000, { nvenc: true });
  assert.equal(valueAfter(layer, '-vf'), 'scale=out_range=tv,format=yuv420p');
  assert.equal(valueAfter(layer, '-cq'), '17');
  assert.equal(valueAfter(normalizeArgs('raw.mp4', 'out.mp4', 48000), '-crf'), '14');

  const options = { hdrMode: 'off', sharpen: true, lanczos: null, audioAdvanceMs: 0 };
  const finish = finishEncodeCommand('in.mp4', 'out.mp4', options, false, { nvenc: true }).args;
  assert.equal(valueAfter(finish, '-c:v'), 'h264_nvenc');
  assert.equal(finish.filter((arg) => arg === '-pix_fmt').length, 1);
  const copy = finishEncodeCommand('in.mp4', 'out.mp4', { ...options, sharpen: false }, false, { nvenc: true }).args;
  assert.equal(valueAfter(copy, '-c:v'), 'copy', 'без фильтров видео копируется и на GPU-машине');

  const concat = concatChunksCommand(['a.mp4', 'b.mp4'], 'out.mp4', { nvenc: true }).args;
  assert.equal(valueAfter(concat, '-c:v'), 'h264_nvenc');
  assert.equal(valueAfter(concat, '-pix_fmt'), 'yuv420p');
});

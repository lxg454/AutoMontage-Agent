// Ускорение на видеокарте: GPU Chromium для Remotion и аппаратный H.264 (NVENC) для ffmpeg.
// AUTOMONTAGE_GPU=auto (по умолчанию) – пробуем, при неудаче остаёмся на CPU; off – только CPU.
// NVENC проверяется коротким пробным кодированием: наличие h264_nvenc в списке кодеров ещё не значит,
// что есть видеокарта NVIDIA и драйвер. Результат кэшируется на процесс.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const GPU_ENV = 'AUTOMONTAGE_GPU';
const MODES = new Set(['auto', 'off']);
const NVENC = 'h264_nvenc';

function gpuMode(env = process.env) {
  const raw = env[GPU_ENV];
  if (raw === undefined || raw === '') return 'auto';
  const mode = String(raw).trim().toLowerCase();
  if (!MODES.has(mode)) throw new Error(`${GPU_ENV} принимает только auto или off (получено «${String(raw).slice(0, 20)}»)`);
  return mode;
}

// Один чёрный JPEG 256×256 через stdin (image2pipe, как подаёт кадры Remotion): в ffmpeg Remotion нет
// ни фильтра color, ни демультиплексора rawvideo.
const PROBE_FRAME = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEsAAQEAAAAAAAAAAAAAAAAAAAAIAQEAAAAAAAAAAAAAAAAAAAAAEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgBAAEAAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8An8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH//2Q==', 'base64');

function probeNvenc(ffmpeg = 'ffmpeg', spawn = spawnSync) {
  const result = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg',
    '-i', 'pipe:0', '-frames:v', '1', '-c:v', NVENC, '-f', 'null', '-'],
  { input: PROBE_FRAME, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, timeout: 15000 });
  return result.status === 0 && !result.error;
}

const cache = new Map();

// { gl, nvenc }: gl – значение --gl для Chromium Remotion или null (режим по умолчанию),
// nvenc – можно ли кодировать H.264 через h264_nvenc этим ffmpeg.
function detectGpu({ env = process.env, platform = process.platform, ffmpeg = 'ffmpeg', probe = probeNvenc } = {}) {
  if (gpuMode(env) === 'off') return { gl: null, nvenc: false };
  const key = `${platform}\0${ffmpeg}`;
  if (!cache.has(key)) {
    // ANGLE (Direct3D) – GPU-растеризация Chromium на Windows; без видеокарты ANGLE уходит на WARP,
    // поэтому рендер не ломается. На macOS и Linux режим Chromium оставляем Remotion.
    cache.set(key, { gl: platform === 'win32' ? 'angle' : null, nvenc: probe(ffmpeg) });
  }
  return cache.get(key);
}

function resetGpuCache() {
  cache.clear();
}

// x264-пресет → пресет NVENC той же «цены» и сдвиг -cq относительно -crf x264. Сдвиг подобран так,
// чтобы SSIM к исходнику был не ниже, чем у x264, а файл – не больше чем на четверть (замер 1080×1920):
// medium crf14 → cq17 (SSIM 0,9981 против 0,9980), medium crf20 → cq23, veryfast crf20 → cq26.
const NVENC_PRESETS = Object.freeze({
  ultrafast: { preset: 'p1', cqOffset: 6 },
  superfast: { preset: 'p2', cqOffset: 6 },
  veryfast: { preset: 'p3', cqOffset: 6 },
  faster: { preset: 'p4', cqOffset: 4 },
  fast: { preset: 'p4', cqOffset: 4 },
  medium: { preset: 'p5', cqOffset: 3 },
  slow: { preset: 'p6', cqOffset: 3 },
});

// NVENC H.264 не кодирует 10 бит, поэтому по умолчанию 8-битный yuv420p (pixFmt: false – формат
// задаёт вызывающий, как Remotion).
function h264EncoderArgs({ crf, preset = 'medium', nvenc = false, pixFmt = true }) {
  if (!Number.isSafeInteger(crf) || crf < 1 || crf > 51) throw new Error('crf должен быть целым от 1 до 51');
  if (!nvenc) return ['-c:v', 'libx264', '-preset', preset, '-crf', String(crf)];
  const nv = NVENC_PRESETS[preset];
  if (!nv) throw new Error(`неизвестный пресет x264 «${preset}»`);
  const cq = Math.min(51, crf + nv.cqOffset);
  return ['-c:v', NVENC, '-preset', nv.preset, '-tune', 'hq', '-rc', 'vbr', '-cq', String(cq), '-b:v', '0',
    ...(pixFmt ? ['-pix_fmt', 'yuv420p'] : [])];
}

// Кодирование с откатом: сначала NVENC (если найден), при любой ошибке – тот же шаг на libx264.
// build(nvenc) возвращает { command, args }; run – runTool или его подмена в тестах.
function runH264(build, { run, nvenc = detectGpu().nvenc, warn = console.warn, stage = 'encode', options = {} }) {
  if (nvenc) {
    const command = build(true);
    try {
      return run(command.command, command.args, { ...options, stage: `${stage} (NVENC)` });
    } catch (error) {
      warn(`⚠️ ${stage}: NVENC не сработал (${String(error?.message || error).split('\n')[0].slice(0, 200)}) – кодирую на CPU`);
    }
  }
  const command = build(false);
  return run(command.command, command.args, { ...options, stage });
}

// Подмена кодера в командах ffmpeg самого Remotion (Config.overrideFfmpegCommand): libx264 с его
// -crf и -preset → h264_nvenc. -crf Remotion ставит сам (по умолчанию 18 для h264) или из --crf.
// Остальные аргументы (pix_fmt, цвет, -vf) не трогаются.
const REMOTION_DEFAULT_CRF = 18;

function nvencRemotionOverride(args) {
  const list = args.map(String);
  const codecAt = list.findIndex((arg, index) => arg === '-c:v' && list[index + 1] === 'libx264');
  if (codecAt < 0) return args;
  let crf = REMOTION_DEFAULT_CRF;
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    if (index === codecAt) {
      index += 1;
      out.push('__ENCODER__');
      continue;
    }
    if (list[index] === '-crf' || list[index] === '-preset') {
      if (list[index] === '-crf') crf = Math.max(1, Math.round(Number(list[index + 1])) || REMOTION_DEFAULT_CRF);
      index += 1;
      continue;
    }
    out.push(args[index]);
  }
  const encoder = h264EncoderArgs({ crf, preset: 'medium', nvenc: true, pixFmt: false });
  const at = out.indexOf('__ENCODER__');
  return [...out.slice(0, at), ...encoder, ...out.slice(at + 1)];
}

// ffmpeg, которым кодирует Remotion: его собственный бинарник из @remotion/compositor-*.
function remotionFfmpegPath({ platform = process.platform, arch = process.arch, resolve = require.resolve } = {}) {
  const suffixes = platform === 'win32' ? ['-msvc'] : platform === 'linux' ? ['-gnu', '-musl'] : [''];
  for (const suffix of suffixes) {
    try {
      const dir = path.dirname(resolve(`@remotion/compositor-${platform}-${arch}${suffix}/package.json`));
      const file = path.join(dir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
      if (fs.existsSync(file)) return file;
    } catch {
      // пакета под эту платформу нет – пробуем следующий
    }
  }
  return null;
}

function describeGpu(gpu) {
  const parts = [gpu.gl ? `Chromium --gl=${gpu.gl}` : 'Chromium по умолчанию', gpu.nvenc ? 'H.264 через NVENC' : 'H.264 через libx264 (CPU)'];
  return parts.join(', ');
}

module.exports = {
  GPU_ENV,
  NVENC,
  describeGpu,
  detectGpu,
  gpuMode,
  h264EncoderArgs,
  nvencRemotionOverride,
  probeNvenc,
  remotionFfmpegPath,
  resetGpuCache,
  runH264,
};

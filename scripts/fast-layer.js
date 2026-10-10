// Быстрая сборка ролика из одного полноэкранного слоя kit – ffmpeg вместо Remotion.
//
// Brief Creative Motion после `layer brief` – одна сцена `broll` на весь ролик со слоем
// `overlay: "none"`. В ReelScenes (src/SceneDirector.jsx) такой кадр – это сам слой без единого
// пикселя поверх (фон под ним слой закрывает целиком), а звук – голос исходника с громкостью 1 плюс
// звук слоя: `mix` – MIX_GAIN (−18 дБ) с огибающей 0,12 с по краям (src/scenes/BrollMedia.jsx), `mute` –
// без звука слоя. Remotion при этом заново рисует слой в Chromium и сжимает его ещё раз: 2,5–5 минут
// процессора на ролик и потеря качества (PSNR final к слою ~45 дБ). Замер 2026-10-10 (mcp-top5-d1,
// 79,8 с): ffmpeg собирает тот же ролик за 6 с, видео слоя копируется без перекодирования, звук
// совпадает с Remotion (корреляция 0,9994, усиление 0,999, тот же RMS; Remotion лишь отстаёт на 42,5 мс,
// которые finish.js у него компенсирует, а здесь сдвига нет).
//
// Любое отличие от этой формы (несколько сцен, оформление, спикер в углу, обрезка, `replace`, музыка
// внутри props, другой размер или FPS слоя, фрагмент preview, масштаб preview) – обычный Remotion.
// AUTOMONTAGE_FAST_LAYER=off выключает быстрый путь целиком.
const path = require('node:path');
const { ROOT } = require('./env');

const FAST_LAYER_ENV = 'AUTOMONTAGE_FAST_LAYER';
// Те же числа, что в src/scenes/BrollMedia.jsx и src/scenes/safezone.js (равенство закреплено тестом).
const MIX_GAIN_DB = -18;
const SAFE_9x16 = { top: 250, right: 130 };
const SAFE_16x9 = { top: 60, right: 80 };
const WATERMARK_FONT = path.join(ROOT, 'public', 'fonts', 'Onest.ttf');

function fastLayerMode(env = process.env) {
  const raw = env[FAST_LAYER_ENV];
  if (raw === undefined || raw === '') return 'auto';
  const mode = String(raw).trim().toLowerCase();
  if (mode !== 'auto' && mode !== 'off') throw new Error(`${FAST_LAYER_ENV} принимает только auto или off`);
  return mode;
}

const fadeFramesForFps = (fps) => Math.max(1, Math.round(0.12 * fps));

// План быстрой сборки по props, которые иначе ушли бы в Remotion, или { plan: null, reason }.
// probe(file) – probeMediaPath; publicDir – папка, от которой props считают staticFile-пути.
function planFastLayer({ composition, props, publicDir, probe, range = null, scale = 1, env = process.env }) {
  const no = (reason) => ({ plan: null, reason });
  if (fastLayerMode(env) === 'off') return no(`${FAST_LAYER_ENV}=off`);
  if (composition !== 'ReelScenes') return no(`композиция ${composition}`);
  if (range && range.kind !== 'full') return no('фрагмент preview');
  if (scale !== 1) return no('preview в уменьшенном масштабе');
  if (!props || !Array.isArray(props.scenes) || props.scenes.length !== 1) return no('не одна сцена');
  if (props.musicSrc || props.debug) return no('музыка или отладка внутри композиции');
  const { fps, width, height, durationInFrames } = props;
  if (!(fps > 0) || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || !Number.isSafeInteger(durationInFrames) || durationInFrames <= 0) return no('нет геометрии композиции');
  const scene = props.scenes[0];
  const media = scene && scene.brollMedia;
  if (!scene || scene.scene !== 'broll' || !media) return no('сцена не broll со слоем');
  const start = scene.start || 0;
  const sceneFrames = Math.max(1, Math.round(((scene.end ?? start + 3) - start) * fps));
  if (start !== 0 || sceneFrames !== durationInFrames) return no('слой не на весь ролик');
  if (media.kind !== 'video' || media.overlay !== 'none') return no('у слоя есть оформление движка');
  if ((media.fit || 'cover') !== 'cover' || (media.trimStartSec || 0) !== 0) return no('слой обрезан или вписан');
  if (media.audioMode !== 'mix' && media.audioMode !== 'mute') return no(`звук слоя ${media.audioMode}`);
  if (typeof media.src !== 'string' || /^https?:\/\//.test(media.src)) return no('слой не локальный файл');
  const layerPath = path.join(publicDir, media.src);
  const layer = probe(layerPath);
  if (layer.width !== width || layer.height !== height || layer.rotation !== 0
    || Math.abs(layer.fps - fps) > 1e-6) return no('размер или FPS слоя не совпадают с роликом');
  if (layer.videoCodec !== 'h264' || layer.pixelFormat !== 'yuv420p') return no('слой не H.264 yuv420p');
  const durationSec = durationInFrames / fps;
  if (layer.durationSec + 0.5 / fps < durationSec) return no('слой короче ролика');
  let voicePath = null;
  if (props.audioSrc) {
    voicePath = path.join(publicDir, props.audioSrc);
    const voice = probe(voicePath);
    if (!voice.hasAudio) voicePath = null;
  }
  return {
    plan: {
      layerPath, voicePath, fps, width, height, durationInFrames, durationSec,
      layerAudio: media.audioMode === 'mix' && layer.hasAudio,
      watermark: Boolean(props.draftPreview),
    },
    reason: null,
  };
}

const seconds = (value) => (Math.round(value * 1e6) / 1e6).toFixed(6);

// Метка «ЧЕРНОВИК» как в SceneDirector: правый верхний угол сейф-зоны, полупрозрачная плашка с рамкой.
function watermarkFilter({ width, height }) {
  const safe = height > width ? SAFE_9x16 : SAFE_16x9;
  const size = Math.max(18, Math.round(Math.min(width, height) * 0.026));
  const fontFile = WATERMARK_FONT.replace(/\\/g, '/').replace(/:/g, '\\:');
  return [
    // Обводка цветом букв – полужирное начертание у вариативного Onest (по умолчанию он тонкий).
    `drawtext=fontfile='${fontFile}':text='ЧЕРНОВИК':fontsize=${size}:fontcolor=white@0.72`,
    `borderw=${Math.max(1, Math.round(size / 20))}:bordercolor=white@0.72`,
    `box=1:boxcolor=black@0.35:boxborderw=${Math.round(size * 0.4)}|${Math.round(size * 0.6)}`,
    `x=w-${safe.right}-tw-${Math.round(size * 0.6)}:y=${safe.top}+${Math.round(size * 0.4)}`,
  ].join(':');
}

// Команда ffmpeg: видео слоя (копией, а в preview – с меткой и перекодированием encoderArgs) и звук
// ReelScenes. Выход – как raw.mp4 Remotion: дальше тот же finish.js, но с --audio-advance-ms 0.
function fastLayerCommand(plan, { output, encoderArgs = null }) {
  const duration = seconds(plan.durationSec);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', plan.layerPath];
  if (plan.voicePath) args.push('-i', plan.voicePath);
  const audioInput = (index) => `[${index}:a]atrim=0:${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo`;
  const chains = [];
  const mixed = [];
  if (plan.voicePath) {
    chains.push(`${audioInput(1)}[voice]`);
    mixed.push('[voice]');
  }
  if (plan.layerAudio) {
    const fade = seconds(fadeFramesForFps(plan.fps) / plan.fps);
    const fadeOutStart = seconds((plan.durationInFrames - 1 - fadeFramesForFps(plan.fps)) / plan.fps);
    chains.push(`${audioInput(0)},volume=${MIX_GAIN_DB}dB,afade=t=in:st=0:d=${fade},afade=t=out:st=${fadeOutStart}:d=${fade}[layer]`);
    mixed.push('[layer]');
  }
  if (mixed.length > 1) chains.push(`${mixed.join('')}amix=inputs=${mixed.length}:normalize=0:duration=first:dropout_transition=0[aout]`);
  else if (mixed.length === 1) chains.push(`${mixed[0]}anull[aout]`);
  if (plan.watermark) chains.push(`[0:v]${watermarkFilter(plan)}[vout]`);
  if (chains.length) args.push('-filter_complex', chains.join(';'));
  args.push('-map', plan.watermark ? '[vout]' : '0:v:0');
  if (mixed.length) args.push('-map', '[aout]');
  if (plan.watermark) {
    if (!encoderArgs) throw new Error('метке черновика нужно перекодирование: encoderArgs');
    args.push(...encoderArgs);
  } else {
    args.push('-c:v', 'copy');
  }
  if (mixed.length) args.push('-c:a', 'aac', '-b:a', '320k', '-ar', '48000');
  args.push('-t', duration, '-movflags', '+faststart', output);
  return { command: 'ffmpeg', args };
}

// Общий шаг рендера preview и final: быстрая сборка, если ролик подходит, иначе переданная команда
// Remotion. Возвращает сдвиг звука для finish.js: у Remotion – его отставание, у ffmpeg – 0.
// probe, если не может прочитать файл, – тоже обычный Remotion: быстрый путь лишь ускоряет.
function renderLayerOrRemotion({
  composition, props, publicDir, range = null, scale = 1, output, crf, remotionCommand,
  run, log = console.log, stage, remotionAudioAdvanceMs,
  probe = (file) => require('./media-probe').probeMediaPath(file, { stage: `${stage} probe` }),
  gpu = require('./gpu'), env = process.env,
}) {
  let decision;
  try {
    decision = planFastLayer({ composition, props, publicDir, probe, range, scale, env });
  } catch (error) {
    if (error && String(error.message).startsWith(FAST_LAYER_ENV)) throw error;
    decision = { plan: null, reason: `слой не прочитан (${String(error?.message || error).split('\n')[0].slice(0, 120)})` };
  }
  if (!decision.plan) {
    run(remotionCommand.command, remotionCommand.args, { cwd: ROOT, stage: `${stage} Remotion` });
    return { fast: false, reason: decision.reason, audioAdvanceMs: remotionAudioAdvanceMs };
  }
  log(`быстрая сборка: слой kit на весь ролик – ffmpeg без Remotion${decision.plan.watermark ? ' (с меткой черновика)' : ', видео слоя без перекодирования'}`);
  if (decision.plan.watermark) {
    gpu.runH264((nvenc) => fastLayerCommand(decision.plan, {
      output, encoderArgs: gpu.h264EncoderArgs({ crf, preset: 'medium', nvenc }),
    }), { run, stage: `${stage} fast layer`, options: { cwd: ROOT } });
  } else {
    const command = fastLayerCommand(decision.plan, { output });
    run(command.command, command.args, { cwd: ROOT, stage: `${stage} fast layer` });
  }
  return { fast: true, reason: null, audioAdvanceMs: 0 };
}

module.exports = {
  FAST_LAYER_ENV, MIX_GAIN_DB, SAFE_16x9, SAFE_9x16, fadeFramesForFps,
  fastLayerCommand, fastLayerMode, planFastLayer, renderLayerOrRemotion, watermarkFilter,
};

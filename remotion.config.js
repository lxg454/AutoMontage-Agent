const path = require('node:path');
const { Config } = require('@remotion/cli/config');
const { includeInstalledSource, withMotionKitAlias } = require('./scripts/remotion-webpack');
const { shouldOverride, limitedRangeOverride } = require('./scripts/remotion-ffmpeg-override');
const { detectGpu, nvencRemotionOverride, remotionFfmpegPath } = require('./scripts/gpu');

// Видеокарта (AUTOMONTAGE_GPU=auto|off): GPU-растеризация Chromium и NVENC вместо libx264 в кодировании
// Remotion. NVENC проверяется пробой собственного ffmpeg Remotion; без него всё остаётся на CPU.
const gpu = detectGpu({ ffmpeg: remotionFfmpegPath() || 'ffmpeg' });
if (gpu.gl) Config.setChromiumOpenGlRenderer(gpu.gl);

const limitedRange = shouldOverride(process.env);
if (limitedRange || gpu.nvenc) {
  // Сначала limited range (ищет -c:v libx264), затем подмена кодера.
  Config.overrideFfmpegCommand(({ type, args }) => {
    const ranged = limitedRange ? limitedRangeOverride({ type, args }) : args;
    return gpu.nvenc ? nvencRemotionOverride(ranged) : ranged;
  });
}

// The Remotion loader evaluates bundled config from its own module; it sets cwd
// to the selected project root while loading. Capture that root before callbacks.
const sourceDirectory = path.join(process.cwd(), 'src');
// MOTION_KIT_DIR (default в withMotionKitAlias) верен только для обычного require из Node;
// здесь код исполняется через eval из node_modules/@remotion/cli, поэтому каталог считаем от
// того же process.cwd(), что и sourceDirectory выше.
Config.overrideWebpackConfig(config => withMotionKitAlias(
  includeInstalledSource(config, sourceDirectory),
  path.join(sourceDirectory, 'motion-kit'),
));

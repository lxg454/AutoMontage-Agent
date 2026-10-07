const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Remotion 4.0.504 includes numeric argv in its pre-stitcher command.
const STITCHER_ARGS = ['-r', 30, '-f', 'image2', '-s', '1080x1920', '-start_number', 0,
  '-i', 'el-%02d.jpeg', '-i', 'a.aac', '-c:a', 'copy', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-video_track_timescale', 90000, '-crf', 18, '-movflags', 'faststart', '-map_metadata', '-1',
  '-metadata', 'comment=Made with Remotion 4.0.504', '-y', 'out.mp4'];
const LIMITED_ARGS = ['-vf', 'scale=out_range=tv,format=yuv420p', '-color_range', 'tv'];

test('libx264 stitcher gets limited range before the final overwrite flag and output', () => {
  const { limitedRangeOverride } = require('../scripts/remotion-ffmpeg-override');
  const args = [...STITCHER_ARGS];
  assert.deepEqual(limitedRangeOverride({ type: 'stitcher', args }),
    [...STITCHER_ARGS.slice(0, -2), ...LIMITED_ARGS, '-y', 'out.mp4']);
  assert.deepEqual(args, STITCHER_ARGS, 'исходные аргументы не меняются');
});

test('libx264 stitcher without an overwrite flag gets limited range before the output', () => {
  const { limitedRangeOverride } = require('../scripts/remotion-ffmpeg-override');
  const args = [...STITCHER_ARGS.slice(0, -2), 'out.mp4'];
  assert.deepEqual(limitedRangeOverride({ type: 'stitcher', args }),
    [...args.slice(0, -1), ...LIMITED_ARGS, 'out.mp4']);
});

test('video copy commands are unchanged', () => {
  const { limitedRangeOverride } = require('../scripts/remotion-ffmpeg-override');
  const args = ['-i', 'in.mp4', '-c:v', 'copy', '-y', 'out.mp4'];
  assert.deepEqual(limitedRangeOverride({ type: 'stitcher', args }), args);
});

test('only the explicit layer environment flag enables the override', () => {
  const { LIMITED_RANGE_ENV, shouldOverride } = require('../scripts/remotion-ffmpeg-override');
  assert.equal(LIMITED_RANGE_ENV, 'AUTOMONTAGE_LAYER_LIMITED_RANGE');
  assert.equal(shouldOverride({ AUTOMONTAGE_LAYER_LIMITED_RANGE: '1' }), true);
  assert.equal(shouldOverride({}), false);
  assert.equal(shouldOverride({ AUTOMONTAGE_LAYER_LIMITED_RANGE: '0' }), false);
});

// Конфиг исполняет загрузчик Remotion CLI (esbuild + eval), поэтому он и проверяется: какой override
// ffmpeg остаётся зарегистрированным после загрузки при разных переменных окружения.
async function loadRemotionConfig(env) {
  const cliPackage = path.dirname(require.resolve('@remotion/cli/package.json'));
  const { loadConfigFile } = require(path.join(cliPackage, 'dist/load-config.js'));
  const overrides = require(path.join(cliPackage, 'dist/config/ffmpeg-override.js'));
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  overrides.resetFfmpegOverrideFunction();
  try {
    Object.assign(process.env, env);
    for (const [key, value] of Object.entries(env)) if (value === undefined) delete process.env[key];
    await loadConfigFile(path.join(__dirname, '..'), 'remotion.config.js', true);
    return overrides.getFfmpegOverrideFunction();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    overrides.resetFfmpegOverrideFunction();
  }
}

test('Remotion config registers the ffmpeg override only for the explicit layer flag', async () => {
  const off = { AUTOMONTAGE_GPU: 'off' };
  const plain = await loadRemotionConfig({ ...off, AUTOMONTAGE_LAYER_LIMITED_RANGE: undefined });
  assert.deepEqual(plain({ type: 'stitcher', args: [...STITCHER_ARGS] }), STITCHER_ARGS);
  const layer = await loadRemotionConfig({ ...off, AUTOMONTAGE_LAYER_LIMITED_RANGE: '1' });
  assert.deepEqual(layer({ type: 'stitcher', args: [...STITCHER_ARGS] }),
    [...STITCHER_ARGS.slice(0, -2), ...LIMITED_ARGS, '-y', 'out.mp4'],
    'с AUTOMONTAGE_GPU=off – прежний limited range без подмены кодера');
});

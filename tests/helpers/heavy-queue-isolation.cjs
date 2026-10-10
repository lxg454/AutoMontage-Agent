const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The preload also runs in the test runner parent. Each test file needs its own queue.
if (process.env.NODE_TEST_CONTEXT || !process.env.AUTOMONTAGE_HEAVY_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-heavy-test-'));
  process.env.AUTOMONTAGE_HEAVY_DIR = dir;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
}

// Видеокарта выключена во всех тестах: команды ffmpeg и Remotion не зависят от того, есть ли на машине
// NVIDIA. Ветку NVENC проверяют отдельные тесты, передавая nvenc явно.
process.env.AUTOMONTAGE_GPU = 'off';

// Автоматическая чистка TEMP после задач очереди (scripts/temp-clean.js) в тестах выключена: тест не
// должен удалять настоящие временные папки машины. Её проверяет tests/temp-clean.test.js.
process.env.AUTOMONTAGE_TEMP_CLEAN = 'off';

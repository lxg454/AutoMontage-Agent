const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { python } = require('../scripts/env');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'transcribe.py');

let interpreter = null;
try {
  interpreter = python();
} catch {
  interpreter = null;
}

// Подмена faster_whisper и ctranslate2 через PYTHONPATH: настоящая модель и видеокарта не нужны.
// FAIL_CUDA=1 – CUDA падает уже при разборе сегментов (как без cuBLAS), а не при создании модели.
const STUB_WHISPER = `
import json, os
CALLS = os.environ['STUB_CALLS']
class W:
    def __init__(self, word, start, end):
        self.word, self.start, self.end = word, start, end
class S:
    def __init__(self):
        self.start, self.end, self.text, self.words = 0.0, 1.0, ' привет', [W(' привет', 0.0, 1.0)]
class WhisperModel:
    def __init__(self, name, device, compute_type):
        self.device = device
        with open(CALLS, 'a', encoding='utf-8') as f:
            f.write(json.dumps([device, compute_type]) + '\\n')
    def transcribe(self, audio, **kwargs):
        def gen():
            if self.device == 'cuda' and os.environ.get('FAIL_CUDA') == '1':
                raise RuntimeError('Library cublas64_12.dll is not found or cannot be loaded\\nдетали')
            yield S()
        return gen(), None
`;

function runStub(t, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'automontage-transcribe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'faster_whisper'));
  fs.writeFileSync(path.join(dir, 'faster_whisper', '__init__.py'), STUB_WHISPER);
  fs.writeFileSync(path.join(dir, 'ctranslate2.py'), `def get_cuda_device_count():\n    return ${env.CUDA_DEVICES ?? 1}\n`);
  const calls = path.join(dir, 'calls.jsonl');
  const out = path.join(dir, 'out.json');
  const result = spawnSync(interpreter, [SCRIPT, path.join(dir, 'in.wav'), out], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PYTHONPATH: dir, PYTHONUTF8: '1', STUB_CALLS: calls, ...env },
  });
  const devices = fs.existsSync(calls)
    ? fs.readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    : [];
  const words = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')).flatMap((s) => s.words) : null;
  return { result, devices, words };
}

const skip = interpreter ? false : 'Python 3 не найден';

test('transcribe.py: при AUTOMONTAGE_GPU=auto и видеокарте распознаёт на CUDA float16', { skip }, (t) => {
  const { result, devices, words } = runStub(t, { AUTOMONTAGE_GPU: 'auto' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(devices, [['cuda', 'float16']]);
  assert.match(result.stdout, /device=cuda\/float16/);
  assert.deepEqual(words, [{ w: ' привет', s: 0, e: 1 }]);
});

test('transcribe.py: сбой CUDA при разборе сегментов – тот же файл на CPU int8 с предупреждением', { skip }, (t) => {
  const { result, devices, words } = runStub(t, { AUTOMONTAGE_GPU: 'auto', FAIL_CUDA: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(devices, [['cuda', 'float16'], ['cpu', 'int8']]);
  assert.match(result.stderr, /Whisper на cuda не сработал \(Library cublas64_12\.dll is not found or cannot be loaded\) – распознаю на CPU/);
  assert.match(result.stdout, /device=cpu\/int8/);
  assert.deepEqual(words, [{ w: ' привет', s: 0, e: 1 }]);
});

test('transcribe.py: off и машина без CUDA сразу идут на CPU; неверное значение – отказ', { skip }, (t) => {
  assert.deepEqual(runStub(t, { AUTOMONTAGE_GPU: 'off' }).devices, [['cpu', 'int8']]);
  assert.deepEqual(runStub(t, { AUTOMONTAGE_GPU: 'auto', CUDA_DEVICES: 0 }).devices, [['cpu', 'int8']]);
  const bad = runStub(t, { AUTOMONTAGE_GPU: 'cuda' });
  assert.notEqual(bad.result.status, 0);
  assert.match(bad.result.stderr, /AUTOMONTAGE_GPU принимает только auto или off/);
  assert.deepEqual(bad.devices, []);
});

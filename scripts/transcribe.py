#!/usr/bin/env python3
# Транскрипция аудио → JSON (сегменты + словные таймкоды). Локально, бесплатно.
#   python3 transcribe.py <audio> <out.json> [model] [--prompt "контекст"]
# Модель по умолчанию large-v3-turbo (~1.6 ГБ) — точность почти как large-v3,
# но вдвое легче/быстрее. Качается ОДИН раз при первом запуске, дальше офлайн.
# Другие: base (~140МБ, быстро/неточно), small (~460МБ), large-v3 (~3ГБ, максимум).
# Передать нужную вторым аргументом.
import glob, json, os, sys

# Предупреждение об откате на CPU печатается по-русски: в консоли cp1251/cp866 без PYTHONUTF8 не падать.
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(errors='replace')


def gpu_mode():
    # Та же переменная, что у ffmpeg и Remotion (scripts/gpu.js): auto – видеокарта, если есть; off – CPU.
    mode = os.environ.get('AUTOMONTAGE_GPU', '').strip().lower() or 'auto'
    if mode not in ('auto', 'off'):
        sys.exit(f'AUTOMONTAGE_GPU принимает только auto или off (получено «{mode[:20]}»)')
    return mode


def add_nvidia_dll_dirs():
    # cuBLAS/cuDNN из pip-пакетов nvidia-cublas-cu12 и nvidia-cudnn-cu12 лежат в site-packages/nvidia/*/bin
    # (Windows) или */lib (Linux); CTranslate2 сам их не находит.
    try:
        import nvidia
    except ImportError:
        return
    for root in list(getattr(nvidia, '__path__', [])):
        for d in glob.glob(os.path.join(root, '*', 'bin')) + glob.glob(os.path.join(root, '*', 'lib')):
            if hasattr(os, 'add_dll_directory'):
                os.add_dll_directory(d)
            os.environ['PATH'] = d + os.pathsep + os.environ.get('PATH', '')


def cuda_available():
    try:
        import ctranslate2
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:
        return False


# (device, compute_type) по порядку: CUDA float16 (на RTX 5070 60 с речи – 2,6 с против 35 с на CPU,
# слова совпадают), затем CPU int8 – работает без видеокарты.
def device_plan():
    plan = []
    if gpu_mode() == 'auto':
        add_nvidia_dll_dirs()
        if cuda_available():
            plan.append(('cuda', 'float16'))
    plan.append(('cpu', 'int8'))
    return plan


from faster_whisper import WhisperModel

audio = sys.argv[1]
out = sys.argv[2]
model_name = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].startswith('--') else 'large-v3-turbo'

# initial_prompt — подсказка с лексикой темы: whisper реже коверкает термины
prompt = 'Вайбкодинг, ИИ-агенты, нейросети, автомонтаж, монтаж видео, субтитры, плашки, Claude, Codex, Reels, контент.'
if '--prompt' in sys.argv:
    prompt = sys.argv[sys.argv.index('--prompt') + 1]


def transcribe(device, compute_type):
    m = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, info = m.transcribe(
        audio, language='ru', word_timestamps=True,
        initial_prompt=prompt,
        beam_size=5,                       # точнее жадного поиска
        condition_on_previous_text=True,   # связность между сегментами
        vad_filter=True,                   # отсечь тишину/шум → меньше галлюцинаций
        vad_parameters=dict(min_silence_duration_ms=400),
        temperature=[0.0, 0.2, 0.4],       # фолбэк при низкой уверенности
    )
    # segments – ленивый генератор: ошибки CUDA (нет cuBLAS/cuDNN, мало памяти) всплывают только здесь,
    # поэтому весь разбор внутри попытки.
    res = []
    for s in segments:
        words = [{'w': w.word, 's': round(w.start, 2), 'e': round(w.end, 2)} for w in (s.words or [])]
        res.append({'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text.strip(), 'words': words})
    return res


plan = device_plan()
for index, (device, compute_type) in enumerate(plan):
    try:
        res = transcribe(device, compute_type)
        break
    except Exception as error:
        if index == len(plan) - 1:
            raise
        first_line = (str(error).splitlines() or [''])[0][:200]
        print(f'Whisper на {device} не сработал ({first_line}) – распознаю на CPU', file=sys.stderr)

json.dump(res, open(out, 'w'), ensure_ascii=False, indent=1)
print(f'model={model_name} device={device}/{compute_type} segments={len(res)}')

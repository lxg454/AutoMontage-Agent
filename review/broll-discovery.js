function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
// Страницы источника, автора и лицензии – только сайты поддерживаемых стоков.
const PUBLIC_HOSTS = ['pexels.com', 'www.pexels.com', 'pixabay.com'];
function publicLink(label, address) {
  try {
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !PUBLIC_HOSTS.includes(url.hostname)) return node('span', label);
    const link = node('a', label);
    link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  } catch { return node('span', label); }
}
function attribution(parent, value) {
  parent.append(node('span', value.provider || 'Источник'),
    publicLink(value.author?.name || 'Автор', value.author?.url),
    publicLink('Страница источника', value.sourcePage),
    publicLink(value.license?.name || 'Лицензия', value.license?.url));
}

export function createBrollDiscoveryUI({ request, getState, queueCommand, refresh, setBusy, reportError, mediaUrl }) {
  const scenes = new Map();
  const base = () => {
    const { baseRevision, baseHash, manifestHash } = getState().session;
    return { baseRevision, baseHash, manifestHash };
  };
  function create(index) {
    const section = node('section', undefined, 'broll-discovery');
    section.setAttribute('aria-label', `Подбор B-roll сцены ${index + 1}`);
    const goal = node('p'); const source = node('blockquote');
    const fields = node('div', undefined, 'broll-discovery-fields');
    function input(labelText, type = 'text') {
      const label = node('label', undefined, 'broll-setting'); label.append(node('span', labelText));
      const field = node('input'); field.type = type;
      if (type === 'number') { field.min = '0'; field.step = '1'; } else field.maxLength = 300;
      label.append(field); fields.append(label); return field;
    }
    const original = input('Исходный запрос'); const english = input('Запрос на английском');
    const tabs = node('div', undefined, 'broll-discovery-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Тип B-roll');
    const video = node('button', 'Видео', 'edit-button'); const photo = node('button', 'Фото', 'edit-button');
    [video, photo].forEach(t => { t.type = 'button'; t.setAttribute('role', 'tab'); tabs.append(t); });
    const orientationLabel = node('label', undefined, 'broll-setting'); orientationLabel.append(node('span', 'Ориентация'));
    const orientation = node('select'); orientation.setAttribute('aria-label', 'Ориентация');
    [['', 'Любая'], ['landscape', 'Горизонтальная'], ['portrait', 'Вертикальная'], ['square', 'Квадратная']].forEach(([value, label]) => { const o = node('option', label); o.value = value; orientation.append(o); });
    orientationLabel.append(orientation); fields.append(orientationLabel);
    const duration = input('Минимальная длительность, сек', 'number'); duration.step = '0.1';
    const width = input('Минимальная ширина', 'number'); const height = input('Минимальная высота', 'number');
    const search = node('button', 'Подобрать B-roll', 'edit-button'); search.type = 'button';
    const status = node('p', '', 'broll-discovery-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const warning = node('p', 'Текст и логотипы пока не проверены. После выбора выполняется локальное распознавание; изображение всё равно нужно осмотреть.', 'broll-discovery-warning');
    const cards = node('div', undefined, 'broll-candidates');
    const more = node('button', 'Ещё варианты', 'edit-button'); more.type = 'button'; more.hidden = true;
    const evidence = node('div', undefined, 'broll-evidence');
    section.append(goal, source, fields, tabs, search, status, warning, cards, more, evidence);
    const entry = { section, goal, source, original, english, duration, width, height, orientation, video, photo, search, status, cards, more, evidence, mediaKind: 'video', busy: false, locked: false, candidates: [], nextPage: null, searchId: null, scene: null, asset: null, ack: false };
    const queryChanged = () => {
      if (entry.locked || entry.busy) return;
      entry.candidates = []; entry.searchId = null; entry.nextPage = null; drawCards(entry, index);
      if (entry.scene?.brollIntent && original.value.trim() && english.value.trim()) queueCommand({ type: 'set-broll-query', sceneIndex: index, queryOriginal: original.value, queryEnglish: english.value });
    };
    original.addEventListener('change', queryChanged); english.addEventListener('change', queryChanged);
    function tab(kind) { if (entry.locked || entry.busy) return; entry.mediaKind = kind; entry.candidates = []; entry.nextPage = null; entry.searchId = null; update(entry); drawCards(entry, index); }
    video.addEventListener('click', () => tab('video')); photo.addEventListener('click', () => tab('image'));
    tabs.addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); tab(entry.mediaKind === 'video' ? 'image' : 'video'); (entry.mediaKind === 'video' ? video : photo).focus(); });
    search.addEventListener('click', () => searchPage(entry, index, 1));
    more.addEventListener('click', () => searchPage(entry, index, entry.nextPage));
    return entry;
  }
  function update(e) {
    e.section.setAttribute('aria-busy', String(e.busy));
    e.section.querySelectorAll('input,select,button').forEach(control => { control.disabled = e.locked || e.busy; });
    e.duration.disabled = e.locked || e.busy || e.mediaKind === 'image';
    e.video.setAttribute('aria-selected', String(e.mediaKind === 'video')); e.photo.setAttribute('aria-selected', String(e.mediaKind === 'image'));
    e.video.tabIndex = e.mediaKind === 'video' ? 0 : -1; e.photo.tabIndex = e.mediaKind === 'image' ? 0 : -1;
    e.more.hidden = !e.nextPage;
  }
  async function run(e, operation, failureText) {
    if (e.locked || e.busy) return;
    e.busy = true; setBusy(true); update(e);
    try { await operation(); }
    catch (error) {
      e.status.textContent = error?.code === 'BROLL_KEY_MISSING'
        ? 'Добавьте PIXABAY_API_KEY или PEXELS_API_KEY в локальный файл .env и перезапустите Review. Не отправляйте ключ в чат.'
        : error?.code === 'BROLL_RATE_LIMITED' ? 'Сток просит подождать: слишком много запросов подряд. Повторите поиск через минуту.'
        : error?.status === 409 ? 'Проект или подбор изменился. Обновите подбор после разрешения конфликта.' : failureText;
      if (error?.status === 409) await reportError(error);
    } finally { e.busy = false; setBusy(false); update(e); }
  }
  async function searchPage(e, index, page) {
    if (!e.original.value.trim() || !e.english.value.trim()) { e.status.textContent = 'Заполните оба поисковых запроса.'; return; }
    await run(e, async () => {
      e.status.textContent = 'Ищем варианты…';
      const payload = { ...base(), sceneIndex: index, queryOriginal: e.original.value, queryEnglish: e.english.value, mediaKind: e.mediaKind, page: page || 1 };
      if (e.orientation.value) payload.orientation = e.orientation.value;
      for (const [name, field] of [['minDurationSec', e.duration], ['minWidth', e.width], ['minHeight', e.height]]) {
        if (field.value && !(name === 'minDurationSec' && e.mediaKind === 'image')) payload[name] = Number(field.value);
      }
      const requestedIdentity = e.shelfIdentity;
      const result = await request('/api/broll/search', payload);
      if (requestedIdentity !== e.shelfIdentity) return;
      e.candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 12) : [];
      e.searchId = result.searchId; e.nextPage = result.nextPage;
      e.status.textContent = e.candidates.length ? `Вариантов: ${e.candidates.length}` : 'Подходящих вариантов нет. Измените запрос или фильтры.';
      drawCards(e, index);
    }, 'Не удалось выполнить поиск. Повторите попытку.');
  }
  function drawCards(e, index) {
    e.cards.replaceChildren();
    e.candidates.forEach(candidate => {
      if (typeof candidate.id !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(candidate.id)) return;
      const card = node('article', undefined, 'broll-candidate'); card.dataset.brollCandidate = candidate.id;
      const image = node('img'); image.alt = `Вариант ${candidate.provider || 'B-roll'}`;
      image.src = mediaUrl(`/media/broll-candidate/${encodeURIComponent(candidate.id)}/thumbnail`); image.loading = 'lazy';
      if (candidate.mediaKind !== 'video' || !candidate.previewUrl) card.append(image);
      if (candidate.mediaKind === 'video' && candidate.previewUrl) {
        const preview = node('video'); preview.src = mediaUrl(`/media/broll-candidate/${encodeURIComponent(candidate.id)}/preview`);
        preview.poster = image.src; preview.controls = true; preview.preload = 'none'; preview.muted = true; preview.setAttribute('aria-label', 'Видео кандидата'); card.append(preview);
      }
      const links = node('div', undefined, 'broll-attribution'); attribution(links, candidate);
      const orientation = candidate.width > candidate.height ? 'Горизонтальная' : candidate.width < candidate.height ? 'Вертикальная' : 'Квадратная';
      card.append(links, node('p', `${candidate.width}×${candidate.height} · ${orientation}${candidate.mediaKind === 'video' ? ` · ${candidate.durationSec} сек` : ''}`));
      const select = node('button', 'Выбрать', 'edit-button'); select.type = 'button';
      const reject = node('button', 'Не подходит', 'edit-button'); reject.type = 'button';
      select.addEventListener('click', async () => {
        let assetId;
        await run(e, async () => {
          const startedAt = Date.now();
          const mediaLabel = candidate.mediaKind === 'video' ? 'видео' : 'изображение';
          const showProgress = () => {
            const elapsedSec = Math.floor((Date.now() - startedAt) / 1000);
            e.status.textContent = `Проверяем ${mediaLabel} локально: загрузка, decode, нормализация и OCR · прошло ${elapsedSec} сек.`;
          };
          showProgress();
          const progressTimer = window.setInterval(showProgress, 1000);
          try {
            const result = await request('/api/broll/select', { ...base(), sceneIndex: index, searchId: e.searchId, candidateId: candidate.id });
            await refresh(result.state);
            assetId = result.assetId;
            e.status.textContent = 'Медиа добавлено. Сохраните правки, чтобы создать новую ревизию.';
          } finally {
            window.clearInterval(progressTimer);
          }
        }, 'Не удалось выбрать медиа. Предыдущее медиа сохранено.');
        if (assetId) queueCommand({ type: 'replace-broll', sceneIndex: index, assetId });
      });
      reject.addEventListener('click', () => run(e, async () => {
        await request('/api/broll/reject', { searchId: e.searchId, candidateId: candidate.id });
        e.candidates = e.candidates.filter(c => c.id !== candidate.id); drawCards(e, index);
        e.status.textContent = 'Вариант отклонён.';
      }, 'Не удалось отклонить вариант. Повторите попытку.'));
      card.append(select, reject); e.cards.append(card);
    }); update(e);
  }
  return {
    render({ index, scene, locked, asset, acknowledged }) {
      if (!scenes.has(index)) scenes.set(index, create(index));
      const e = scenes.get(index); e.scene = scene; e.locked = locked;
      e.goal.textContent = scene.brollIntent?.goal || 'Подберите подходящее медиа для сцены';
      e.source.textContent = scene.brollIntent?.sourceText || '';
      if (scene.brollIntent) { e.original.value = scene.brollIntent.queryOriginal; e.english.value = scene.brollIntent.queryEnglish; }
      // Undo/redo and Save update the projected state without input change events.
      // Keep the shelf only while its query and project snapshot still match.
      const identity = JSON.stringify([base(), e.original.value, e.english.value]);
      if (e.shelfIdentity !== undefined && identity !== e.shelfIdentity) {
        const hadShelf = e.searchId !== null;
        e.candidates = []; e.searchId = null; e.nextPage = null;
        drawCards(e, index);
        if (hadShelf) e.status.textContent = 'Запрос или ревизия изменились. Подберите варианты заново.';
      }
      e.shelfIdentity = identity;
      const key = JSON.stringify([asset?.id, asset?.textScan, acknowledged]);
      if (key !== e.evidenceKey) {
        e.evidenceKey = key; e.evidence.replaceChildren();
        if (asset?.provenance) { const links = node('div', undefined, 'broll-attribution'); attribution(links, asset.provenance); e.evidence.append(links); }
        if (asset?.textScan) {
          const scan = asset.textScan;
          e.evidence.append(node('p', scan.status === 'clear' ? 'Распознавание не обнаружило текст. Проверьте логотипы визуально.' : scan.status === 'unavailable' ? 'Распознавание текста недоступно. Осмотрите медиа самостоятельно.' : 'Обнаружен возможный встроенный текст.'), node('p', scan.text || ''), node('p', (scan.reasons || []).join(', ')), node('p', scan.engine || ''));
          if (scan.status === 'needs-review' || scan.status === 'unavailable') {
            const label = node('label', undefined, 'broll-text-ack'); const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = acknowledged === true;
            label.append(checkbox, node('span', 'Разрешить встроенный текст')); e.evidence.append(label);
            checkbox.addEventListener('change', () => { if (!e.locked && !e.busy) queueCommand({ type: 'allow-broll-text', sceneIndex: index, allowEmbeddedText: checkbox.checked }); });
          }
        }
      }
      update(e); return e.section;
    },
  };
}

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
// Фраза из документа с любыми переносами строк и отступами между словами.
const words = phrase => new RegExp(phrase.split(' ').map(w => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('\\s+'), 'u');

test('every montage route points new chats to the shared choice contract', () => {
  const contract = read('skills/reel-turnkey/references/creative-motion.md');
  const entrypoints = [
    read('AGENTS.md'),
    read('skills/reel-turnkey/SKILL.md'),
    read('skills/reel-from-donor/SKILL.md'),
    read('skills/motion-reel/SKILL.md'),
  ];

  for (const entrypoint of entrypoints) {
    assert.match(entrypoint, /creative-motion\.md/u);
    assert.match(entrypoint, /Как\s+монтируем/iu);
  }

  for (const route of [
    /Уникальный Creative Motion[^\n]*рекоменду/iu,
    /Готовый стиль/iu,
    /По референсу/iu,
  ]) assert.match(contract, route);

  assert.match(contract, /нативные карточки\/кнопки/iu);
  assert.match(contract, /codex-followup/iu);
  assert.match(contract, /реши сам[\s\S]{0,160}Creative Motion/iu);
});

test('creative route is autonomous, project-local, and anti-template', () => {
  const contract = read('skills/reel-turnkey/references/creative-motion.md');
  const turnkey = read('skills/reel-turnkey/SKILL.md');
  const qa = read('skills/reel-turnkey/references/qa-checklist.md');
  const combined = `${contract}\n${turnkey}\n${qa}`;

  for (const invariant of [
    /не задавай[\s\S]*шрифт[\s\S]*цвет[\s\S]*музык/iu,
    /project-local/iu,
    /глобальн.*таймкод/iu,
    /современн.*кирилли/iu,
    /не повторяй одну композицию/iu,
    /одинаков.*motion-механик.*сосед/iu,
    /пуст.*чёрн.*переход/iu,
    /реальн.*интерфейс/iu,
    /официальн.*логотип/iu,
    /скриншот.*крупно и целиком/iu,
    /узел.*соединител.*следующ.*узел/iu,
    /начале, середине и конце/iu,
  ]) assert.match(combined, invariant);

  assert.doesNotMatch(turnkey, /Не генерируй новый дизайн ролика/u);
});

test('public guidance and behavioral evals expose the new choice', () => {
  for (const file of ['README.md', 'docs/MONTAGE-GUIDE.md', 'docs/TEMPLATES.md']) {
    const document = read(file);
    assert.match(document, /Уникальный Creative Motion/iu, file);
    assert.match(document, /Готовый стиль/iu, file);
    assert.match(document, /По референсу/iu, file);
  }

  const turnkeyEvals = JSON.parse(read('skills/reel-turnkey/evals/evals.json'));
  const delegated = turnkeyEvals.evals.find(item => item.id === 9);
  assert.ok(delegated);
  assert.match(delegated.expected_output, /автоном/iu);

  const donorEvals = JSON.parse(read('skills/reel-from-donor/evals/evals.json'));
  assert.match(JSON.stringify(donorEvals), /не задаёт серию вопросов/iu);
});

test('all public adapters advertise the autonomous route chooser', () => {
  for (const prefix of ['.agents', '.claude', '.codex']) {
    for (const skill of ['reel-turnkey', 'reel-from-donor']) {
      const adapter = read(`${prefix}/skills/${skill}/SKILL.md`);
      assert.match(adapter, /Creative Motion/u);
      assert.match(adapter, /skills\/(?:reel-turnkey|reel-from-donor)\/SKILL\.md/u);
    }
  }

  const canonicalMotion = read('skills/motion-reel/SKILL.md');
  for (const prefix of ['.agents', '.codex']) {
    assert.equal(read(`${prefix}/skills/motion-reel/SKILL.md`), canonicalMotion);
  }
});

test('motion layer brief and creative motion start with the kit and its gates', () => {
  const brief = read('skills/reel-turnkey/references/motion-layer-brief.md');
  for (const rule of [
    'automontage layer new', 'automontage layer check', '70/130/250/420', '2,5 с', 'muted',
    'public/SOURCE.md', 'hook: \'enumeration\'', 'waivers',
    // Кадры слоя – одной командой через API Remotion: он не читает .env движка (envVariables пустые,
    // tests/layer-stills.test.js), а покадровый `npx remotion still` стоил 10–30 с на кадр.
    'automontage layer stills', 'не используй его', 'cover: true', 'automontage inbox --accept',
  ]) {
    assert.ok(brief.includes(rule), rule);
  }
  // Слепое пятно G5: манифест знает только движение kit, сдвиг из кода сцены и текст внутри
  // media/bleed гейт не видит – субагент двигает текст полями плана и проверяет кадрами.
  assert.match(brief, words('код сцены не сдвигает текст за пределы `box`: движение – через `enter`/`exit` и поля плана'));
  assert.match(brief, words('текст внутри `media`/`bleed` гейт не проверяет – проверяй кадрами и `layer sheet`'));
  // Не просто упоминание /api/approve, а запрет: утверждает только владелец.
  assert.match(brief, /не утверждай[^\n]*\n?[^\n]*не вызывай API пульта \(`\/api\/approve`\)/u);
  assert.doesNotMatch(brief, /\/Users\/|\/home\/|projects\/20\d\d/u);
  assert.doesNotMatch(brief, /\u2014/u);
  const creative = read('skills/reel-turnkey/references/creative-motion.md');
  assert.match(creative, /automontage layer new/);
  assert.match(creative, /audioMode: "mix"/);
  assert.match(creative, /motion-layer-brief\.md/);
  const checklist = read('skills/reel-turnkey/references/qa-checklist.md');
  assert.match(checklist, /2,5 секунды/);
  assert.match(checklist, /automontage layer check/);
  assert.match(checklist, words('Сдвиг, который добавляет код сцены внутри `KitBox`'));
  // Правило баланса делится по типу голоса, а не по слою kit: живая запись – 12–18 dB по qa:preview,
  // голос аватара (со слоем kit и без него) – баланс утверждённого эталона, ~38 LU по G8 (D-035).
  const turnkey = read('skills/reel-turnkey/SKILL.md');
  assert.match(checklist, words('Живая запись (свой голос с микрофона): под речью музыка примерно на 12–18 dB ниже голоса'));
  assert.match(checklist, words('Голос аватара (ElevenLabs или HeyGen), со слоем kit и без него: баланс как в утверждённом эталоне'));
  assert.match(creative, words('«12–18 dB, 8–10 dB по просьбе» относится только к живой записи'));
  assert.match(turnkey, words('Голос аватара (ElevenLabs или HeyGen), со слоем kit и без него: ориентир – утверждённый эталон'));
  for (const [name, text] of [['checklist', checklist], ['creative', creative], ['turnkey', turnkey]]) {
    // Аватар-ролик без слоя kit не должен попасть под 12–18 dB: музыка стала бы тише утверждённого вкуса.
    assert.doesNotMatch(text, /без\s+слоя\s+kit[^.]{0,60}12–18\s+dB|12–18\s+dB[^.]{0,80}без\s+слоя\s+kit/u, name);
  }
  for (const [name, text] of [['brief', brief], ['creative', creative], ['checklist', checklist]]) {
    assert.match(text, words('откалиброван по утверждённому эталонному preview'), name);
    assert.match(text, words('35–41 LU, стоп ниже 3 LU или выше 46 LU'), name);
    // Просьба «музыку слышнее» – разрыв меньше на 6–8 LU, предупреждение ожидаемо.
    assert.match(text, /6–8 (?:LU|дБ)[\s\S]{0,80}предупреждение G8[\s\S]{0,20}ожидаемо/u, name);
    // Музыку ведёт утверждённый рецепт: ради гейта против вкуса владельца её не меняют.
    assert.match(text, words('Против вкуса владельца музыку ради гейта не меня'), name);
    assert.doesNotMatch(text, /заглушк[^\n]*G8|G8[^\n]*заглушк|до калибровки/u, name);
  }
});

test('reel skills start motion layers from the kit and gate them before the pult', () => {
  for (const file of ['skills/motion-reel/SKILL.md', 'skills/reel-from-donor/SKILL.md', 'skills/reel-turnkey/SKILL.md']) {
    const text = read(file);
    assert.match(text, /automontage layer new/, file);
    assert.match(text, /automontage layer check/, file);
    assert.match(text, /motion-layer-brief\.md/, file);
    const block = text.split('## Motion-слой из kit')[1]?.split('\n## ')[0];
    assert.ok(block, `${file}: нет блока «Motion-слой из kit»`);
    for (const step of ['automontage layer render', 'automontage layer import', 'automontage layer brief',
      'automontage preview', 'automontage layer sheet', 'automontage layer stock', 'docs/MOTION-KIT.md']) {
      assert.ok(block.includes(step), `${file}: ${step}`);
    }
    // Отчёты preview бывают с ⚠️: в пульт не пускает только ❌, а не «зелёный» итог.
    assert.match(block, /без ❌/u, file);
    assert.doesNotMatch(text, /зелёными отчётами/u, file);
    // layer sheet работает с текущим preview, а не с рендером слоя.
    assert.match(block, /layer sheet[^\n]*\n?[^\n]*текущего preview/u, file);
    // Откалиброванный G8: утверждённый рецепт музыки проходит, «слышнее» даёт ожидаемое предупреждение,
    // а музыку ради гейта против вкуса владельца не меняют.
    assert.match(block, words('Коридор G8 для аватара откалиброван по утверждённому эталону'), file);
    assert.match(block, words('предупреждение вне 35–41 LU, стоп ниже 3 или выше 46 LU'), file);
    assert.match(block, words('`layer brief --music <трек>` по умолчанию собирает утверждённый рецепт'), file);
    assert.match(block, words('на 6–8 дБ: предупреждение G8 тогда ожидаемо'), file);
    assert.match(block, words('Против вкуса владельца музыку ради гейта не меня'), file);
    assert.doesNotMatch(block, /заглушк|до калибровки|без `--music`/u, file);
    // Утверждает только владелец.
    assert.match(block, /Утверждает только владелец[\s\S]{0,40}«Утверждаю» в пульте[\s\S]{0,20}«утверждаю»\s+в\s+чате/u, file);
    assert.doesNotMatch(block, /\u2014/u, file);
    assert.doesNotMatch(block, /\/Users\/|\/home\/|projects\/20\d\d/u, file);
  }

  const motion = read('skills/motion-reel/SKILL.md');
  // Ролик только из озвучки остаётся на встроенном MotionReel; kit – для аватара или спикера в кадре.
  assert.match(motion, /без видео спикера[^\n]*\n?[^\n]*встроенным `MotionReel`, как раньше/u);
  assert.match(motion, /kit нужен, когда в кадре есть аватар или спикер/iu);
  // Известный пробел D-038: preview motion-reel барьер гейтов не проверяет.
  assert.match(motion, /барьер[\s\S]{0,80}D-038/u);

  // Слой kit несёт звук эффектов: mix, а немой по умолчанию только слой без kit.
  const turnkey = read('skills/reel-turnkey/SKILL.md');
  assert.match(turnkey, /Слой kit подключается с `audioMode: "mix"`/u);
  assert.match(turnkey, /--audio mute/u);
  assert.doesNotMatch(turnkey, /`brollMedia` с `audioMode: mute`/u);
});

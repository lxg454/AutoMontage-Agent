const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { main } = require('../scripts/broll/live-acceptance');
const { validateProvenance } = require('../scripts/broll/provenance');
const { makeReviewProject } = require('./helpers/review-project');
const SECRET = 'private-live-test-key';
function candidate(mediaKind, id) {
  return {
    provider: 'pexels',
    providerAssetId: String(id),
    mediaKind,
    width: 100,
    height: 100,
    durationSec: mediaKind === 'video' ? 3 : null,
    sourcePage: `https://www.pexels.com/${mediaKind === 'image' ? 'photo' : 'video'}/fixture-${id}/`,
    author: { name: 'José', url: 'https://www.pexels.com/@fixture' },
    license: { name: 'Pexels License', url: 'https://www.pexels.com/license/' },
    queryOriginal: 'nature',
    queryEnglish: 'nature',
    retrievedAt: '2026-09-08T00:00:00.000Z',
    rendition: {
      id: 'original',
      width: 100,
      height: 100,
      mimeType: mediaKind === 'image' ? 'image/png' : 'video/mp4',
    },
    thumbnailUrl: `https://images.pexels.com/${id}-thumb.png`,
    previewUrl:
      mediaKind === 'image'
        ? `https://images.pexels.com/${id}-preview.png`
        : null,
    downloadUrl: `https://${mediaKind === 'image' ? 'images' : 'videos'}.pexels.com/${id}-full.${mediaKind === 'image' ? 'png' : 'mp4'}`,
  };
}
function harness(extra = {}) {
  const requests = [],
    imports = [],
    logs = [];
  return {
    requests,
    imports,
    logs,
    deps: {
      loadBrollConfig: () => ({ provider: 'pexels', apiKey: SECRET }),
      createPexelsProvider: (config) => {
        assert.equal(config.apiKey, SECRET);
        return {
          search: async ({ mediaKind }) => ({
            candidates: [candidate(mediaKind, mediaKind === 'image' ? 1 : 2)],
          }),
        };
      },
      requestRemote: async (options) => {
        requests.push(options);
        return {
          bytes: Buffer.from('fixture-bytes'),
          contentType: options.expectedMimeTypes.includes('video/mp4')
            ? 'video/mp4'
            : 'image/png',
        };
      },
      importReviewMedia: async (options) => {
        imports.push(options);
        return { version: 3 };
      },
      log: (line) => logs.push(line),
      ...extra,
    },
  };
}
test('missing key produces exact skip without search or remote work', async () => {
  const h = harness({
    loadBrollConfig: () => {
      throw Object.assign(new Error(SECRET), { code: 'BROLL_KEY_MISSING' });
    },
  });
  await main([], h.deps);
  assert.deepEqual(h.logs, ['SKIPPED: PEXELS_API_KEY or PIXABAY_API_KEY is not configured']);
  assert.equal(h.requests.length, 0);
});
test('search-only probes bounded renditions, never downloads full or imports', async () => {
  const h = harness();
  await main([], h.deps);
  assert.equal(h.requests.length, 3);
  assert.equal(
    h.requests.some((r) => r.url.includes('full')),
    false,
  );
  assert.equal(h.imports.length, 0);
  assert.equal(JSON.stringify(h.logs).includes(SECRET), false);
});
test('explicit selection imports exactly one candidate with v3 provenance and fixture FPS', async (t) => {
  const fixture = makeReviewProject(t);
  const before = fs.readFileSync(path.join(fixture.projectDir, 'project.json'));
  const h = harness();
  await main(
    ['--select', 'video:2', '--project-dir', fixture.projectDir],
    h.deps,
  );
  assert.equal(h.requests.filter((r) => r.url.includes('full')).length, 1);
  assert.equal(h.imports.length, 1);
  const selected = h.imports[0];
  assert.equal(selected.outputFps, 25);
  assert.equal(selected.projectDir, fixture.projectDir);
  assert.equal(validateProvenance(selected.provenance).providerAssetId, '2');
  assert.equal(selected.headers['content-type'], 'video/mp4');
  assert.ok(selected.controller);
  assert.equal(typeof selected.runMediaProcessImpl, 'function');
  const chunks = [];
  for await (const chunk of selected.request) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'fixture-bytes');
  assert.deepEqual(
    fs.readFileSync(path.join(fixture.projectDir, 'project.json')),
    before,
  );
});
test('malformed/duplicate arguments and missing candidate fail without full import', async (t) => {
  const fixture = makeReviewProject(t);
  for (const args of [
    ['--bad', 'value'],
    ['--select', 'image:1'],
    ['--query', 'cat', '--query', 'dog'],
    ['--select', 'image:9', '--project-dir', fixture.projectDir],
  ]) {
    const h = harness();
    await assert.rejects(
      main(args, h.deps),
      (e) =>
        [
          'BROLL_LIVE_ARGUMENTS_INVALID',
          'BROLL_LIVE_FIXTURE_NOT_FOUND',
        ].includes(e.code) && !e.message.includes(SECRET),
    );
    assert.equal(
      h.requests.some((r) => r.url.includes('full')),
      false,
    );
    assert.equal(h.imports.length, 0);
  }
});
test('invalid fixture project fails before any remote work and errors never echo secrets', async (t) => {
  const fixture = makeReviewProject(t);
  fs.writeFileSync(path.join(fixture.projectDir, 'project.json'), SECRET);
  const h = harness();
  await assert.rejects(
    main(['--select', 'image:1', '--project-dir', fixture.projectDir], h.deps),
    {
      code: 'BROLL_LIVE_PROJECT_INVALID',
      message: 'BROLL_LIVE_PROJECT_INVALID',
    },
  );
  assert.equal(h.requests.length, 0);
  const hostile = harness({
    requestRemote: async () => {
      throw new Error(SECRET);
    },
  });
  await assert.rejects(main([], hostile.deps), {
    code: 'BROLL_LIVE_FAILED',
    message: 'BROLL_LIVE_FAILED',
  });
});
test('selected import failures remain fixed errors without key or upstream payload', async (t) => {
  const fixture = makeReviewProject(t);
  const h = harness({
    importReviewMedia: async () => {
      throw new Error(`upstream ${SECRET}`);
    },
  });
  await assert.rejects(
    main(['--select', 'image:1', '--project-dir', fixture.projectDir], h.deps),
    { code: 'BROLL_LIVE_FAILED', message: 'BROLL_LIVE_FAILED' },
  );
  assert.equal(h.requests.filter((r) => r.url.includes('full')).length, 1);
  assert.equal(JSON.stringify(h.logs).includes(SECRET), false);
});
test('selected MIME mismatch never reaches importer', async (t) => {
  const fixture = makeReviewProject(t);
  const h = harness({
    requestRemote: async (options) => ({
      bytes: Buffer.from('bad'),
      contentType: options.url.includes('full') ? 'text/html' : 'image/png',
    }),
  });
  await assert.rejects(
    main(['--select', 'image:1', '--project-dir', fixture.projectDir], h.deps),
    { code: 'BROLL_LIVE_FAILED' },
  );
  assert.equal(h.imports.length, 0);
});

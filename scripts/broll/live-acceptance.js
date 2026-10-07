#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { Readable } = require('node:stream');
const { loadBrollConfig } = require('./config');
const { createSearchProvider, providerInfo } = require('./providers');
const { requestRemote, LIMITS, failure } = require('./remote');
async function runLive(args, {
  loadBrollConfig: loadConfig = loadBrollConfig,
  // createPexelsProvider – прежнее имя подмены в тестах; createProvider – для любого провайдера.
  createPexelsProvider,
  createProvider = createPexelsProvider || createSearchProvider,
  requestRemote: request = requestRemote,
  importReviewMedia: importMedia = require('../review/media-import').importReviewMedia,
  log = console.log,
} = {}) {
  let config;
  try {
    config = loadConfig({ root: path.resolve(__dirname, '../..') });
  } catch (error) {
    if (error.code === 'BROLL_KEY_MISSING') {
      log('SKIPPED: PEXELS_API_KEY or PIXABAY_API_KEY is not configured');
      return;
    }
    throw error;
  }
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (
      !['--query', '--select', '--project-dir'].includes(args[i]) ||
      !args[i + 1] || Object.hasOwn(options, args[i])
    )
      throw failure('BROLL_LIVE_ARGUMENTS_INVALID');
    options[args[i]] = args[i + 1];
  }
  if (
    Boolean(options['--select']) !== Boolean(options['--project-dir']) ||
    (options['--select'] &&
      !/^(image|video):[1-9][0-9]*$/.test(options['--select']))
  )
    throw failure('BROLL_LIVE_ARGUMENTS_INVALID');
  let projectDir, outputFps;
  if (options['--select']) {
    try {
      projectDir = path.resolve(options['--project-dir']);
      const { loadReviewBase } = require('../review/model');
      const { resolveProjectPath } = require('../project/workspace');
      const base = loadReviewBase({ projectDir });
      resolveProjectPath(projectDir, base.workspace.manifest.source.localPath, {
        label: 'live fixture source', mustExist: true, type: 'file',
      });
      outputFps = base.brief.output.fps;
    } catch { throw failure('BROLL_LIVE_PROJECT_INVALID'); }
  }
  const provider = createProvider(config),
    { imageHosts: IMAGE_HOSTS, videoHosts: VIDEO_HOSTS } = providerInfo(config.provider),
    found = [];
  log(`provider: ${config.provider}`);
  for (const mediaKind of ['image', 'video']) {
    const query = options['--query'] || 'nature';
    const { candidates } = await provider.search({
      queryOriginal: query,
      queryEnglish: query,
      mediaKind,
    });
    found.push(...candidates);
    log(
      `${mediaKind}: ${candidates.length} candidates; IDs ${candidates.map((c) => c.providerAssetId).join(',')}`,
    );
    const card = candidates[0];
    if (card) {
      await request({
        url: card.thumbnailUrl,
        allowedHosts: IMAGE_HOSTS,
        maxBytes: LIMITS.thumbnail,
        expectedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      });
      if (card.previewUrl)
        await request({
          url: card.previewUrl,
          allowedHosts: mediaKind === 'video' ? VIDEO_HOSTS : IMAGE_HOSTS,
          maxBytes: LIMITS.preview,
          expectedMimeTypes:
            mediaKind === 'video'
              ? ['video/mp4']
              : ['image/jpeg', 'image/png', 'image/webp'],
        });
    }
  }
  if (!options['--select']) {
    log('SEARCH/PROXY PASSED; selection not requested');
    return;
  }
  const candidate = found.find(
    (c) => `${c.mediaKind}:${c.providerAssetId}` === options['--select'],
  );
  if (!candidate) throw failure('BROLL_LIVE_FIXTURE_NOT_FOUND');
  const { candidateProvenance } = require('../review/broll-discovery');
  const provenance = candidateProvenance(candidate);
  const response = await request({
    url: candidate.downloadUrl,
    allowedHosts: candidate.mediaKind === 'video' ? VIDEO_HOSTS : IMAGE_HOSTS,
    maxBytes: LIMITS[candidate.mediaKind],
    timeoutMs: 120000,
    expectedMimeTypes: [candidate.rendition.mimeType],
  });
  const {
    createImportController,
  } = require('../review/media-import');
  const { runMediaProcess } = require('../review/media-process');
  const extension = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp','video/mp4':'mp4'}[candidate.rendition.mimeType];
  if (!extension || response.contentType !== candidate.rendition.mimeType || !Buffer.isBuffer(response.bytes) || !response.bytes.length || response.bytes.length > LIMITS[candidate.mediaKind]) throw failure('BROLL_LIVE_FAILED');
  const filename = `${candidate.provider}-${candidate.providerAssetId}.${extension}`;
  await importMedia({
    request: Readable.from([response.bytes]),
    projectDir,
    outputFps,
    provenance,
    headers: {
      'content-type': response.contentType,
      'content-length': String(response.bytes.length),
      'x-automontage-filename': filename,
    },
    controller: createImportController(),
    runMediaProcessImpl: runMediaProcess,
  });
  log(
    'SELECTED FIXTURE IMPORT PASSED; no brief approval or final render performed',
  );
}
async function main(args = process.argv.slice(2), dependencies) {
  try { return await runLive(args, dependencies); }
  catch (error) {
    const codes = ['BROLL_LIVE_ARGUMENTS_INVALID', 'BROLL_LIVE_FIXTURE_NOT_FOUND', 'BROLL_LIVE_PROJECT_INVALID'];
    throw failure(codes.includes(error?.code) ? error.code : 'BROLL_LIVE_FAILED');
  }
}
if (require.main === module)
  main().catch(() => {
    console.error('BROLL_LIVE_FAILED');
    process.exitCode = 1;
  });
module.exports = { main };

'use strict';
const https = require('node:https');
const dns = require('node:dns').promises;
const net = require('node:net');
const LIMITS = Object.freeze({api: 2 * 1024 ** 2, thumbnail: 5 * 1024 ** 2, preview: 32 * 1024 ** 2, image: 25 * 1024 ** 2, video: 256 * 1024 ** 2});
function failure(code = 'BROLL_REMOTE_REJECTED') { return Object.assign(new Error(code), {code}); }
function isPublicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (net.isIP(address) !== 6 || address.includes('.')) return false;
  // Accept only ordinary global-unicast 2000::/3, excluding special-purpose ranges.
  // This deliberately rejects IPv4-mapped/translated, NAT64, ULA and link-local forms.
  const [head, second = '0'] = address.toLowerCase().split(':');
  const first = parseInt(head, 16), next = parseInt(second || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (next < 0x200 || next === 0xdb8)) && !(first === 0x3fff);
}
function validateUrl(value, allowedHosts) {
  let url;
  try { url = new URL(value); } catch { throw failure(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      net.isIP(url.hostname.replace(/^\[|\]$/g, '')) || !Array.isArray(allowedHosts) ||
      !allowedHosts.includes(url.hostname)) throw failure();
  return url;
}
async function requestRemote({url, allowedHosts, headers = {}, signal, maxBytes, timeoutMs = 15000,
  expectedMimeTypes, maxRedirects = 3, lookup = dns.lookup.bind(dns), requestImpl = https.request} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > LIMITS.video ||
      !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120000 ||
      !Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 3 ||
      !Array.isArray(expectedMimeTypes) || !expectedMimeTypes.length) throw failure();
  let activeRequest, activeResponse, settled = false, timer, abort;
  const operation = async () => {
    let current = validateUrl(url, allowedHosts);
    const initialHost = current.hostname;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (settled || signal?.aborted) throw failure('BROLL_REMOTE_ABORTED');
      const records = await lookup(current.hostname, {all:true, verbatim:true});
      if (settled) throw failure('BROLL_REMOTE_ABORTED');
      if (!Array.isArray(records) || !records.length || records.some(r => !isPublicAddress(r.address) || net.isIP(r.address) !== r.family)) throw failure();
      const pinned = records[0];
      const safeHeaders = {'Accept-Encoding':'identity'};
      // Never forward user-controlled Host, Cookie, proxy headers or credentials to CDN.
      for (const [key,value] of Object.entries(headers)) {
        if (key.toLowerCase() === 'accept') safeHeaders.Accept = value;
        if (key.toLowerCase() === 'authorization' && initialHost === 'api.pexels.com' && current.hostname === initialHost && hop === 0) safeHeaders.Authorization = value;
      }
      const result = await new Promise((resolve,reject) => {
        const options = {method:'GET', headers:safeHeaders, agent:false, servername:current.hostname,
          rejectUnauthorized:true, maxHeaderSize:16384,
          lookup:(_hostname, opts, callback) => {
            if (typeof opts === 'function') { callback = opts; opts = {}; }
            if (opts?.all) callback(null, [{address:pinned.address,family:pinned.family}]);
            else callback(null, pinned.address, pinned.family);
          }};
        activeRequest = requestImpl(current, options, response => {
          activeResponse = response;
          const bad = () => { reject(failure()); response.destroy(); };
          if ([301,302,303,307,308].includes(response.statusCode)) {
            const location = response.headers.location;
            response.on('error', () => {});
            response.destroy();
            if (!location || hop === maxRedirects) return reject(failure());
            try { resolve({redirect:validateUrl(new URL(location, current).href, allowedHosts)}); } catch { reject(failure()); }
            return;
          }
          // 429: провайдер просит подождать – отдельный код, чтобы человек видел понятную причину.
          // Retry-After – только целые секунды 0–60; иначе провайдер решает сам (retryAfterSec: null).
          if (response.statusCode === 429) {
            const header = String(response.headers['retry-after'] || '');
            const retryAfterSec = /^\d{1,2}$/.test(header) && Number(header) <= 60 ? Number(header) : null;
            reject(Object.assign(failure('BROLL_REMOTE_RATE_LIMITED'), {retryAfterSec}));
            response.on('error', () => {}); response.destroy(); return;
          }
          response.on('error', bad); response.on('aborted', bad);
          const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
          const encoding = response.headers['content-encoding'];
          const declared = response.headers['content-length'];
          if (response.statusCode !== 200 || (encoding && encoding !== 'identity') ||
              !expectedMimeTypes.includes(type) || (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes))) return bad();
          let size = 0; const chunks = [];
          response.on('data', chunk => { size += chunk.length; if (size > maxBytes) return bad(); chunks.push(chunk); });
          response.on('end', () => {
            if (!response.complete || !size || (declared !== undefined && size !== Number(declared))) return bad();
            resolve({bytes:Buffer.concat(chunks, size),contentType:type,url:current.href});
          });
          response.on('close', () => { if (!response.complete) reject(failure()); });
        });
        activeRequest.on('error', () => reject(failure()));
        activeRequest.end();
      });
      if (result.redirect) current = result.redirect; else return result;
    }
    throw failure();
  };
  try {
    return await Promise.race([operation(), new Promise((_,reject) => {
      abort = () => reject(failure('BROLL_REMOTE_ABORTED'));
      timer = setTimeout(() => reject(failure('BROLL_REMOTE_TIMEOUT')), timeoutMs);
      signal?.addEventListener('abort', abort, {once:true});
      if (signal?.aborted) abort();
    })]);
  } catch (error) {
    if (error?.code === 'BROLL_REMOTE_RATE_LIMITED') throw Object.assign(failure(error.code), {retryAfterSec: error.retryAfterSec ?? null});
    throw failure(['BROLL_REMOTE_ABORTED','BROLL_REMOTE_TIMEOUT'].includes(error?.code) ? error.code : 'BROLL_REMOTE_REJECTED');
  } finally {
    settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
    activeResponse?.destroy(); activeRequest?.destroy();
  }
}
module.exports = {requestRemote, isPublicAddress, validateUrl, LIMITS, failure};

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { requestRemote, isPublicAddress } = require('../scripts/broll/remote');
const base = {
  url: 'https://images.pexels.com/a.jpg',
  allowedHosts: ['images.pexels.com'],
  maxBytes: 16,
  timeoutMs: 300,
  expectedMimeTypes: ['image/jpeg'],
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
};
for (const url of [
  'http://127.0.0.1/a',
  'https://images.pexels.com.evil/a',
  'https://user:secret@images.pexels.com/a',
  'https://images.pexels.com:444/a',
  'https://127.1/a',
  'https://[::1]/a',
  'https://images.pexels.com./a',
])
  test(`reject URL ${url}`, async () =>
    assert.rejects(requestRemote({ ...base, url }), {
      code: 'BROLL_REMOTE_REJECTED',
    }));
for (const ip of [
  '127.0.0.1',
  '10.1.2.3',
  '169.254.169.254',
  '100.64.0.1',
  '192.0.0.8',
  '192.0.2.1',
  '198.18.0.1',
  '224.1.1.1',
  '0.0.0.0',
  '::1',
  '::ffff:8.8.8.8',
  'fc00::1',
  'fe80::1',
  '2001:db8::1',
  '2002:0808:0808::1',
])
  test(`reject DNS ${ip}`, async () => {
    assert.equal(isPublicAddress(ip), false);
    await assert.rejects(
      requestRemote({
        ...base,
        lookup: async () => [{ address: ip, family: ip.includes(':') ? 6 : 4 }],
      }),
      { code: 'BROLL_REMOTE_REJECTED' },
    );
  });
test('public IPv4 and global IPv6 accepted', () => {
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
async function mock(t, handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return (url, options, callback) =>
    http.request(
      {
        hostname: '127.0.0.1',
        port: server.address().port,
        path: url.pathname,
        headers: options.headers,
        method: 'GET',
        agent: false,
      },
      callback,
    );
}
test('local contract accepts bytes and pins vetted DNS with no cookies', async (t) => {
  let pinned;
  const requestImpl = await mock(t, (req, res) => {
    assert.equal(req.headers.cookie, undefined);
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '3' });
    res.end('abc');
  });
  const result = await requestRemote({
    ...base,
    headers: { Cookie: 'secret' },
    requestImpl: (url, options, cb) => {
      options.lookup('images.pexels.com', {}, (e, address) => {
        pinned = address;
      });
      return requestImpl(url, options, cb);
    },
  });
  assert.equal(result.bytes.toString(), 'abc');
  assert.equal(pinned, '93.184.216.34');
});
for (const kind of [
  'oversize',
  'declared',
  'compressed',
  'mime',
  'partial',
  'error',
  'timeout',
  'redirect-private',
  'redirect-loop',
])
  test(`contract rejects ${kind}`, async (t) => {
    const requestImpl = await mock(t, (req, res) => {
      if (kind === 'timeout') return;
      res.setHeader('content-type', 'image/jpeg');
      if (kind === 'compressed') res.setHeader('content-encoding', 'gzip');
      if (kind === 'mime') res.setHeader('content-type', 'text/html');
      if (kind === 'declared') res.setHeader('content-length', '999');
      if (kind === 'partial') {
        res.setHeader('content-length', '8');
        res.write('a');
        return setTimeout(() => res.destroy(), 5);
      }
      if (kind === 'error') res.statusCode = 500;
      if (kind.startsWith('redirect')) {
        res.statusCode = 302;
        res.setHeader(
          'location',
          kind === 'redirect-private' ? 'https://127.0.0.1/a' : base.url,
        );
      }
      res.end(kind === 'oversize' ? 'x'.repeat(30) : 'secret');
    });
    await assert.rejects(
      requestRemote({ ...base, requestImpl }),
      (e) => e.code.startsWith('BROLL_') && !e.message.includes('secret'),
    );
  });
test('DNS and abort bounded before request', async () => {
  await assert.rejects(
    requestRemote({
      ...base,
      timeoutMs: 10,
      lookup: () => new Promise(() => {}),
    }),
    { code: 'BROLL_REMOTE_TIMEOUT' },
  );
  const c = new AbortController();
  c.abort();
  await assert.rejects(requestRemote({ ...base, signal: c.signal }), {
    code: 'BROLL_REMOTE_ABORTED',
  });
});
test('mixed public/private answers fail closed', async () =>
  assert.rejects(
    requestRemote({
      ...base,
      lookup: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '::1', family: 6 },
      ],
    }),
    { code: 'BROLL_REMOTE_REJECTED' },
  ));
test('authorization only on initial official API host', async (t) => {
  let count = 0;
  const requestImpl = await mock(t, (req, res) => {
    count++;
    assert.equal(req.headers.authorization, count === 1 ? 'secret' : undefined);
    if (count === 1) {
      res.writeHead(302, { location: 'https://images.pexels.com/a' });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.end('abc');
    }
  });
  await requestRemote({
    ...base,
    url: 'https://api.pexels.com/a',
    allowedHosts: ['api.pexels.com', 'images.pexels.com'],
    headers: { Authorization: 'secret' },
    requestImpl,
  });
  assert.equal(count, 2);
});
test('abort during body stream destroys connection', async (t) => {
  const controller = new AbortController();
  const requestImpl = await mock(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.write('a');
    controller.abort();
  });
  await assert.rejects(
    requestRemote({ ...base, requestImpl, signal: controller.signal }),
    { code: 'BROLL_REMOTE_ABORTED' },
  );
});
test('redirect revalidates DNS rather than reusing first host address', async (t) => {
  let lookups = 0;
  const requestImpl = await mock(t, (req, res) => {
    res.writeHead(302, { location: 'https://images.pexels.com/next' });
    res.end();
  });
  await assert.rejects(
    requestRemote({
      ...base,
      requestImpl,
      lookup: async () => [
        { address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 },
      ],
    }),
    { code: 'BROLL_REMOTE_REJECTED' },
  );
  assert.equal(lookups, 2);
});
test('429 from a provider is a distinct rate-limit code without the response body', async (t) => {
  const requestImpl = await mock(t, (req, res) => {
    res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '3' });
    res.end('secret rate limit');
  });
  await assert.rejects(requestRemote({ ...base, requestImpl }),
    (e) => e.code === 'BROLL_REMOTE_RATE_LIMITED' && !e.message.includes('secret'));
});
test('Authorization header is still sent only to api.pexels.com, never to Pixabay', async (t) => {
  let seen;
  const requestImpl = await mock(t, (req, res) => {
    seen = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '2' });
    res.end('{}');
  });
  await requestRemote({ ...base, url: 'https://pixabay.com/api/?q=cat', allowedHosts: ['pixabay.com'],
    expectedMimeTypes: ['application/json'], headers: { Authorization: 'secret' }, requestImpl });
  assert.equal(seen, undefined);
});
test('429 carries Retry-After seconds only when it is a small integer', async (t) => {
  for (const [header, expected] of [['3', 3], ['600', null], ['Wed, 21 Oct 2015 07:28:00 GMT', null]]) {
    const requestImpl = await mock(t, (req, res) => { res.writeHead(429, { 'retry-after': header }); res.end(); });
    await assert.rejects(requestRemote({ ...base, requestImpl }), (e) => e.code === 'BROLL_REMOTE_RATE_LIMITED' && e.retryAfterSec === expected);
  }
});

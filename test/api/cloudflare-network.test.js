import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransportWithDependencies } from '../../server/cloudflare/network.js';

const PROXY = 'http://4.144.146.21:80';
const HOSTS = ['media.example', 'other.example'];
const missing = () => Promise.reject(Object.assign(new Error('No AAAA answer'), { code: 'ENODATA' }));

function harness({ responses = [() => new Response('source')], ipv4 = async () => ['8.8.8.8'], ipv6 = missing } = {}) {
  const requests = [], tunnels = [], origins = [], socketConnections = [];
  let configured, socketCloses = 0, clientCloses = 0;
  const dependencies = {
    resolve4: ipv4, resolve6: ipv6,
    loadConnect: async () => (address, options) => {
      socketConnections.push({ address, options });
      let finish;
      return {
        readable: new ReadableStream({ start(controller) { controller.close(); } }),
        writable: new WritableStream(),
        opened: Promise.resolve(), closed: new Promise(resolve => { finish = resolve; }),
        async close() { socketCloses++; finish(); },
      };
    },
    async openTunnel(options) {
      tunnels.push(options.target);
      return options.connect({ hostname: options.proxy.hostname, port: options.proxy.port }, { secureTransport: 'off' });
    },
    Client: class {
      constructor(options) { configured = options; this.options = options; }
      async fetch(value, options) {
        const url = new URL(value);
        origins.push(url.hostname);
        const socket = this.options.connect({ hostname: url.hostname, port: 443 });
        await socket.opened;
        assert.ok(socket.readable);
        assert.ok(socket.writable);
        requests.push({ url: value, headers: new Headers(options.headers), redirect: options.redirect });
        return (responses.shift() || (() => new Response('source')))();
      }
      async close() { clientCloses++; }
    },
  };
  const transport = createTransportWithDependencies(PROXY, dependencies);
  return { transport, requests, tunnels, origins, socketConnections, dependencies,
    get options() { return configured; }, get socketCloses() { return socketCloses; }, get clientCloses() { return clientCloses; } };
}

async function text(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('Cloudflare transport pins CONNECT to checked IP and retains original TLS identity', async () => {
  const h = harness();
  try {
    const response = await h.transport.request('https://media.example/file', { hosts: HOSTS, headers: { Range: 'bytes=0-1023' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.finalURL, 'https://media.example/file');
    assert.equal(await text(response), 'source');
    assert.deepEqual(h.tunnels, [{ hostname: '8.8.8.8', port: 443 }]);
    assert.deepEqual(h.origins, ['media.example']);
    assert.equal(h.requests[0].headers.get('range'), 'bytes=0-1023');
    assert.equal(h.requests[0].redirect, 'manual');
    assert.deepEqual(h.options.trust, { mode: 'system' });
    assert.equal(h.options.forceTunnel, true);
    assert.equal(h.options.maxBodyBytes, 32 * 1024 * 1024);
  } finally { await h.transport.close(); }
  assert.equal(h.socketCloses, 1);
  assert.equal(h.clientCloses, 1);
});

test('Cloudflare transport rejects private answers in either address family before CONNECT', async () => {
  const h = harness({ ipv6: async () => ['::1'] });
  await assert.rejects(h.transport.request('https://media.example/file', { hosts: HOSTS }), { code: 'UNSAFE_UPSTREAM' });
  assert.equal(h.tunnels.length, 0);
  await h.transport.close();
});

test('Cloudflare transport checks each redirect and removes cross-origin credentials', async () => {
  const h = harness({ responses: [
    () => new Response('', { status: 302, headers: { Location: 'https://other.example/next' } }),
    () => new Response('ok'),
  ] });
  try {
    const response = await h.transport.request('https://media.example/file', {
      hosts: HOSTS, headers: { authorization: 'secret', Cookie: 'session=secret', 'Proxy-Authorization': 'proxy-secret', Range: 'bytes=0-3' },
    });
    assert.equal(await text(response), 'ok');
    assert.equal(h.requests[0].headers.get('authorization'), 'secret');
    assert.equal(h.requests[0].headers.get('proxy-authorization'), null);
    for (const name of ['authorization', 'cookie', 'proxy-authorization']) assert.equal(h.requests[1].headers.get(name), null);
    assert.equal(h.requests[1].headers.get('range'), 'bytes=0-3');
  } finally { await h.transport.close(); }

  const unsafe = harness({ responses: [() => new Response('', { status: 302, headers: { Location: 'http://media.example/file' } })] });
  await assert.rejects(unsafe.transport.request('https://media.example/file', { hosts: HOSTS }), { code: 'UNSAFE_UPSTREAM' });
  assert.equal(unsafe.requests.length, 1);
  await unsafe.transport.close();
});

test('Cloudflare transport deadline includes DNS and prevents later reuse', async () => {
  const h = harness({ ipv4: () => new Promise(() => {}) });
  await assert.rejects(h.transport.request('https://media.example/file', { hosts: HOSTS, timeout: 20 }), { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(h.tunnels.length, 0);
  await assert.rejects(h.transport.request('https://media.example/file', { hosts: HOSTS }), { code: 'UPSTREAM_CLOSED' });
});

test('Cloudflare transport body deadline closes pending response and proxy socket', async () => {
  const h = harness({ responses: [() => new Response(new ReadableStream())] });
  const response = await h.transport.request('https://media.example/file', { hosts: HOSTS, timeout: 30 });
  await assert.rejects(text(response), { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(h.socketCloses, 1);
  assert.equal(h.clientCloses, 1);
});

test('Cloudflare transport closes a proxy stalled before CONNECT reply', async () => {
  const h = harness();
  h.dependencies.openTunnel = async options => {
    options.connect({ hostname: options.proxy.hostname, port: options.proxy.port }, { secureTransport: 'off' });
    return new Promise(() => {});
  };
  await assert.rejects(h.transport.request('https://media.example/file', { hosts: HOSTS, timeout: 20 }), { code: 'UPSTREAM_TIMEOUT' });
  assert.equal(h.socketCloses, 1);
  await h.transport.close();
});

test('Cloudflare transport never exposes malformed proxy credentials in configuration errors', () => {
  assert.throws(() => createTransportWithDependencies('http://secret-user:super-secret@proxy.example/%', {}), error => {
    assert.equal(error.code, 'PROXY_CONFIGURATION');
    assert.equal(error.message.includes('secret'), false);
    return true;
  });
});

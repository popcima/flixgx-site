import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublicProxyAgent, parseProxyURL } from '../../server/api/proxy.js';

const lookup = (host, options, done) => done(null, '8.8.8.8', 4);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const get = (url, options) => new Promise((resolve, reject) => {
  const req = https.get(url, options, async response => {
    try { let body = ''; for await (const chunk of response) body += chunk; resolve({ status: response.statusCode, body }); }
    catch (error) { reject(error); }
  });
  req.on('error', reject);
});

test('proxy settings reject media URLs and malformed secrets without echoing credentials', () => {
  assert.equal(parseProxyURL('http://user:p%40ss@proxy.example:8080').port, '8080');
  for (const value of ['socks5://user:secret@proxy.example', 'https://proxy.example/manifest.mpd?url=x', 'http://user:%ZZ@proxy.example', 'not-a-url-secret']) {
    assert.throws(() => parseProxyURL(value), error => !error.message.includes('secret') && /UPSTREAM_PROXY_URL/.test(error.message));
  }
});

test('proxy CONNECT pins public DNS, authenticates origin TLS and isolates proxy credentials', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'flixgx-proxy-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=stream.example', '-addext', 'subjectAltName=DNS:stream.example',
    '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')], { stdio: 'ignore' });
  const ca = readFileSync(join(dir, 'cert.pem'));
  const originHeaders = [], connections = [], sockets = new Set();
  const origin = https.createServer({ key: readFileSync(join(dir, 'key.pem')), cert: ca }, (req, res) => {
    originHeaders.push(req.headers);
    res.writeHead(206, { 'Content-Type': 'text/plain', 'Content-Range': 'bytes 0-3/4' }); res.end('test');
  });
  await listen(origin);
  const proxy = http.createServer();
  proxy.on('connect', (req, socket, head) => {
    connections.push({ target: req.url, headers: req.headers });
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    sockets.add(upstream); upstream.on('error', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  proxy.on('connection', socket => sockets.add(socket));
  await listen(proxy);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all([new Promise(r => proxy.close(r)), new Promise(r => origin.close(r))]); });
  const agent = new PublicProxyAgent(`http://proxy-user:proxy-test-secret@127.0.0.1:${proxy.address().port}`, { lookupTarget: lookup });
  t.after(() => agent.destroy());
  const result = await get('https://stream.example/media', { agent, ca, headers: { Range: 'bytes=0-3', Authorization: 'Bearer origin-test-secret' } });
  assert.deepEqual(result, { status: 206, body: 'test' });
  assert.equal(connections[0].target, '8.8.8.8:443');
  assert.equal(connections[0].headers['proxy-authorization'], `Basic ${Buffer.from('proxy-user:proxy-test-secret').toString('base64')}`);
  assert.equal(connections[0].headers.authorization, undefined);
  assert.equal(originHeaders[0]['proxy-authorization'], undefined);
  assert.equal(originHeaders[0].host, 'stream.example');
  assert.equal(originHeaders[0].range, 'bytes=0-3');
  assert.equal(originHeaders[0].authorization, 'Bearer origin-test-secret');
  await assert.rejects(get('https://wrong.example/media', { agent, ca }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const before = connections.length;
  const privateAgent = new PublicProxyAgent(`http://127.0.0.1:${proxy.address().port}`, { lookupTarget: (h, o, done) => done(null, '127.0.0.1', 4) });
  t.after(() => privateAgent.destroy());
  await assert.rejects(get('https://stream.example/media', { agent: privateAgent, ca }), { code: 'UNSAFE_UPSTREAM' });
  assert.equal(connections.length, before);
});

test('proxy authentication failures and stalled tunnels fail without direct fallback', async t => {
  const sockets = new Set(); let failAuth = true, attempts = 0;
  const proxy = http.createServer();
  proxy.on('connection', socket => sockets.add(socket));
  proxy.on('connect', (req, socket) => {
    attempts++;
    assert.equal(req.headers.authorization, undefined);
    if (failAuth) socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  await listen(proxy);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); });
  const agent = new PublicProxyAgent(`http://127.0.0.1:${proxy.address().port}`, { lookupTarget: lookup, connectTimeout: 100 });
  t.after(() => agent.destroy());
  await assert.rejects(get('https://stream.example/', { agent, headers: { Authorization: 'Bearer origin-test-secret' } }), { code: 'PROXY_AUTH_REQUIRED' });
  failAuth = false;
  await assert.rejects(get('https://stream.example/', { agent }), { code: 'PROXY_TIMEOUT' });
  assert.equal(attempts, 2);
});

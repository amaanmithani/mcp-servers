import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '../../src/lib/errors.ts';
import { httpConfigSchema, type HttpConfig } from '../../src/servers/http/config.ts';
import { Fetcher, hostAllowed, type Resolver } from '../../src/servers/http/fetcher.ts';

let srv: Server;
let port: number;
// 10 MB of 'a' compresses to ~10 KB. Computed once.
const BOMB = gzipSync(Buffer.alloc(10_000_000, 0x61));

beforeAll(async () => {
  srv = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    switch (u.pathname) {
      case '/html':
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><head><title>T</title></head><body><p>Hello <b>world</b></p></body></html>');
        return;
      case '/json':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"a":1}');
        return;
      case '/big':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('y'.repeat(100_000));
        return;
      case '/bomb':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
        res.end(BOMB);
        return;
      case '/weird-encoding':
        res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'zstd' });
        res.end('x');
        return;
      case '/image':
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(Buffer.from([0x89, 0x50]));
        return;
      case '/slow':
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('start');
        setTimeout(() => res.end('late'), 2_000).unref();
        return;
      case '/redirect':
        res.writeHead(302, { location: u.searchParams.get('to') ?? '/html' });
        res.end();
        return;
      case '/loop':
        res.writeHead(301, { location: '/loop' });
        res.end();
        return;
      case '/404':
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not here');
        return;
      default:
        res.writeHead(500);
        res.end();
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  port = (srv.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => srv.close(() => r())));

// Fake DNS: "good.test" is the local test server; the others simulate attacker-controlled DNS.
const resolver: Resolver = async (host) => {
  const table: Record<string, Array<{ address: string; family: number }>> = {
    'good.test': [{ address: '127.0.0.1', family: 4 }],
    'rebind.test': [{ address: '10.0.0.5', family: 4 }],
    'metadata.test': [{ address: '169.254.169.254', family: 4 }],
    'mixed.test': [
      { address: '127.0.0.1', family: 4 },
      { address: '192.168.0.1', family: 4 },
    ],
    'v6.test': [{ address: '::ffff:10.0.0.1', family: 6 }],
    'empty.test': [],
  };
  const hit = table[host];
  if (!hit) throw new Error('ENOTFOUND');
  return hit;
};

function cfgWith(over: Partial<HttpConfig> = {}): HttpConfig {
  return httpConfigSchema.parse({
    allowedHosts: [
      'good.test',
      'rebind.test',
      'metadata.test',
      'mixed.test',
      'v6.test',
      'empty.test',
      'nx.test',
      '127.0.0.1',
      '*.wild.test',
    ],
    allowedSchemes: ['http', 'https'],
    allowedPorts: [80, 443, port],
    // Only the test server's exact address is exempt from the private-IP block.
    allowCidrs: ['127.0.0.1/32'],
    timeoutMs: 5_000,
    maxBytes: 50_000,
    ...over,
  });
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof ToolError ? e.code : 'X';
  }
}

describe('hostAllowed', () => {
  it('matches exact and wildcard hosts, case-insensitively', () => {
    expect(hostAllowed('Docs.Example.com.', ['docs.example.com'])).toBe(true);
    expect(hostAllowed('a.b.wild.test', ['*.wild.test'])).toBe(true);
    expect(hostAllowed('wild.test', ['*.wild.test'])).toBe(false);
    expect(hostAllowed('evilwild.test', ['*.wild.test'])).toBe(false);
    expect(hostAllowed('example.com.evil.net', ['example.com'])).toBe(false);
  });
});

describe('Fetcher: allowed fetches', () => {
  it('fetches HTML and converts it to text', async () => {
    const f = new Fetcher(cfgWith(), resolver);
    const r = await f.fetch(`http://good.test:${port}/html`);
    expect(r).toMatchObject({ status: 200, title: 'T', text: 'Hello world', truncated: false });
  });
  it('passes JSON through untouched and reports non-2xx statuses', async () => {
    const f = new Fetcher(cfgWith(), resolver);
    expect((await f.fetch(`http://good.test:${port}/json`)).text).toBe('{"a":1}');
    expect((await f.fetch(`http://good.test:${port}/404`)).status).toBe(404);
  });
  it('follows redirects within the allowlist', async () => {
    const f = new Fetcher(cfgWith(), resolver);
    const r = await f.fetch(`http://good.test:${port}/redirect`);
    expect(r.finalUrl).toBe(`http://good.test:${port}/html`);
    expect(r.redirects).toHaveLength(1);
  });
  it('truncates at maxBytes (config and per-call)', async () => {
    const f = new Fetcher(cfgWith(), resolver);
    const r = await f.fetch(`http://good.test:${port}/big`);
    expect(r.bytes).toBe(50_000);
    expect(r.truncated).toBe(true);
    expect((await f.fetch(`http://good.test:${port}/big`, 10)).text).toBe('y'.repeat(10));
  });
  it('cuts a gzip bomb off at maxBytes of decompressed output', async () => {
    const f = new Fetcher(cfgWith(), resolver);
    const r = await f.fetch(`http://good.test:${port}/bomb`);
    expect(r.bytes).toBe(50_000);
    expect(r.truncated).toBe(true);
  });
});

describe('Fetcher: SSRF and policy enforcement', () => {
  const f = () => new Fetcher(cfgWith(), resolver);
  it('blocks hostnames that resolve to private / metadata addresses (DNS rebinding)', async () => {
    expect(await code(f().fetch(`http://rebind.test:${port}/`))).toBe('FORBIDDEN');
    expect(await code(f().fetch('http://metadata.test/latest/meta-data/'))).toBe('FORBIDDEN');
    expect(await code(f().fetch(`http://v6.test:${port}/`))).toBe('FORBIDDEN');
  });
  it('blocks if ANY resolved address is private', async () => {
    expect(await code(f().fetch(`http://mixed.test:${port}/html`))).toBe('FORBIDDEN');
  });
  it('blocks without exemption even for the local server', async () => {
    const strict = new Fetcher(cfgWith({ allowCidrs: [] }), resolver);
    expect(await code(strict.fetch(`http://good.test:${port}/html`))).toBe('FORBIDDEN');
    expect(await code(strict.fetch(`http://127.0.0.1:${port}/html`))).toBe('FORBIDDEN');
  });
  it('blocks redirects to disallowed hosts and private IP literals', async () => {
    const toEvil = encodeURIComponent('http://evil.example/');
    expect(await code(f().fetch(`http://good.test:${port}/redirect?to=${toEvil}`))).toBe(
      'FORBIDDEN',
    );
    const toMeta = encodeURIComponent('http://169.254.169.254/latest/meta-data/');
    expect(await code(f().fetch(`http://good.test:${port}/redirect?to=${toMeta}`))).toBe(
      'FORBIDDEN',
    );
    const toRebind = encodeURIComponent(`http://rebind.test:${port}/`);
    expect(await code(f().fetch(`http://good.test:${port}/redirect?to=${toRebind}`))).toBe(
      'FORBIDDEN',
    );
    const toFile = encodeURIComponent('file:///etc/passwd');
    expect(await code(f().fetch(`http://good.test:${port}/redirect?to=${toFile}`))).toBe(
      'FORBIDDEN',
    );
  });
  it('limits redirect chains', async () => {
    expect(await code(f().fetch(`http://good.test:${port}/loop`))).toBe('FORBIDDEN');
  });
  it('enforces scheme, port, credentials and host allowlists', async () => {
    expect(await code(f().fetch('file:///etc/passwd'))).toBe('FORBIDDEN');
    expect(await code(f().fetch('ftp://good.test/x'))).toBe('FORBIDDEN');
    expect(await code(f().fetch('http://good.test:22/'))).toBe('FORBIDDEN');
    expect(await code(f().fetch('http://user:pw@good.test/'))).toBe('FORBIDDEN');
    expect(await code(f().fetch('http://not-listed.example/'))).toBe('FORBIDDEN');
    expect(await code(f().fetch('not a url'))).toBe('INVALID_INPUT');
    const httpsOnly = new Fetcher(cfgWith({ allowedSchemes: ['https'] }), resolver);
    expect(await code(httpsOnly.fetch(`http://good.test:${port}/html`))).toBe('FORBIDDEN');
  });
  it('canonicalises obfuscated IP literals before checking them', async () => {
    const cfg = cfgWith({ allowedHosts: ['127.0.0.1'], allowCidrs: [] });
    const g = new Fetcher(cfg, resolver);
    for (const u of [
      'http://0x7f.0.0.1/',
      'http://2130706433/',
      'http://127.1/',
      'http://0177.0.0.1/',
    ]) {
      expect(await code(g.fetch(u))).toBe('FORBIDDEN');
    }
    const v6 = new Fetcher(
      cfgWith({ allowedHosts: ['[::ffff:7f00:1]', '::ffff:7f00:1'], allowCidrs: [] }),
      resolver,
    );
    expect(await code(v6.fetch('http://[::ffff:127.0.0.1]/'))).toBe('FORBIDDEN');
  });
  it('rejects unsupported content types and encodings', async () => {
    expect(await code(f().fetch(`http://good.test:${port}/image`))).toBe('UPSTREAM_ERROR');
    expect(await code(f().fetch(`http://good.test:${port}/weird-encoding`))).toBe('UPSTREAM_ERROR');
  });
  it('reports DNS failures and empty answers', async () => {
    expect(await code(f().fetch(`http://nx.test:${port}/`))).toBe('UPSTREAM_ERROR');
    expect(await code(f().fetch(`http://empty.test:${port}/`))).toBe('UPSTREAM_ERROR');
  });
  it('times out slow responses', async () => {
    const quick = new Fetcher(cfgWith({ timeoutMs: 200 }), resolver);
    expect(await code(quick.fetch(`http://good.test:${port}/slow`))).toBe('TIMEOUT');
  });
});

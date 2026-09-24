import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ToolError, okResult, toErrorResult } from '../../src/lib/errors.ts';
import { createLogger, parseLogLevel } from '../../src/lib/logger.ts';
import { TokenBucket, ToolRateLimiter } from '../../src/lib/rateLimit.ts';
import { loadSqliteConfig } from '../../src/servers/sqlite/config.ts';
import { loadHttpConfig } from '../../src/servers/http/config.ts';
import { loadFsConfig } from '../../src/servers/fs/config.ts';

describe('TokenBucket', () => {
  it('allows a burst up to capacity, then refills over time', () => {
    let t = 0;
    const b = new TokenBucket({ capacity: 3, refillPerSecond: 2 }, () => t);
    expect([b.tryTake(), b.tryTake(), b.tryTake()]).toEqual([0, 0, 0]);
    expect(b.tryTake()).toBe(500); // needs half a second for one token at 2/s
    t += 500;
    expect(b.tryTake()).toBe(0);
    t += 10_000;
    expect(b.available()).toBe(3); // never exceeds capacity
  });
  it('validates config', () => {
    expect(() => new TokenBucket({ capacity: 0, refillPerSecond: 1 })).toThrow(RangeError);
    expect(() => new TokenBucket({ capacity: 1, refillPerSecond: 0 })).toThrow(RangeError);
  });
  it('keeps independent buckets per tool', () => {
    const l = new ToolRateLimiter({ capacity: 1, refillPerSecond: 1 }, () => 0);
    expect(l.tryTake('a')).toBe(0);
    expect(l.tryTake('a')).toBeGreaterThan(0);
    expect(l.tryTake('b')).toBe(0);
  });
});

describe('logger', () => {
  it('writes JSON lines, respects level, and supports child fields', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'info',
      base: { server: 's' },
      write: (l) => lines.push(l),
      now: () => new Date(0),
    });
    log.debug('hidden');
    log.info('hello', { n: 1, big: 2n, err: new Error('boom') });
    log.child({ tool: 't' }).warn('w');
    log.error('e');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0] as string)).toEqual({
      ts: '1970-01-01T00:00:00.000Z',
      level: 'info',
      msg: 'hello',
      server: 's',
      n: 1,
      big: '2',
      err: { name: 'Error', message: 'boom' },
    });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ tool: 't', server: 's', level: 'warn' });
    expect(lines.every((l) => l.endsWith('\n'))).toBe(true);
  });
  it('survives unserializable fields', () => {
    const lines: string[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    createLogger({ write: (l) => lines.push(l) }).info('x', { cyclic });
    expect(JSON.parse(lines[0] as string).note).toBe('unserializable fields');
  });
  it('parses levels', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('nope')).toBe('info');
    expect(parseLogLevel(undefined, 'warn')).toBe('warn');
  });
});

describe('errors', () => {
  it('formats ToolErrors and hides unknown errors', () => {
    const r = toErrorResult(new ToolError('FORBIDDEN', 'no', { a: 1 }));
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(JSON.parse(r.content[0]?.type === 'text' ? r.content[0].text : '')).toEqual({
      error: { code: 'FORBIDDEN', message: 'no', details: { a: 1 } },
    });
    const u = toErrorResult(new Error('secret internals at /home/x'));
    expect(JSON.stringify(u)).not.toContain('secret');
    expect(u.content).toEqual([
      {
        type: 'text',
        text: '{"error":{"code":"INTERNAL","message":"Internal error while running tool"}}',
      },
    ]);
  });
  it('builds ok results', () => {
    expect(okResult({ a: 1 })).toEqual({
      content: [{ type: 'text', text: '{"a":1}' }],
      structuredContent: { a: 1 },
    });
    expect(okResult({ a: 1 }, 'hi').content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

describe('config loading', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('merges defaults < file < env', () => {
    const file = join(dir, 'sqlite.json');
    writeFileSync(
      file,
      JSON.stringify({ dbPath: '/from/file.db', maxRows: 10, rateLimit: { capacity: 5 } }),
    );
    const cfg = loadSqliteConfig({
      SQLITE_MCP_CONFIG: file,
      SQLITE_MAX_ROWS: '20',
      MCP_LOG_LEVEL: 'debug',
    });
    expect(cfg).toEqual({
      dbPath: '/from/file.db',
      maxRows: 20,
      timeoutMs: 2000,
      logLevel: 'debug',
      rateLimit: { capacity: 5, refillPerSecond: 10 },
    });
  });
  it('parses list env vars', () => {
    const cfg = loadHttpConfig({ HTTP_ALLOWED_HOSTS: 'a.com, *.b.org ,', MCP_RATE_CAPACITY: '7' });
    expect(cfg.allowedHosts).toEqual(['a.com', '*.b.org']);
    expect(cfg.allowedSchemes).toEqual(['https']);
    expect(cfg.rateLimit.capacity).toBe(7);
  });
  it('reports invalid or missing config clearly', () => {
    expect(() => loadFsConfig({})).toThrow(/Invalid configuration: root/);
    expect(() => loadSqliteConfig({ SQLITE_DB_PATH: 'x', SQLITE_MAX_ROWS: 'abc' })).toThrow(
      /maxRows/,
    );
    expect(() => loadSqliteConfig({ SQLITE_MCP_CONFIG: join(dir, 'missing.json') })).toThrow(
      /Could not read/,
    );
    const arr = join(dir, 'arr.json');
    writeFileSync(arr, '[]');
    expect(() => loadSqliteConfig({ SQLITE_MCP_CONFIG: arr })).toThrow(/JSON object/);
  });
});

/**
 * In-process tests of each server's MCP surface (tool registration, schemas,
 * structured output, error shape, rate limiting) over an in-memory transport.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createFsServer } from '../../src/servers/fs/server.ts';
import { createHttpServer } from '../../src/servers/http/server.ts';
import { createSqliteServer } from '../../src/servers/sqlite/server.ts';
import { call, common, connect, errCode, silentLogger } from '../helpers.ts';

const SAMPLE_DB = resolve('data/sample.db');

describe('sqlite-readonly server', () => {
  let client: Client;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const s = createSqliteServer(
      { ...common, dbPath: SAMPLE_DB, maxRows: 50, timeoutMs: 1000 },
      silentLogger,
    );
    close = s.close;
    client = await connect(s.server);
  });
  afterAll(async () => {
    await client.close();
    await close();
  });

  it('advertises three read-only tools with output schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['describe_table', 'list_tables', 'query']);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true && t.outputSchema)).toBe(true);
  });
  it('lists tables and views', async () => {
    const r = await call(client, 'list_tables');
    expect(r.structuredContent?.tables).toEqual([
      { name: 'customers', type: 'table' },
      { name: 'order_items', type: 'table' },
      { name: 'order_totals', type: 'view' },
      { name: 'orders', type: 'table' },
      { name: 'products', type: 'table' },
    ]);
  });
  it('describes a table', async () => {
    const r = await call(client, 'describe_table', { table: 'orders' });
    expect(r.structuredContent).toMatchObject({
      table: 'orders',
      type: 'table',
      foreignKeys: [{ column: 'customer_id', references: 'customers(id)' }],
      indexes: [{ name: 'idx_orders_customer', unique: false }],
    });
    expect(
      errCode(await call(client, 'describe_table', { table: 'x"; DROP TABLE orders; --' })),
    ).toBe('NOT_FOUND');
  });
  it('runs SELECTs with params and caps rows', async () => {
    const r = await call(client, 'query', {
      sql: 'SELECT id, status FROM orders WHERE id <= ? ORDER BY id',
      params: [3],
    });
    expect(r.structuredContent).toMatchObject({
      columns: ['id', 'status'],
      rowCount: 3,
      truncated: false,
    });
    const big = await call(client, 'query', { sql: 'SELECT * FROM orders', limit: 1000 });
    expect(big.structuredContent).toMatchObject({ rowCount: 50, truncated: true });
  });
  it('rejects writes and stacked statements with FORBIDDEN', async () => {
    expect(errCode(await call(client, 'query', { sql: 'DELETE FROM orders' }))).toBe('FORBIDDEN');
    expect(errCode(await call(client, 'query', { sql: 'SELECT 1; DROP TABLE orders' }))).toBe(
      'FORBIDDEN',
    );
    expect(errCode(await call(client, 'query', { sql: 'SELECT * FROM nope' }))).toBe(
      'INVALID_INPUT',
    );
  });
  it('kills runaway queries at the timeout and recovers', async () => {
    const started = Date.now();
    const r = await call(client, 'query', {
      sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c',
    });
    expect(errCode(r)).toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(5000);
    const ok = await call(client, 'query', { sql: 'SELECT count(*) AS n FROM customers' });
    expect(ok.structuredContent?.rows).toEqual([[200]]);
  });
  it('rate-limits per tool', async () => {
    const s = createSqliteServer(
      {
        ...common,
        rateLimit: { capacity: 2, refillPerSecond: 0.001 },
        dbPath: SAMPLE_DB,
        maxRows: 5,
        timeoutMs: 1000,
      },
      silentLogger,
    );
    const c = await connect(s.server);
    await call(c, 'list_tables');
    await call(c, 'list_tables');
    const limited = await call(c, 'list_tables');
    expect(errCode(limited)).toBe('RATE_LIMITED');
    expect(errCode(await call(c, 'describe_table', { table: 'orders' }))).toBeUndefined();
    await c.close();
    await s.close();
  });
});

describe('fs-sandbox server', () => {
  let dir: string;
  let client: Client;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fssrv-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'main.ts'), 'export const answer = 42;\n');
    const s = createFsServer(
      {
        ...common,
        root: dir,
        maxReadBytes: 1000,
        maxListEntries: 100,
        maxSearchResults: 10,
        maxSearchFiles: 100,
        maxSearchFileBytes: 10_000,
        searchTimeoutMs: 1000,
      },
      silentLogger,
    );
    client = await connect(s.server);
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exposes list_dir, read_file and search', async () => {
    expect((await call(client, 'list_dir')).structuredContent?.entries).toEqual([
      { name: 'src', type: 'directory', size: 0 },
    ]);
    const f = await call(client, 'read_file', { path: 'src/main.ts' });
    expect(f.content?.[0]?.text).toBe('export const answer = 42;\n');
    const s = await call(client, 'search', { pattern: 'answer\\s*=', regex: true });
    expect(s.structuredContent?.hits).toEqual([
      { path: 'src/main.ts', line: 1, text: 'export const answer = 42;' },
    ]);
  });
  it('returns FORBIDDEN for traversal', async () => {
    expect(errCode(await call(client, 'read_file', { path: '../../../etc/passwd' }))).toBe(
      'FORBIDDEN',
    );
  });
});

describe('http-fetch server', () => {
  let srv: Server;
  let port: number;
  let client: Client;
  beforeAll(async () => {
    srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Hi</title><p>Body</p>');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    port = (srv.address() as AddressInfo).port;
    const s = createHttpServer(
      {
        ...common,
        allowedHosts: ['local.test'],
        allowedSchemes: ['http'],
        allowedPorts: [port],
        allowCidrs: ['127.0.0.1/32'],
        maxBytes: 10_000,
        timeoutMs: 2000,
        maxRedirects: 2,
        userAgent: 'test',
      },
      silentLogger,
      async () => [{ address: '127.0.0.1', family: 4 }],
    );
    client = await connect(s.server);
  });
  afterAll(async () => {
    await client.close();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('fetches and converts', async () => {
    const r = await call(client, 'fetch', { url: `http://local.test:${port}/` });
    expect(r.structuredContent).toMatchObject({ status: 200, title: 'Hi', text: 'Body' });
  });
  it('rejects hosts outside the allowlist', async () => {
    expect(errCode(await call(client, 'fetch', { url: 'http://169.254.169.254/' }))).toBe(
      'FORBIDDEN',
    );
  });
});

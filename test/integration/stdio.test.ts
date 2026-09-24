/**
 * End-to-end: spawn each server as a real child process and talk to it over
 * stdio with the official SDK client, exactly as Claude Desktop would.
 * Servers run from TypeScript source via Node's built-in type stripping.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, errCode } from '../helpers.ts';

const entry = (name: string) => resolve('src/servers', name, 'index.ts');

async function spawnServer(name: string, env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry(name)],
    env: { ...getDefaultEnvironment(), MCP_LOG_LEVEL: 'warn', ...env },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (d: Buffer) => stderr.push(d.toString()));
  const client = new Client({ name: 'integration', version: '0.0.0' });
  await client.connect(transport);
  return { client, stderr };
}

describe('sqlite-readonly over stdio', () => {
  let client: Client;
  beforeAll(async () => {
    ({ client } = await spawnServer('sqlite', {
      SQLITE_DB_PATH: resolve('data/sample.db'),
      SQLITE_TIMEOUT_MS: '1000',
    }));
  });
  afterAll(() => client.close());

  it('lists, describes and queries', async () => {
    const tables = await call(client, 'list_tables');
    expect((tables.structuredContent?.tables as unknown[]).length).toBe(5);
    const d = await call(client, 'describe_table', { table: 'customers' });
    expect((d.structuredContent?.columns as Array<{ name: string }>).map((c) => c.name)).toEqual([
      'id',
      'name',
      'email',
      'city',
      'created_at',
    ]);
    const q = await call(client, 'query', {
      sql: 'SELECT category, COUNT(*) AS n FROM products GROUP BY category ORDER BY category LIMIT 2',
    });
    expect(q.structuredContent?.columns).toEqual(['category', 'n']);
    expect(q.structuredContent?.rowCount).toBe(2);
  });

  it('refuses writes and times out runaway queries', async () => {
    expect(errCode(await call(client, 'query', { sql: 'DROP TABLE customers' }))).toBe('FORBIDDEN');
    const r = await call(client, 'query', {
      sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT max(x) FROM c',
    });
    expect(errCode(r)).toBe('TIMEOUT');
    expect(
      (await call(client, 'query', { sql: 'SELECT 1 AS one' })).structuredContent?.rows,
    ).toEqual([[1]]);
  });
});

describe('fs-sandbox over stdio', () => {
  let dir: string;
  let client: Client;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fs-int-'));
    mkdirSync(join(dir, 'root', 'notes'), { recursive: true });
    writeFileSync(join(dir, 'root', 'notes', 'todo.md'), '- buy milk\n- ship v1\n');
    writeFileSync(join(dir, 'secret'), 'password=hunter2');
    symlinkSync(join(dir, 'secret'), join(dir, 'root', 'innocent.md'));
    ({ client } = await spawnServer('fs', { FS_ROOT: join(dir, 'root') }));
  });
  afterAll(async () => {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists, reads and searches inside the root', async () => {
    const l = await call(client, 'list_dir', { path: '.' });
    expect(l.structuredContent?.entries).toEqual([
      { name: 'innocent.md', type: 'symlink', size: 0 },
      { name: 'notes', type: 'directory', size: 0 },
    ]);
    const f = await call(client, 'read_file', { path: 'notes/todo.md' });
    expect(f.structuredContent?.content).toContain('ship v1');
    const s = await call(client, 'search', { pattern: 'SHIP' });
    expect(s.structuredContent?.hits).toEqual([
      { path: 'notes/todo.md', line: 2, text: '- ship v1' },
    ]);
  });

  it('blocks traversal and symlink escapes', async () => {
    expect(errCode(await call(client, 'read_file', { path: '../secret' }))).toBe('FORBIDDEN');
    expect(errCode(await call(client, 'read_file', { path: 'innocent.md' }))).toBe('FORBIDDEN');
    const s = await call(client, 'search', { pattern: 'hunter2' });
    expect(s.structuredContent?.hits).toEqual([]);
  });
});

describe('http-fetch over stdio', () => {
  let srv: Server;
  let port: number;
  let client: Client;
  let stderr: string[];
  beforeAll(async () => {
    srv = createServer((req, res) => {
      if (req.url === '/redirect-out') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<html><head><title>Local</title></head><body><h2>Docs</h2><p>It works.</p></body></html>',
      );
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    port = (srv.address() as AddressInfo).port;
    ({ client, stderr } = await spawnServer('http', {
      HTTP_ALLOWED_HOSTS: 'localhost',
      HTTP_ALLOWED_SCHEMES: 'http',
      HTTP_ALLOW_CIDRS: '127.0.0.1/32,::1/128',
      HTTP_MCP_CONFIG: writeTmpJson({ allowedPorts: [port] }),
    }));
  });
  afterAll(async () => {
    await client.close();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('fetches an allowlisted page and converts HTML', async () => {
    const r = await call(client, 'fetch', { url: `http://localhost:${port}/` });
    expect(r.structuredContent).toMatchObject({
      status: 200,
      title: 'Local',
      text: '## Docs\n\nIt works.',
    });
  });

  it('blocks non-allowlisted hosts and redirects to the metadata service', async () => {
    expect(errCode(await call(client, 'fetch', { url: 'http://169.254.169.254/' }))).toBe(
      'FORBIDDEN',
    );
    expect(
      errCode(await call(client, 'fetch', { url: `http://localhost:${port}/redirect-out` })),
    ).toBe('FORBIDDEN');
  });

  it('logs only to stderr, as JSON lines', () => {
    const lines = stderr.join('').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines.filter((x) => x.startsWith('{')))
      expect(() => JSON.parse(l)).not.toThrow();
    expect(stderr.join('')).toContain('private-address exemptions enabled');
  });
});

function writeTmpJson(obj: unknown): string {
  const d = mkdtempSync(join(tmpdir(), 'cfg-'));
  const p = join(d, 'config.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

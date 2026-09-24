import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '../../src/lib/errors.ts';
import { fsConfigSchema, type FsConfig } from '../../src/servers/fs/config.ts';
import { canonicalRoot } from '../../src/servers/fs/guard.ts';
import { listDir, looksBinary, readFileCapped, search } from '../../src/servers/fs/ops.ts';
import { compileMatcher } from '../../src/servers/fs/regex.ts';

let base: string;
let root: string;
let cfg: FsConfig;

beforeAll(() => {
  base = canonicalRoot(mkdtempSync(join(tmpdir(), 'fsops-')));
  root = join(base, 'root');
  mkdirSync(join(root, 'docs', 'nested'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'readme.md'), '# Title\nTODO: write docs\nfin\n');
  writeFileSync(join(root, 'docs', 'guide.md'), 'Intro\nSee TODO list\ntodo lowercase\n');
  writeFileSync(join(root, 'docs', 'nested', 'n.txt'), 'nothing here\nTODO nested\n');
  writeFileSync(join(root, 'node_modules', 'pkg', 'x.js'), 'TODO in deps');
  writeFileSync(join(root, 'big.txt'), 'x'.repeat(5000));
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0x41, 0, 0x42]));
  writeFileSync(join(base, 'outside.txt'), 'TODO outside secret');
  symlinkSync(join(base, 'outside.txt'), join(root, 'leak.txt'));
  symlinkSync(base, join(root, 'leakdir'));
  cfg = fsConfigSchema.parse({ root, maxReadBytes: 1000, maxListEntries: 50 });
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof ToolError ? e.code : 'X';
  }
}

describe('listDir', () => {
  it('lists sorted entries and reports symlinks without following', async () => {
    const r = await listDir(cfg, root, '.');
    const names = r.entries.map((e) => e.name);
    expect(names).toEqual([...names].sort());
    expect(r.entries.find((e) => e.name === 'leak.txt')?.type).toBe('symlink');
    expect(r.entries.find((e) => e.name === 'docs')?.type).toBe('directory');
    expect(r.entries.find((e) => e.name === 'big.txt')?.size).toBe(5000);
    expect(r.truncated).toBe(false);
  });
  it('truncates at maxListEntries', async () => {
    const r = await listDir({ ...cfg, maxListEntries: 2 }, root, '');
    expect(r.entries).toHaveLength(2);
    expect(r.truncated).toBe(true);
  });
  it('rejects files and escapes', async () => {
    expect(await code(listDir(cfg, root, 'readme.md'))).toBe('INVALID_INPUT');
    expect(await code(listDir(cfg, root, 'leakdir'))).toBe('FORBIDDEN');
  });
});

describe('readFileCapped', () => {
  it('reads text', async () => {
    const r = await readFileCapped(cfg, root, 'readme.md');
    expect(r.content).toContain('TODO');
    expect(r.truncated).toBe(false);
  });
  it('caps size at config and per-call limits', async () => {
    const r = await readFileCapped(cfg, root, 'big.txt');
    expect(r.content).toHaveLength(1000);
    expect(r.truncated).toBe(true);
    expect((await readFileCapped(cfg, root, 'big.txt', 10)).content).toHaveLength(10);
    expect((await readFileCapped(cfg, root, 'big.txt', 999_999)).content).toHaveLength(1000);
  });
  it('rejects binary, directories and symlink escapes', async () => {
    expect(await code(readFileCapped(cfg, root, 'bin.dat'))).toBe('INVALID_INPUT');
    expect(await code(readFileCapped(cfg, root, 'docs'))).toBe('INVALID_INPUT');
    expect(await code(readFileCapped(cfg, root, 'leak.txt'))).toBe('FORBIDDEN');
    expect(await code(readFileCapped(cfg, root, '../outside.txt'))).toBe('FORBIDDEN');
  });
});

describe('search', () => {
  it('finds case-insensitive substrings, skipping node_modules and symlinks', async () => {
    const r = await search(cfg, root, { pattern: 'todo' });
    const paths = r.hits.map((h) => `${h.path}:${h.line}`);
    // Files in a directory are scanned before its subdirectories.
    expect(paths).toEqual([
      'readme.md:2',
      'docs/guide.md:2',
      'docs/guide.md:3',
      'docs/nested/n.txt:2',
    ]);
    expect(r.stopReason).toBe('complete');
    expect(r.hits.some((h) => h.text.includes('outside'))).toBe(false);
  });
  it('supports case-sensitive regex and a sub-path', async () => {
    const r = await search(cfg, root, {
      pattern: '^TODO\\b',
      regex: true,
      caseSensitive: true,
      path: 'docs',
    });
    expect(r.hits.map((h) => h.path)).toEqual(['docs/nested/n.txt']);
  });
  it('can search a single file', async () => {
    const r = await search(cfg, root, { pattern: 'fin', path: 'readme.md' });
    expect(r.hits).toEqual([{ path: 'readme.md', line: 3, text: 'fin' }]);
  });
  it('stops at maxResults and maxFiles', async () => {
    expect((await search(cfg, root, { pattern: 'todo', maxResults: 1 })).stopReason).toBe(
      'maxResults',
    );
    const r = await search({ ...cfg, maxSearchFiles: 1 }, root, { pattern: 'zzz' });
    expect(r.stopReason).toBe('maxFiles');
    expect(r.truncated).toBe(true);
  });
  it('stops at the time budget', async () => {
    let t = 0;
    const r = await search(cfg, root, { pattern: 'zzz' }, () => (t += 10_000));
    expect(r.stopReason).toBe('timeout');
  });
  it('refuses to start in an escaped directory', async () => {
    expect(await code(search(cfg, root, { pattern: 'TODO', path: 'leakdir' }))).toBe('FORBIDDEN');
  });
});

describe('compileMatcher', () => {
  it('validates patterns', () => {
    expect(() => compileMatcher('', { regex: false, caseSensitive: false })).toThrow(ToolError);
    expect(() => compileMatcher('x'.repeat(501), { regex: false, caseSensitive: false })).toThrow(
      ToolError,
    );
    expect(() => compileMatcher('(', { regex: true, caseSensitive: false })).toThrow(
      /Invalid regex/,
    );
  });
  it('kills catastrophic backtracking (ReDoS) within the budget', () => {
    const m = compileMatcher('(a+)+$', { regex: true, caseSensitive: true });
    const started = Date.now();
    expect(() => m(['a'.repeat(40) + '!'], 100)).toThrow(/ReDoS/);
    expect(Date.now() - started).toBeLessThan(2000);
    // The matcher is reusable after a timeout.
    expect(m(['aaa'], 100)).toEqual([0]);
  });
  it('detects binary', () => {
    expect(looksBinary(Buffer.from('abc'))).toBe(false);
    expect(looksBinary(Buffer.from([1, 0]))).toBe(true);
  });
});

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '../../src/lib/errors.ts';
import { canonicalRoot, displayPath, isWithin, resolveInRoot } from '../../src/servers/fs/guard.ts';

let base: string;
let root: string;

beforeAll(() => {
  base = canonicalRoot(mkdtempSync(join(tmpdir(), 'fsguard-')));
  root = join(base, 'root');
  mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
  mkdirSync(join(base, 'root-sibling'));
  writeFileSync(join(root, 'a.txt'), 'hello');
  writeFileSync(join(root, 'sub', 'deep', 'b.txt'), 'deep');
  writeFileSync(join(base, 'secret.txt'), 'TOP SECRET');
  writeFileSync(join(base, 'root-sibling', 'x.txt'), 'sibling');
  // Escapes
  symlinkSync(join(base, 'secret.txt'), join(root, 'abs-link-out'));
  symlinkSync('../secret.txt', join(root, 'rel-link-out'));
  symlinkSync('../../..', join(root, 'sub', 'deep', 'up'));
  symlinkSync(base, join(root, 'dir-link-out'));
  symlinkSync('/etc', join(root, 'etc'));
  // Chain: inside -> inside -> outside
  symlinkSync('hop2', join(root, 'hop1'));
  symlinkSync('../secret.txt', join(root, 'hop2'));
  // Loop
  symlinkSync('loop-b', join(root, 'loop-a'));
  symlinkSync('loop-a', join(root, 'loop-b'));
  // Allowed: symlink that stays inside
  symlinkSync('a.txt', join(root, 'ok-link'));
  symlinkSync('sub/deep', join(root, 'ok-dir-link'));
  // Dangling
  symlinkSync('does-not-exist', join(root, 'dangling'));
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

async function codeOf(p: string): Promise<string | undefined> {
  try {
    await resolveInRoot(root, p);
    return undefined;
  } catch (e) {
    return e instanceof ToolError ? e.code : 'NON_TOOL_ERROR';
  }
}

describe('isWithin', () => {
  it('handles prefix confusion (root vs root-sibling)', () => {
    expect(isWithin('/a/root', '/a/root')).toBe(true);
    expect(isWithin('/a/root', '/a/root/x')).toBe(true);
    expect(isWithin('/a/root', '/a/root-sibling/x')).toBe(false);
    expect(isWithin('/a/root', '/a')).toBe(false);
    expect(isWithin('/a/root', '/a/root/..x')).toBe(true); // a file literally named "..x"
  });
});

describe('resolveInRoot: allowed paths', () => {
  it.each([
    ['a.txt', 'a.txt'],
    ['/a.txt', 'a.txt'],
    ['./sub/../a.txt', 'a.txt'],
    ['sub/deep/b.txt', 'sub/deep/b.txt'],
    ['', '.'],
    ['.', '.'],
    ['ok-link', 'a.txt'],
    ['ok-dir-link/b.txt', 'sub/deep/b.txt'],
  ])('%s -> %s', async (input, expected) => {
    expect(displayPath(root, await resolveInRoot(root, input))).toBe(expected);
  });
});

describe('resolveInRoot: traversal attacks', () => {
  it.each([
    '../secret.txt',
    '../../../../../../etc/passwd',
    'sub/../../secret.txt',
    '../root-sibling/x.txt',
    '..',
    'sub/deep/../../../secret.txt',
  ])('lexical escape %s is FORBIDDEN', async (p) => {
    expect(await codeOf(p)).toBe('FORBIDDEN');
  });

  it.each([
    'abs-link-out',
    'rel-link-out',
    'dir-link-out/secret.txt',
    'dir-link-out',
    'sub/deep/up/secret.txt',
    'etc/passwd',
    'hop1',
  ])('symlink escape %s is FORBIDDEN', async (p) => {
    expect(await codeOf(p)).toBe('FORBIDDEN');
  });

  it('rejects symlink loops', async () => {
    expect(await codeOf('loop-a')).toBe('FORBIDDEN');
  });

  it('rejects NUL bytes and overlong paths', async () => {
    expect(await codeOf('a.txt\0.png')).toBe('INVALID_INPUT');
    expect(await codeOf('a/'.repeat(3000))).toBe('INVALID_INPUT');
  });

  it('reports missing and dangling paths as NOT_FOUND without leaking outside info', async () => {
    expect(await codeOf('nope.txt')).toBe('NOT_FOUND');
    expect(await codeOf('dangling')).toBe('NOT_FOUND');
    expect(await codeOf('a.txt/child')).toBe('NOT_FOUND');
  });

  it('treats backslashes as literal filename chars on POSIX', async () => {
    expect(await codeOf('..\\secret.txt')).toBe('NOT_FOUND');
  });

  it('works when the root itself is reached through a symlink', async () => {
    const linkedRoot = join(base, 'root-link');
    symlinkSync(root, linkedRoot);
    const canon = canonicalRoot(linkedRoot);
    expect(canon).toBe(root);
    expect(displayPath(canon, await resolveInRoot(canon, 'a.txt'))).toBe('a.txt');
  });

  it('requires a root', () => {
    expect(() => canonicalRoot('')).toThrow();
  });
});

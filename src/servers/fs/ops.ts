import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ToolError } from '../../lib/errors.ts';
import type { FsConfig } from './config.ts';
import { displayPath, isWithin, resolveInRoot } from './guard.ts';
import { compileMatcher } from './regex.ts';

export type EntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface DirEntry {
  name: string;
  type: EntryType;
  size: number;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const MAX_LINE_CHARS = 300;

function typeOf(d: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) {
  if (d.isSymbolicLink()) return 'symlink' as const;
  if (d.isFile()) return 'file' as const;
  if (d.isDirectory()) return 'directory' as const;
  return 'other' as const;
}

/** Heuristic used by git and most editors: a NUL byte in the first 8 KiB means binary. */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

export async function listDir(cfg: FsConfig, root: string, userPath: string) {
  const real = await resolveInRoot(root, userPath);
  const st = await lstat(real);
  if (!st.isDirectory()) throw new ToolError('INVALID_INPUT', `Not a directory: ${userPath}`);
  const dirents = await readdir(real, { withFileTypes: true });
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries: DirEntry[] = [];
  for (const d of dirents.slice(0, cfg.maxListEntries)) {
    // lstat, never stat: symlinks are reported, not followed.
    const s = await lstat(join(real, d.name)).catch(() => undefined);
    entries.push({ name: d.name, type: typeOf(d), size: s?.isFile() ? s.size : 0 });
  }
  return {
    path: displayPath(root, real),
    entries,
    truncated: dirents.length > cfg.maxListEntries,
  };
}

export async function readFileCapped(
  cfg: FsConfig,
  root: string,
  userPath: string,
  maxBytes?: number,
) {
  const real = await resolveInRoot(root, userPath);
  const cap = Math.min(maxBytes ?? cfg.maxReadBytes, cfg.maxReadBytes);
  // O_NOFOLLOW: if the final component was swapped for a symlink after the
  // realpath check (TOCTOU race), open() fails instead of following it.
  let fh;
  try {
    fh = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new ToolError('FORBIDDEN', 'Refusing to follow symlink');
    throw new ToolError('NOT_FOUND', `Cannot open ${userPath}`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ToolError('INVALID_INPUT', `Not a regular file: ${userPath}`);
    const toRead = Math.min(st.size, cap);
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, 0);
    const data = buf.subarray(0, bytesRead);
    if (looksBinary(data)) throw new ToolError('INVALID_INPUT', `Binary file: ${userPath}`);
    return {
      path: displayPath(root, real),
      size: st.size,
      truncated: st.size > bytesRead,
      content: data.toString('utf8'),
    };
  } finally {
    await fh.close();
  }
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export async function search(
  cfg: FsConfig,
  root: string,
  args: {
    pattern: string;
    path?: string | undefined;
    regex?: boolean | undefined;
    caseSensitive?: boolean | undefined;
    maxResults?: number | undefined;
  },
  now: () => number = () => performance.now(),
) {
  const match = compileMatcher(args.pattern, {
    regex: args.regex ?? false,
    caseSensitive: args.caseSensitive ?? false,
  });
  const start = await resolveInRoot(root, args.path ?? '.');
  const maxResults = Math.min(args.maxResults ?? cfg.maxSearchResults, cfg.maxSearchResults);
  const deadline = now() + cfg.searchTimeoutMs;
  const hits: SearchHit[] = [];
  let filesScanned = 0;
  let stopReason: 'complete' | 'maxResults' | 'maxFiles' | 'timeout' = 'complete';

  const startStat = await lstat(start);
  const stack: string[] = startStat.isDirectory() ? [start] : [];
  const files: string[] = startStat.isFile() ? [start] : [];

  const scanFile = async (file: string): Promise<boolean> => {
    if (filesScanned >= cfg.maxSearchFiles) {
      stopReason = 'maxFiles';
      return false;
    }
    if (now() > deadline) {
      stopReason = 'timeout';
      return false;
    }
    filesScanned++;
    const st = await lstat(file).catch(() => undefined);
    if (!st?.isFile() || st.size > cfg.maxSearchFileBytes) return true;
    let fh;
    try {
      fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return true;
    }
    let buf: Buffer;
    try {
      buf = await fh.readFile();
    } finally {
      await fh.close();
    }
    if (looksBinary(buf)) return true;
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (const i of match(lines, deadline - now())) {
      hits.push({
        path: displayPath(root, file),
        line: i + 1,
        text: (lines[i] ?? '').slice(0, MAX_LINE_CHARS),
      });
      if (hits.length >= maxResults) {
        stopReason = 'maxResults';
        return false;
      }
    }
    return true;
  };

  for (const f of files) await scanFile(f);
  outer: while (stack.length > 0) {
    const dir = stack.pop() as string;
    const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []);
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const d of dirents) {
      const full = join(dir, d.name);
      // Symlinks are never followed during search, and every path is re-checked.
      if (d.isSymbolicLink() || !isWithin(root, full)) continue;
      if (d.isDirectory()) {
        if (!SKIP_DIRS.has(d.name)) subdirs.push(full);
      } else if (d.isFile()) {
        if (!(await scanFile(full))) break outer;
      }
    }
    // Push in reverse so the stack pops directories in sorted order (deterministic output).
    stack.push(...subdirs.reverse());
  }
  return {
    hits,
    filesScanned,
    truncated: stopReason !== 'complete',
    stopReason,
  };
}

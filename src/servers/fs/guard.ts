import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ToolError } from '../../lib/errors.ts';

/** True if `child` is `root` or lies beneath it (both must be absolute, normalised). */
export function isWithin(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/** Canonicalise the sandbox root once at startup (follows symlinks in the root itself). */
export function canonicalRoot(root: string): string {
  if (!root) throw new Error('fs-sandbox root must be set');
  return realpathSync.native(resolve(root));
}

/**
 * Map a client-supplied path onto a real path inside `root`, or throw.
 *
 * Two independent checks:
 *  1. Lexical: the path, resolved against the root, must stay inside it. This
 *     rejects `../../etc/passwd` and absolute paths before touching the disk.
 *  2. Physical: `realpath` resolves every symlink in the path; the result must
 *     still be inside the (already canonical) root. This rejects `link -> /etc`
 *     and `a/b -> ../../..` style escapes, including nested symlink chains.
 *
 * Paths are interpreted relative to the root; a leading `/` is treated as the root.
 */
export async function resolveInRoot(root: string, userPath: string): Promise<string> {
  if (typeof userPath !== 'string') throw new ToolError('INVALID_INPUT', 'path must be a string');
  if (userPath.includes('\0')) throw new ToolError('INVALID_INPUT', 'path must not contain NUL');
  if (userPath.length > 4096) throw new ToolError('INVALID_INPUT', 'path too long');
  const relPath = userPath.replace(/^[/\\]+/, '');
  if (isAbsolute(relPath)) {
    // e.g. a Windows drive path like C:\x
    throw new ToolError('FORBIDDEN', 'Absolute paths are not allowed');
  }
  const lexical = resolve(root, relPath === '' ? '.' : relPath);
  if (!isWithin(root, lexical)) {
    throw new ToolError('FORBIDDEN', 'Path escapes the sandbox root');
  }
  let real: string;
  try {
    real = await realpath(lexical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new ToolError('NOT_FOUND', `No such file or directory: ${userPath}`);
    }
    if (code === 'ELOOP') throw new ToolError('FORBIDDEN', 'Too many levels of symbolic links');
    throw new ToolError('FORBIDDEN', `Cannot access path: ${userPath}`);
  }
  if (!isWithin(root, real)) {
    throw new ToolError('FORBIDDEN', 'Path resolves outside the sandbox root (symlink escape)');
  }
  return real;
}

/** Display a real path relative to the root, using forward slashes. */
export function displayPath(root: string, real: string): string {
  const rel = relative(root, real);
  return rel === '' ? '.' : rel.split(sep).join('/');
}

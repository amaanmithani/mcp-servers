import type { Database, Statement } from 'better-sqlite3';
import { ToolError } from '../../lib/errors.ts';

export const MAX_SQL_LENGTH = 20_000;

/**
 * Strip leading whitespace and SQL comments so we can inspect the first keyword.
 * Handles `-- line` and `/* block *\/` comments; an unterminated block comment
 * leaves an empty string (which is rejected).
 */
export function stripLeadingComments(sql: string): string {
  let s = sql;
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('--')) {
      const nl = s.indexOf('\n');
      s = nl === -1 ? '' : s.slice(nl + 1);
    } else if (s.startsWith('/*')) {
      const end = s.indexOf('*/', 2);
      s = end === -1 ? '' : s.slice(end + 2);
    } else {
      return s;
    }
  }
}

/**
 * Cheap textual pre-check (layer 1 of 3). The authoritative checks are done by
 * SQLite itself in `prepareReadOnlySelect`; this layer exists to reject things
 * SQLite considers "read-only" but we do not want, such as PRAGMA, ATTACH,
 * BEGIN or VACUUM INTO, and to give a clear error message.
 */
export function assertSelectText(sql: string): void {
  if (typeof sql !== 'string' || sql.length === 0) {
    throw new ToolError('INVALID_INPUT', 'SQL must be a non-empty string');
  }
  if (sql.length > MAX_SQL_LENGTH) {
    throw new ToolError('TOO_LARGE', `SQL exceeds ${MAX_SQL_LENGTH} characters`);
  }
  if (sql.includes('\0')) {
    throw new ToolError('INVALID_INPUT', 'SQL must not contain NUL bytes');
  }
  const body = stripLeadingComments(sql);
  const first = /^[A-Za-z]+/.exec(body)?.[0]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'WITH' && first !== 'VALUES') {
    throw new ToolError(
      'FORBIDDEN',
      `Only a single SELECT/WITH statement is allowed (got ${first ?? 'no statement'})`,
    );
  }
}

/**
 * Authoritative guard (layers 2 and 3): let SQLite parse the statement.
 *  - better-sqlite3 refuses to prepare a string containing more than one statement,
 *    so `SELECT 1; DROP TABLE x` never reaches the engine.
 *  - `stmt.readonly` is sqlite3_stmt_readonly(): true only if the compiled program
 *    cannot write to the database file. This catches `WITH x AS (...) DELETE ...`.
 *  - `stmt.reader` must be true: the statement returns rows.
 * The connection itself is also opened read-only with `query_only=ON` as a final backstop.
 */
export function prepareReadOnlySelect(db: Database, sql: string): Statement {
  assertSelectText(sql);
  let stmt: Statement;
  try {
    stmt = db.prepare(sql);
  } catch (err) {
    const msg = (err as Error).message;
    if (/more than one statement/i.test(msg)) {
      throw new ToolError('FORBIDDEN', 'Multiple statements are not allowed');
    }
    throw new ToolError('INVALID_INPUT', `SQL error: ${msg}`);
  }
  if (!stmt.readonly) {
    throw new ToolError('FORBIDDEN', 'Statement is not read-only');
  }
  if (!stmt.reader) {
    throw new ToolError('FORBIDDEN', 'Statement does not return rows');
  }
  return stmt;
}

/** Quote an identifier for SQLite (double quotes, embedded quotes doubled). */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

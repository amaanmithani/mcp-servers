import Database from 'better-sqlite3';
import { ToolError } from '../../lib/errors.ts';
import { prepareReadOnlySelect } from './guard.ts';

export type SqlParam = string | number | boolean | null;
export type Cell =
  string | number | null | { blobBase64: string; bytes: number; truncated: boolean };

export interface QueryResult {
  columns: string[];
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
}

export const MAX_BLOB_PREVIEW = 256;

/**
 * Open a SQLite file in the most restrictive mode available:
 * read-only file handle, must already exist, `query_only` so even a guard bug
 * cannot write, and `trusted_schema=OFF` so a hostile DB file cannot smuggle
 * side-effecting functions in through views or triggers.
 */
export function openReadOnly(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('trusted_schema = OFF');
  return db;
}

export function convertCell(v: unknown): Cell {
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (v instanceof Uint8Array) {
    const slice = v.subarray(0, MAX_BLOB_PREVIEW);
    return {
      blobBase64: Buffer.from(slice).toString('base64'),
      bytes: v.byteLength,
      truncated: v.byteLength > MAX_BLOB_PREVIEW,
    };
  }
  return String(v);
}

/**
 * Run a guarded SELECT and collect at most `maxRows` rows. Iteration stops as
 * soon as the limit is exceeded, so `SELECT * FROM huge_table` does not
 * materialise the whole table. (CPU-bound queries that never yield a row are
 * handled by the worker-thread timeout in runner.ts.)
 */
export function runQuery(
  db: Database.Database,
  sql: string,
  params: SqlParam[],
  maxRows: number,
): QueryResult {
  const stmt = prepareReadOnlySelect(db, sql);
  stmt.raw(true);
  stmt.safeIntegers(true);
  const columns = stmt.columns().map((c) => c.name);
  const rows: Cell[][] = [];
  let truncated = false;
  const bound = params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
  try {
    for (const row of stmt.iterate(...bound) as Iterable<unknown[]>) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(row.map(convertCell));
    }
  } catch (err) {
    if (err instanceof ToolError) throw err;
    throw new ToolError('INVALID_INPUT', `SQL error: ${(err as Error).message}`);
  }
  return { columns, rows, rowCount: rows.length, truncated };
}

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolError } from '../../src/lib/errors.ts';
import {
  assertSelectText,
  prepareReadOnlySelect,
  quoteIdent,
  stripLeadingComments,
} from '../../src/servers/sqlite/guard.ts';
import { convertCell, openReadOnly, runQuery } from '../../src/servers/sqlite/executor.ts';

let dir: string;
let dbPath: string;
let db: Database.Database;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlguard-'));
  dbPath = join(dir, 't.db');
  const w = new Database(dbPath);
  w.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, big INTEGER, data BLOB);
          INSERT INTO t VALUES (1,'a',9007199254740993, x'00ff'), (2,'b',5,NULL), (3,'c',6,NULL);`);
  w.close();
  db = openReadOnly(dbPath);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof ToolError ? e.code : 'NON_TOOL_ERROR';
  }
  return undefined;
}

describe('stripLeadingComments', () => {
  it('removes line and block comments', () => {
    expect(stripLeadingComments('  -- hi\n /* x */ SELECT 1')).toBe('SELECT 1');
    expect(stripLeadingComments('/* unterminated')).toBe('');
    expect(stripLeadingComments('-- only')).toBe('');
  });
});

describe('assertSelectText', () => {
  it.each([
    'SELECT 1',
    'select * from t',
    'WITH a AS (SELECT 1) SELECT * FROM a',
    '/*c*/ select 1',
    'VALUES (1)',
  ])('accepts %s', (sql) => expect(() => assertSelectText(sql)).not.toThrow());
  it.each([
    ['DELETE FROM t', 'FORBIDDEN'],
    ['PRAGMA writable_schema=1', 'FORBIDDEN'],
    ["ATTACH 'x.db' AS x", 'FORBIDDEN'],
    ['BEGIN', 'FORBIDDEN'],
    ['-- SELECT\nDROP TABLE t', 'FORBIDDEN'],
    ['', 'INVALID_INPUT'],
    ['SELECT \0', 'INVALID_INPUT'],
    ['SELECT ' + 'x'.repeat(30_000), 'TOO_LARGE'],
  ])('rejects %s', (sql, code) => expect(codeOf(() => assertSelectText(sql))).toBe(code));
});

describe('prepareReadOnlySelect', () => {
  it('allows a plain select', () => {
    expect(prepareReadOnlySelect(db, 'SELECT * FROM t').reader).toBe(true);
  });
  it('rejects stacked statements (classic injection)', () => {
    expect(codeOf(() => prepareReadOnlySelect(db, 'SELECT 1; DROP TABLE t'))).toBe('FORBIDDEN');
    expect(codeOf(() => prepareReadOnlySelect(db, 'SELECT 1; SELECT 2'))).toBe('FORBIDDEN');
  });
  it('allows a trailing semicolon and comment', () => {
    expect(() => prepareReadOnlySelect(db, 'SELECT 1; -- done')).not.toThrow();
  });
  it('rejects a CTE that writes (caught by sqlite3_stmt_readonly)', () => {
    // On a read-only connection SQLite may refuse at prepare time; either way it must not run.
    const code = codeOf(() => prepareReadOnlySelect(db, 'WITH x AS (SELECT 1) DELETE FROM t'));
    expect(['FORBIDDEN', 'INVALID_INPUT']).toContain(code);
  });
  it('reports readonly=false for writing CTEs on a writable connection', () => {
    const rw = new Database(':memory:');
    rw.exec('CREATE TABLE t(a)');
    expect(
      codeOf(() => prepareReadOnlySelect(rw, 'WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x')),
    ).toBe('FORBIDDEN');
    rw.close();
  });
  it('turns syntax errors into INVALID_INPUT', () => {
    expect(codeOf(() => prepareReadOnlySelect(db, 'SELECT FROM WHERE'))).toBe('INVALID_INPUT');
  });
  it('cannot call load_extension', () => {
    expect(() => runQuery(db, "SELECT load_extension('/tmp/evil')", [], 10)).toThrow();
  });
});

describe('connection hardening', () => {
  it('refuses writes even if the guard were bypassed', () => {
    expect(() => db.exec('DELETE FROM t')).toThrow(/readonly|query_only/i);
  });
});

describe('runQuery', () => {
  it('returns columns + rows and enforces the row limit', () => {
    const r = runQuery(db, 'SELECT id, name FROM t ORDER BY id', [], 2);
    expect(r.columns).toEqual(['id', 'name']);
    expect(r.rows).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(r.truncated).toBe(true);
    expect(runQuery(db, 'SELECT id FROM t', [], 10).truncated).toBe(false);
  });
  it('binds params (including booleans)', () => {
    expect(runQuery(db, 'SELECT name FROM t WHERE id = ?', [2], 10).rows).toEqual([['b']]);
    expect(runQuery(db, 'SELECT ? AS x', [true], 10).rows).toEqual([[1]]);
  });
  it('preserves big integers as strings and summarises blobs', () => {
    const r = runQuery(db, 'SELECT big, data FROM t WHERE id = 1', [], 10);
    expect(r.rows[0]?.[0]).toBe('9007199254740993');
    expect(r.rows[0]?.[1]).toEqual({ blobBase64: 'AP8=', bytes: 2, truncated: false });
  });
  it('wraps runtime errors', () => {
    expect(codeOf(() => runQuery(db, 'SELECT * FROM t WHERE id = ?', [], 10))).toBe(
      'INVALID_INPUT',
    );
  });
});

describe('helpers', () => {
  it('quotes identifiers', () => expect(quoteIdent('a"b')).toBe('"a""b"'));
  it('converts cells', () => {
    expect(convertCell(5n)).toBe(5);
    expect(convertCell(true)).toBe('true');
    expect(convertCell(new Uint8Array(300))).toMatchObject({ bytes: 300, truncated: true });
  });
});

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolError, okResult } from '../../lib/errors.ts';
import type { Logger } from '../../lib/logger.ts';
import { ToolRateLimiter } from '../../lib/rateLimit.ts';
import { registerTool } from '../../lib/tool.ts';
import type { SqliteConfig } from './config.ts';
import { openReadOnly } from './executor.ts';
import { quoteIdent } from './guard.ts';
import { QueryRunner } from './runner.ts';

export const SERVER_NAME = 'sqlite-readonly';

const cell = z.union([
  z.string(),
  z.number(),
  z.null(),
  z.object({ blobBase64: z.string(), bytes: z.number(), truncated: z.boolean() }),
]);

export function createSqliteServer(cfg: SqliteConfig, logger: Logger) {
  const db = openReadOnly(cfg.dbPath);
  const runner = new QueryRunner(cfg.dbPath, cfg.timeoutMs, logger);
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' });
  const ctx = { server, limiter: new ToolRateLimiter(cfg.rateLimit), logger };

  const listTables = (): Array<{ name: string; type: string }> =>
    db
      .prepare(
        `SELECT name, type FROM sqlite_schema
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all() as Array<{ name: string; type: string }>;

  registerTool(
    ctx,
    'list_tables',
    {
      title: 'List tables',
      description: 'List the tables and views in the database.',
      inputSchema: {},
      outputSchema: {
        tables: z.array(z.object({ name: z.string(), type: z.string() })),
      },
    },
    async () => okResult({ tables: listTables() }),
  );

  registerTool(
    ctx,
    'describe_table',
    {
      title: 'Describe table',
      description: 'Show columns, primary key, indexes and foreign keys for one table or view.',
      inputSchema: { table: z.string().min(1).max(256) },
      outputSchema: {
        table: z.string(),
        type: z.string(),
        columns: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            notNull: z.boolean(),
            primaryKey: z.boolean(),
            defaultValue: z.string().nullable(),
          }),
        ),
        indexes: z.array(z.object({ name: z.string(), unique: z.boolean() })),
        foreignKeys: z.array(z.object({ column: z.string(), references: z.string() })),
      },
    },
    async ({ table }) => {
      // Only describe objects that actually exist; the name is then quoted as an identifier.
      const found = listTables().find((t) => t.name === table);
      if (!found) throw new ToolError('NOT_FOUND', `No table or view named ${table}`);
      const q = quoteIdent(found.name);
      const cols = db.prepare(`PRAGMA table_info(${q})`).all() as Array<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
        dflt_value: string | null;
      }>;
      const idx = db.prepare(`PRAGMA index_list(${q})`).all() as Array<{
        name: string;
        unique: number;
      }>;
      const fks = db.prepare(`PRAGMA foreign_key_list(${q})`).all() as Array<{
        from: string;
        table: string;
        to: string | null;
      }>;
      return okResult({
        table: found.name,
        type: found.type,
        columns: cols.map((c) => ({
          name: c.name,
          type: c.type,
          notNull: c.notnull === 1,
          primaryKey: c.pk > 0,
          defaultValue: c.dflt_value,
        })),
        indexes: idx.map((i) => ({ name: i.name, unique: i.unique === 1 })),
        foreignKeys: fks.map((f) => ({
          column: f.from,
          references: `${f.table}(${f.to ?? 'rowid'})`,
        })),
      });
    },
  );

  registerTool(
    ctx,
    'query',
    {
      title: 'Run a read-only query',
      description:
        'Run ONE read-only SELECT (or WITH ... SELECT) statement. Use ? placeholders with `params` ' +
        `for values. Results are capped at ${cfg.maxRows} rows and ${cfg.timeoutMs} ms.`,
      inputSchema: {
        sql: z.string().min(1),
        params: z
          .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .max(100)
          .optional(),
        limit: z.number().int().min(1).optional(),
      },
      outputSchema: {
        columns: z.array(z.string()),
        rows: z.array(z.array(cell)),
        rowCount: z.number(),
        truncated: z.boolean(),
      },
    },
    async ({ sql, params, limit }) => {
      const maxRows = Math.min(limit ?? cfg.maxRows, cfg.maxRows);
      const result = await runner.query(sql, params ?? [], maxRows);
      return okResult({ ...result });
    },
  );

  const close = async (): Promise<void> => {
    await runner.close();
    db.close();
  };
  return { server, close };
}

import { z } from 'zod';
import { asNumber, asString, commonSchema, loadConfig } from '../../lib/config.ts';

export const sqliteConfigSchema = commonSchema.extend({
  dbPath: z.string().min(1),
  /** Hard upper bound on rows returned by `query`. */
  maxRows: z.number().int().min(1).max(100_000).default(500),
  /** Wall-clock budget per query; the worker is killed when exceeded. */
  timeoutMs: z.number().int().min(50).max(600_000).default(2_000),
});

export type SqliteConfig = z.infer<typeof sqliteConfigSchema>;

export function loadSqliteConfig(env: Record<string, string | undefined> = process.env) {
  return loadConfig({
    schema: sqliteConfigSchema,
    env,
    fileEnvVar: 'SQLITE_MCP_CONFIG',
    bindings: {
      SQLITE_DB_PATH: ['dbPath', asString],
      SQLITE_MAX_ROWS: ['maxRows', asNumber],
      SQLITE_TIMEOUT_MS: ['timeoutMs', asNumber],
    },
  });
}

import { z } from 'zod';
import { asNumber, asString, commonSchema, loadConfig } from '../../lib/config.ts';

export const fsConfigSchema = commonSchema.extend({
  root: z.string().min(1),
  /** Maximum bytes returned by read_file (larger files are truncated). */
  maxReadBytes: z
    .number()
    .int()
    .min(1)
    .max(50_000_000)
    .default(256 * 1024),
  maxListEntries: z.number().int().min(1).max(100_000).default(1_000),
  maxSearchResults: z.number().int().min(1).max(10_000).default(200),
  maxSearchFiles: z.number().int().min(1).max(1_000_000).default(5_000),
  /** Files larger than this are skipped by search. */
  maxSearchFileBytes: z
    .number()
    .int()
    .min(1)
    .default(1024 * 1024),
  searchTimeoutMs: z.number().int().min(10).max(600_000).default(3_000),
});

export type FsConfig = z.infer<typeof fsConfigSchema>;

export function loadFsConfig(env: Record<string, string | undefined> = process.env) {
  return loadConfig({
    schema: fsConfigSchema,
    env,
    fileEnvVar: 'FS_MCP_CONFIG',
    bindings: {
      FS_ROOT: ['root', asString],
      FS_MAX_READ_BYTES: ['maxReadBytes', asNumber],
      FS_SEARCH_TIMEOUT_MS: ['searchTimeoutMs', asNumber],
    },
  });
}

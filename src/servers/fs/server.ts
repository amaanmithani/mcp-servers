import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { okResult } from '../../lib/errors.ts';
import type { Logger } from '../../lib/logger.ts';
import { ToolRateLimiter } from '../../lib/rateLimit.ts';
import { registerTool } from '../../lib/tool.ts';
import type { FsConfig } from './config.ts';
import { canonicalRoot } from './guard.ts';
import { listDir, readFileCapped, search } from './ops.ts';

export const SERVER_NAME = 'fs-sandbox';

export function createFsServer(cfg: FsConfig, logger: Logger) {
  const root = canonicalRoot(cfg.root);
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' });
  const ctx = { server, limiter: new ToolRateLimiter(cfg.rateLimit), logger };
  const pathArg = z
    .string()
    .max(4096)
    .describe('Path relative to the sandbox root ("." or "" for the root)');

  registerTool(
    ctx,
    'list_dir',
    {
      title: 'List directory',
      description:
        'List entries of a directory inside the sandbox. Symlinks are shown, not followed.',
      inputSchema: { path: pathArg.default('.') },
      outputSchema: {
        path: z.string(),
        entries: z.array(
          z.object({
            name: z.string(),
            type: z.enum(['file', 'directory', 'symlink', 'other']),
            size: z.number(),
          }),
        ),
        truncated: z.boolean(),
      },
    },
    async ({ path }) => okResult(await listDir(cfg, root, path)),
  );

  registerTool(
    ctx,
    'read_file',
    {
      title: 'Read file',
      description: `Read a UTF-8 text file inside the sandbox (at most ${cfg.maxReadBytes} bytes).`,
      inputSchema: {
        path: pathArg,
        maxBytes: z.number().int().min(1).optional(),
      },
      outputSchema: {
        path: z.string(),
        size: z.number(),
        truncated: z.boolean(),
        content: z.string(),
      },
    },
    async ({ path, maxBytes }) => {
      const r = await readFileCapped(cfg, root, path, maxBytes);
      return okResult(r, r.content);
    },
  );

  registerTool(
    ctx,
    'search',
    {
      title: 'Search files',
      description:
        'Search text files under a directory for a substring (default) or regex. ' +
        'Returns matching lines with 1-based line numbers.',
      inputSchema: {
        pattern: z.string().min(1).max(500),
        path: pathArg.optional(),
        regex: z.boolean().optional(),
        caseSensitive: z.boolean().optional(),
        maxResults: z.number().int().min(1).optional(),
      },
      outputSchema: {
        hits: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
        filesScanned: z.number(),
        truncated: z.boolean(),
        stopReason: z.enum(['complete', 'maxResults', 'maxFiles', 'timeout']),
      },
    },
    async (args) => okResult(await search(cfg, root, args)),
  );

  return { server, close: async () => {} };
}

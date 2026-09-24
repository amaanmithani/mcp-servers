import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { okResult } from '../../lib/errors.ts';
import type { Logger } from '../../lib/logger.ts';
import { ToolRateLimiter } from '../../lib/rateLimit.ts';
import { registerTool } from '../../lib/tool.ts';
import type { HttpConfig } from './config.ts';
import { Fetcher, type Resolver } from './fetcher.ts';

export const SERVER_NAME = 'http-fetch';

export function createHttpServer(cfg: HttpConfig, logger: Logger, resolver?: Resolver) {
  const fetcher = new Fetcher(cfg, resolver);
  const server = new McpServer({ name: SERVER_NAME, version: '0.1.0' });
  const ctx = { server, limiter: new ToolRateLimiter(cfg.rateLimit), logger };

  registerTool(
    ctx,
    'fetch',
    {
      title: 'Fetch URL',
      description:
        'Fetch a URL from an allowlisted host and return its readable text (HTML is converted). ' +
        `Allowed hosts: ${cfg.allowedHosts.join(', ')}. Max ${cfg.maxBytes} bytes, ${cfg.timeoutMs} ms.`,
      inputSchema: {
        url: z.string().url().max(8192),
        maxBytes: z.number().int().min(1).optional(),
      },
      outputSchema: {
        url: z.string(),
        finalUrl: z.string(),
        status: z.number(),
        contentType: z.string(),
        title: z.string().nullable(),
        text: z.string(),
        bytes: z.number(),
        truncated: z.boolean(),
        redirects: z.array(z.string()),
      },
      annotations: { openWorldHint: true },
    },
    async ({ url, maxBytes }) => {
      const r = await fetcher.fetch(url, maxBytes);
      logger.info('fetched', { url: r.finalUrl, status: r.status, bytes: r.bytes });
      return okResult({ ...r });
    },
  );

  return { server, close: async () => {} };
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { ToolError, toErrorResult } from './errors.ts';
import type { Logger } from './logger.ts';
import type { ToolRateLimiter } from './rateLimit.ts';

export interface ToolContext {
  server: McpServer;
  limiter: ToolRateLimiter;
  logger: Logger;
}

type Shape = z.ZodRawShape;

/**
 * Register a tool with the shared cross-cutting behaviour every server needs:
 * per-tool token-bucket rate limiting, timing + outcome logging to stderr, and
 * conversion of any thrown error into a consistent `isError` result.
 */
export function registerTool<I extends Shape, O extends Shape>(
  ctx: ToolContext,
  name: string,
  def: {
    title: string;
    description: string;
    inputSchema: I;
    outputSchema: O;
    annotations?: ToolAnnotations;
  },
  handler: (args: z.infer<z.ZodObject<I>>) => Promise<CallToolResult>,
): void {
  const cb = async (args: z.infer<z.ZodObject<I>>): Promise<CallToolResult> => {
    const started = performance.now();
    const waitMs = ctx.limiter.tryTake(name);
    if (waitMs > 0) {
      ctx.logger.warn('rate limited', { tool: name, retryAfterMs: waitMs });
      return toErrorResult(
        new ToolError('RATE_LIMITED', `Rate limit exceeded for ${name}; retry in ${waitMs} ms`, {
          retryAfterMs: waitMs,
        }),
      );
    }
    try {
      const result = await handler(args);
      ctx.logger.info('tool ok', { tool: name, ms: round(performance.now() - started) });
      return result;
    } catch (err) {
      const code = err instanceof ToolError ? err.code : 'INTERNAL';
      const log = code === 'INTERNAL' ? ctx.logger.error : ctx.logger.warn;
      log('tool failed', { tool: name, code, err, ms: round(performance.now() - started) });
      return toErrorResult(err);
    }
  };
  ctx.server.registerTool(
    name,
    {
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      outputSchema: def.outputSchema,
      annotations: { readOnlyHint: true, ...def.annotations },
    },
    // The SDK's generic callback type is hard to express through a wrapper; the
    // runtime contract (validated args in, CallToolResult out) is identical.
    cb as never,
  );
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

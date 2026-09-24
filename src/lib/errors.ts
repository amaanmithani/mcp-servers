import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Stable, machine-readable error codes shared by every server. */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'TOO_LARGE'
  | 'TIMEOUT'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Convert any thrown value into a consistent MCP error result. Unknown errors
 * are reported as INTERNAL without leaking stack traces or internals.
 *
 * The error is serialised as JSON in the text content (`{"error":{code,message}}`)
 * rather than in `structuredContent`, because MCP clients validate
 * `structuredContent` against the tool's success `outputSchema`.
 */
export function toErrorResult(err: unknown): CallToolResult {
  const e =
    err instanceof ToolError ? err : new ToolError('INTERNAL', 'Internal error while running tool');
  const error = { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error }) }],
  };
}

export function okResult<T extends Record<string, unknown>>(
  data: T,
  text?: string,
): CallToolResult {
  return {
    content: [{ type: 'text', text: text ?? JSON.stringify(data) }],
    structuredContent: data,
  };
}

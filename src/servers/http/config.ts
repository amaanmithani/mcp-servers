import { z } from 'zod';
import { asList, asNumber, commonSchema, loadConfig } from '../../lib/config.ts';

export const httpConfigSchema = commonSchema.extend({
  /** Hostnames that may be fetched. Exact ("docs.python.org") or wildcard ("*.github.io"). */
  allowedHosts: z.array(z.string().min(1)).min(1),
  allowedSchemes: z
    .array(z.enum(['http', 'https']))
    .min(1)
    .default(['https']),
  allowedPorts: z.array(z.number().int().min(1).max(65535)).min(1).default([80, 443]),
  /** CIDRs exempted from the private-address block. Empty by default; use with care. */
  allowCidrs: z.array(z.string()).default([]),
  maxBytes: z.number().int().min(1).max(50_000_000).default(1_000_000),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  maxRedirects: z.number().int().min(0).max(20).default(5),
  userAgent: z.string().default('mcp-http-fetch/0.1 (+https://modelcontextprotocol.io)'),
});

export type HttpConfig = z.infer<typeof httpConfigSchema>;

export function loadHttpConfig(env: Record<string, string | undefined> = process.env) {
  return loadConfig({
    schema: httpConfigSchema,
    env,
    fileEnvVar: 'HTTP_MCP_CONFIG',
    bindings: {
      HTTP_ALLOWED_HOSTS: ['allowedHosts', asList],
      HTTP_ALLOWED_SCHEMES: ['allowedSchemes', asList],
      HTTP_ALLOW_CIDRS: ['allowCidrs', asList],
      HTTP_MAX_BYTES: ['maxBytes', asNumber],
      HTTP_TIMEOUT_MS: ['timeoutMs', asNumber],
      HTTP_MAX_REDIRECTS: ['maxRedirects', asNumber],
    },
  });
}

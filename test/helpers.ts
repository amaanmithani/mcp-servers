import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createLogger, type Logger } from '../src/lib/logger.ts';

export const silentLogger: Logger = createLogger({ level: 'error', write: () => {} });

export const common = {
  logLevel: 'error' as const,
  rateLimit: { capacity: 1000, refillPerSecond: 1000 },
};

/** Connect an in-process client to a server over a linked in-memory transport. */
export async function connect(server: McpServer): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

export type AnyResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
};

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as AnyResult;
}

/** Error code from a consistent error result (`{"error":{code,message}}` in text content). */
export function errCode(r: AnyResult): string | undefined {
  if (!r.isError) return undefined;
  const text = r.content?.[0]?.text ?? '';
  return (JSON.parse(text) as { error: { code: string } }).error.code;
}

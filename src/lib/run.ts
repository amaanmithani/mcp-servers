import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Logger } from './logger.ts';

/** Connect a server to stdio and install shutdown + crash handlers. */
export async function runStdio(
  server: McpServer,
  logger: Logger,
  onClose?: () => Promise<void> | void,
): Promise<void> {
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info('shutting down', { reason });
    try {
      await onClose?.();
      await server.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.stdin.on('close', () => void shutdown('stdin closed'));
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    process.exit(1);
  });
  await server.connect(transport);
  logger.info('server listening on stdio');
}

export { McpServer };

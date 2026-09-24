#!/usr/bin/env node
import { createLogger, fatal } from '../../lib/logger.ts';
import { runStdio } from '../../lib/run.ts';
import { loadHttpConfig } from './config.ts';
import { SERVER_NAME, createHttpServer } from './server.ts';

try {
  const cfg = loadHttpConfig();
  const logger = createLogger({ level: cfg.logLevel, base: { server: SERVER_NAME } });
  if (cfg.allowCidrs.length > 0) {
    logger.warn('private-address exemptions enabled', { allowCidrs: cfg.allowCidrs });
  }
  const { server, close } = createHttpServer(cfg, logger);
  await runStdio(server, logger, close);
} catch (err) {
  fatal(SERVER_NAME, err);
}

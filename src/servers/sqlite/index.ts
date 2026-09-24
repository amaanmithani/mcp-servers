#!/usr/bin/env node
import { createLogger, fatal } from '../../lib/logger.ts';
import { runStdio } from '../../lib/run.ts';
import { loadSqliteConfig } from './config.ts';
import { SERVER_NAME, createSqliteServer } from './server.ts';

try {
  const cfg = loadSqliteConfig();
  const logger = createLogger({ level: cfg.logLevel, base: { server: SERVER_NAME } });
  const { server, close } = createSqliteServer(cfg, logger);
  await runStdio(server, logger, close);
} catch (err) {
  fatal(SERVER_NAME, err);
}

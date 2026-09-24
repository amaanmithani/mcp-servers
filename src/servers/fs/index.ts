#!/usr/bin/env node
import { createLogger, fatal } from '../../lib/logger.ts';
import { runStdio } from '../../lib/run.ts';
import { loadFsConfig } from './config.ts';
import { SERVER_NAME, createFsServer } from './server.ts';

try {
  const cfg = loadFsConfig();
  const logger = createLogger({ level: cfg.logLevel, base: { server: SERVER_NAME } });
  const { server, close } = createFsServer(cfg, logger);
  await runStdio(server, logger, close);
} catch (err) {
  fatal(SERVER_NAME, err);
}

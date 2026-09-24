/**
 * Worker thread that owns its own read-only connection and executes queries.
 * Running queries off the main thread lets the parent enforce a hard wall-clock
 * timeout by terminating this worker (better-sqlite3 is synchronous and has no
 * progress-handler API, so an in-thread timeout is not possible).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { ToolError } from '../../lib/errors.ts';
import { openReadOnly, runQuery, type SqlParam } from './executor.ts';

interface Request {
  id: number;
  sql: string;
  params: SqlParam[];
  maxRows: number;
}

const { dbPath } = workerData as { dbPath: string };
const db = openReadOnly(dbPath);
// Signal readiness so the parent starts the per-query clock only once the
// worker has booted (module loading must not eat into a query's time budget).
parentPort?.postMessage({ ready: true });

parentPort?.on('message', (req: Request) => {
  try {
    const result = runQuery(db, req.sql, req.params, req.maxRows);
    parentPort?.postMessage({ id: req.id, ok: true, result });
  } catch (err) {
    const e = err instanceof ToolError ? err : new ToolError('INTERNAL', 'Query failed');
    parentPort?.postMessage({ id: req.id, ok: false, error: { code: e.code, message: e.message } });
  }
});

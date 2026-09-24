import { Worker } from 'node:worker_threads';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ToolError, type ErrorCode } from '../../lib/errors.ts';
import type { Logger } from '../../lib/logger.ts';
import type { QueryResult, SqlParam } from './executor.ts';

type Reply =
  | { id: number; ok: true; result: QueryResult }
  | { id: number; ok: false; error: { code: ErrorCode; message: string } };

/** Upper bound for a worker to boot and open the database. */
const STARTUP_TIMEOUT_MS = 15_000;

/**
 * Executes queries in a dedicated worker thread, one at a time, with a hard
 * timeout. On timeout the worker is terminated (killing the runaway query) and a
 * fresh worker is started lazily for the next call.
 */
export class QueryRunner {
  private worker: Promise<Worker> | undefined;
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly dbPath: string;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(dbPath: string, timeoutMs: number, logger: Logger) {
    this.dbPath = dbPath;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
  }

  private getWorker(): Promise<Worker> {
    if (!this.worker) {
      // Load worker.ts when running from source (Node type stripping), worker.js from dist.
      const ext = extname(fileURLToPath(import.meta.url));
      const w = new Worker(new URL(`./worker${ext}`, import.meta.url), {
        workerData: { dbPath: this.dbPath },
      });
      w.unref();
      w.on('error', (err) => this.logger.error('sqlite worker error', { err }));
      this.worker = new Promise<Worker>((resolve, reject) => {
        const timer = setTimeout(() => {
          void w.terminate();
          reject(new ToolError('INTERNAL', 'Query worker failed to start'));
        }, STARTUP_TIMEOUT_MS);
        const onMessage = (msg: { ready?: boolean }): void => {
          if (!msg.ready) return;
          clearTimeout(timer);
          w.off('message', onMessage);
          w.off('exit', onExit);
          resolve(w);
        };
        const onExit = (): void => {
          clearTimeout(timer);
          reject(new ToolError('INTERNAL', 'Query worker exited during startup'));
        };
        w.on('message', onMessage);
        w.once('exit', onExit);
      });
      this.worker.catch(() => (this.worker = undefined));
    }
    return this.worker;
  }

  query(sql: string, params: SqlParam[], maxRows: number): Promise<QueryResult> {
    const run = (): Promise<QueryResult> => this.execute(sql, params, maxRows);
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async execute(sql: string, params: SqlParam[], maxRows: number): Promise<QueryResult> {
    const worker = await this.getWorker();
    const id = this.nextId++;
    return new Promise<QueryResult>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.off('message', onMessage);
        worker.off('exit', onExit);
      };
      const onMessage = (msg: Reply): void => {
        if (msg.id !== id) return;
        cleanup();
        if (msg.ok) resolve(msg.result);
        else reject(new ToolError(msg.error.code, msg.error.message));
      };
      const onExit = (code: number): void => {
        cleanup();
        this.worker = undefined;
        reject(new ToolError('INTERNAL', `Query worker exited unexpectedly (code ${code})`));
      };
      const timer = setTimeout(() => {
        cleanup();
        this.worker = undefined;
        this.logger.warn('query timed out; terminating worker', { timeoutMs: this.timeoutMs });
        void worker.terminate();
        reject(new ToolError('TIMEOUT', `Query exceeded ${this.timeoutMs} ms and was cancelled`));
      }, this.timeoutMs);
      worker.on('message', onMessage);
      worker.once('exit', onExit);
      worker.postMessage({ id, sql, params, maxRows });
    });
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    if (w) await (await w.catch(() => undefined))?.terminate();
  }
}

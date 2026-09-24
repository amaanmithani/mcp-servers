/**
 * Structured JSON-lines logger that writes ONLY to stderr.
 *
 * stdout is the MCP stdio transport channel; a single stray byte there corrupts
 * the JSON-RPC stream, so nothing in this repo may write to stdout.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  base?: Record<string, unknown>;
  /** Sink for serialized lines. Defaults to process.stderr. */
  write?: (line: string) => void;
  now?: () => Date;
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = 'info'): LogLevel {
  if (value && value in LEVELS) return value as LogLevel;
  return fallback;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const threshold = LEVELS[opts.level ?? 'info'];
  const base = opts.base ?? {};
  const write = opts.write ?? ((line: string) => process.stderr.write(line));
  const now = opts.now ?? (() => new Date());

  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    if (LEVELS[level] < threshold) return;
    const record = { ts: now().toISOString(), level, msg, ...base, ...fields };
    let line: string;
    try {
      line = JSON.stringify(record, errorReplacer);
    } catch {
      line = JSON.stringify({ ts: record.ts, level, msg, note: 'unserializable fields' });
    }
    write(line + '\n');
  };

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (fields) => createLogger({ ...opts, base: { ...base, ...fields } }),
  };
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/** Log a fatal startup error (e.g. invalid config) as a JSON line on stderr and exit. */
export function fatal(server: string, err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      msg: 'fatal',
      server,
      error: message,
    }) + '\n',
  );
  process.exit(1);
}

import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const rateLimitSchema = z.object({
  capacity: z.number().int().min(1).default(30),
  refillPerSecond: z.number().positive().default(10),
});

export const commonSchema = z.object({
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  rateLimit: rateLimitSchema.default({ capacity: 30, refillPerSecond: 10 }),
});

export type CommonConfig = z.infer<typeof commonSchema>;

type Env = Record<string, string | undefined>;

/** Maps an env var to a dotted config path plus a parser for its string value. */
export type EnvBinding = [path: string, parse: (raw: string) => unknown];

export const asString = (raw: string): string => raw;
export const asNumber = (raw: string): number => Number(raw);
export const asList = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Load config with precedence: defaults < JSON file (path in `fileEnvVar`) < env vars.
 * The merged object is validated with zod; invalid config throws with a readable message.
 */
export function loadConfig<S extends z.ZodType>(opts: {
  schema: S;
  env?: Env;
  fileEnvVar: string;
  bindings: Record<string, EnvBinding>;
}): z.infer<S> {
  const env = opts.env ?? process.env;
  let raw: Record<string, unknown> = {};
  const file = env[opts.fileEnvVar];
  if (file) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`Could not read config file ${file}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Config file ${file} must contain a JSON object`);
    }
    raw = parsed as Record<string, unknown>;
  }
  const common: Record<string, EnvBinding> = {
    MCP_LOG_LEVEL: ['logLevel', asString],
    MCP_RATE_CAPACITY: ['rateLimit.capacity', asNumber],
    MCP_RATE_REFILL_PER_SEC: ['rateLimit.refillPerSecond', asNumber],
  };
  for (const [name, [path, parse]] of Object.entries({ ...common, ...opts.bindings })) {
    const value = env[name];
    if (value !== undefined && value !== '') setPath(raw, path, parse(value));
  }
  const result = opts.schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return result.data;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur = obj;
  for (const key of keys.slice(0, -1)) {
    const next = cur[key];
    if (typeof next !== 'object' || next === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1] as string] = value;
}

/**
 * Measure tool-call round-trip latency over stdio, exactly as an MCP client sees it:
 * client.callTool() -> JSON-RPC over the child's stdin/stdout -> tool -> response.
 *
 * Spawns the BUILT servers (run `npm run build` first; `npm run bench` does both).
 * Writes results/bench.json. Usage: tsx scripts/bench.ts [N=2000]
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';

const N = Number(process.argv[2] ?? 2000);
const WARMUP = 200;

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

async function bench(
  label: string,
  server: string,
  env: Record<string, string>,
  makeCall: (i: number) => { name: string; arguments: Record<string, unknown> },
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/servers', server, 'index.js')],
    env: {
      ...getDefaultEnvironment(),
      MCP_LOG_LEVEL: 'error', // per-call info logs would measure stderr I/O, not the server
      MCP_RATE_CAPACITY: '1000000',
      MCP_RATE_REFILL_PER_SEC: '1000000',
      ...env,
    },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'bench', version: '0.0.0' });
  await client.connect(transport);
  for (let i = 0; i < WARMUP; i++) await client.callTool(makeCall(i));
  const samples: number[] = [];
  let errors = 0;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const res = await client.callTool(makeCall(i));
    samples.push(performance.now() - t0);
    if (res.isError) errors++;
  }
  await client.close();
  samples.sort((a, b) => a - b);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const out = {
    label,
    calls: N,
    warmup: WARMUP,
    errors,
    p50_ms: r3(percentile(samples, 50)),
    p90_ms: r3(percentile(samples, 90)),
    p99_ms: r3(percentile(samples, 99)),
    max_ms: r3(samples[samples.length - 1] as number),
    mean_ms: r3(mean),
  };
  console.log(JSON.stringify(out));
  return out;
}

const tmp = mkdtempSync(join(tmpdir(), 'mcp-bench-'));
mkdirSync(join(tmp, 'docs'));
for (let i = 0; i < 20; i++) {
  writeFileSync(
    join(tmp, 'docs', `note-${i}.md`),
    `# Note ${i}\n` + 'lorem ipsum dolor\n'.repeat(200),
  );
}

try {
  const load = loadavg();
  const results = [
    await bench(
      'sqlite-readonly query (point lookup by primary key, 1 row)',
      'sqlite',
      { SQLITE_DB_PATH: resolve('data/sample.db') },
      (i) => ({
        name: 'query',
        arguments: {
          sql: 'SELECT id, status, ordered_at FROM orders WHERE id = ?',
          params: [(i % 1500) + 1],
        },
      }),
    ),
    await bench(
      'sqlite-readonly list_tables',
      'sqlite',
      { SQLITE_DB_PATH: resolve('data/sample.db') },
      () => ({ name: 'list_tables', arguments: {} }),
    ),
    await bench('fs-sandbox read_file (3.6 KB file)', 'fs', { FS_ROOT: tmp }, (i) => ({
      name: 'read_file',
      arguments: { path: `docs/note-${i % 20}.md` },
    })),
  ];
  const report = {
    generatedAt: new Date().toISOString(),
    method:
      'Sequential client.callTool() round trips over stdio against the built servers (dist/). ' +
      'Timer wraps the full request/response including JSON-RPC serialisation and schema validation.',
    environment: {
      node: process.version,
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model ?? 'unknown',
      cpuCount: cpus().length,
      loadAverage1m: r3(load[0] ?? 0),
    },
    headline: {
      metric: 'sqlite-readonly query p50 round-trip latency over stdio',
      value_ms: results[0]?.p50_ms,
      p99_ms: results[0]?.p99_ms,
      calls: N,
    },
    results,
  };
  mkdirSync('results', { recursive: true });
  writeFileSync('results/bench.json', JSON.stringify(report, null, 2) + '\n');
  console.log(`wrote results/bench.json (headline p50=${report.headline.value_ms} ms)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

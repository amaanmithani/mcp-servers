import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Process entrypoints (index.ts) and the sqlite worker shell run in child
      // processes / worker threads that v8 coverage in the test process cannot see.
      // They are exercised by the stdio integration tests instead.
      exclude: ['src/servers/*/index.ts', 'src/servers/sqlite/worker.ts', 'src/lib/run.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 75 },
    },
  },
});

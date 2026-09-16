import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __VERSION__: JSON.stringify('test'),
  },
  test: {
    include: ['src/tests/**/*.test.ts'],
    exclude: ['src/tests/sandbox.test.ts'], // requires compiled build (npm run test:sandbox)
    environment: 'node',
    env: {
      // Pin at 16 KB (standard tier) so existing tests pass at the expected
      // response cap. Production defaults to the "standard" 16 KB tier.
      OPENGROK_MAX_RESPONSE_BYTES: '16384',
    },
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary', 'json', 'cobertura'],
      include: ['src/server/**/*.ts'],
      exclude: [
        'src/tests/**',
        // Sandbox files require a compiled worker — coverage is measured by npm run test:sandbox
        'src/server/sandbox/sandbox.ts',
        'src/server/sandbox/worker.ts',
        'src/server/sandbox/buffer.ts',
        'src/server/sandbox/error-hints.ts',
        // Pure TypeScript interface re-exports — no runtime statements to measure
        'src/server/utils/api-types.ts',
        // Barrel re-exports only (no logic) — same precedent as api-types.ts
        'src/server/sandbox/schemas/index.ts',
        'src/server/intelligence/index.ts',
        // CLI entry points require terminal/system interaction — tested via integration
        'src/server/cli/**',
      ],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
      },
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // los tests comparten la base de datos: sin paralelismo
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // graphql has CJS and ESM builds; Vite would pick ESM while Node-loaded deps use CJS
    alias: { graphql: 'graphql/index.js' },
  },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

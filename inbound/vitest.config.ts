import { defineConfig } from 'vitest/config';

// Own config, so the host's vitest.config.ts one folder up is not used.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['test/**/*.test.ts'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    // Stagger must be injected per-test using the test helpers; no global
    // env bypass is set so parsing validation and queue behavior are honest.
  },
});

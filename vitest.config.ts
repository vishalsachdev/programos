import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    // A throwaway host-owned repository per test file (see the file).
    setupFiles: ['src/test-support/host-repo-setup.ts'],
    // Stagger must be injected per-test using the test helpers; no global
    // env bypass is set so parsing validation and queue behavior are honest.
  },
});

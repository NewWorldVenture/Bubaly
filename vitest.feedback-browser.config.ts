import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Chromium fixtures run explicitly after CI installs the browser.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['tests/feedback-submit-outcome.browser.ts'],
    testTimeout: 20_000,
    hookTimeout: 90_000,
    env: { TZ: process.env.TZ ?? 'UTC' },
  },
  resolve: { alias: { '@': resolve(__dirname, '.') } },
});

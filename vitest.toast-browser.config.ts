import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// A separate explicit selection keeps browser fixtures out of the unit jobs,
// where Chromium is not installed. CI runs this after installing the browser.
export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: ['tests/toast-commit-lifetime.browser.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: { TZ: process.env.TZ ?? 'UTC' },
  },
  resolve: { alias: { '@': resolve(__dirname, '.') } },
});

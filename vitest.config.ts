import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  // vitest 2.x / vite 5 transforms with esbuild, so the JSX automatic runtime
  // must be set under `esbuild` (the `oxc` key only applies to vitest 3+/rolldown
  // and is a no-op here). Without this, esbuild falls back to the CLASSIC runtime
  // and compiles JSX to `React.createElement`, so any component that (correctly,
  // per the app's automatic runtime) does not `import React` throws
  // "React is not defined" when server-rendered in a test — the failure seen in
  // tests/display-render.test.ts. `oxc` is kept for forward-compat with vitest 3.
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      'server-only': resolve(__dirname, 'tests/stubs/server-only.ts'),
      '@': resolve(__dirname, '.'),
    },
  },
});

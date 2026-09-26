import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  // The JSX automatic runtime must be configured, or the transform falls back to
  // the CLASSIC runtime and compiles JSX to `React.createElement`, so any
  // component that (correctly, per the app's automatic runtime) does not
  // `import React` throws "React is not defined" when server-rendered in a test.
  // tests/display-render.test.ts is the canary for that failure.
  //
  // WHICH key carries it depends on the transformer, and this comment used to
  // name the wrong one. The installed vitest is 4.x, which transforms with oxc
  // and prints "Both esbuild and oxc options were set. oxc options will be used
  // and esbuild options will be ignored" on every run when both are present. So
  // `oxc` is the live setting and the `esbuild` block was removed rather than
  // kept "for forward-compat": a key that is ignored cannot be doing the job the
  // comment credits it with, and leaving it implied the opposite.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Pin the host zone so a run is HERMETIC: date arithmetic that reads the
    // runtime's zone otherwise passes or fails depending on whose laptop it is.
    // A real DST bug hid here — lib/capture/parse.ts did its arithmetic in local
    // fields, so on a host in a DST-observing zone the spring-forward morning
    // moved a 02:30 appointment to 03:30 instead of 03:00, and every run on a
    // UTC machine said it was fine.
    //
    // `process.env.TZ ?? 'UTC'` rather than a bare 'UTC': CI runs this suite a
    // second time under TZ=America/Los_Angeles, and a hard-coded value here
    // would silently override that and make the DST job prove nothing.
    env: { TZ: process.env.TZ ?? 'UTC' },
  },
  resolve: {
    alias: {
      'server-only': resolve(__dirname, 'tests/stubs/server-only.ts'),
      '@': resolve(__dirname, '.'),
    },
  },
});

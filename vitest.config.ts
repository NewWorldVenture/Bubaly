import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  // JSX must compile to the AUTOMATIC runtime. Without it the transform falls
  // back to CLASSIC and emits `React.createElement`, so any component that
  // (correctly, per the app's automatic runtime) does not `import React` throws
  // "React is not defined" when server-rendered — the failure seen in
  // tests/display-render.test.ts.
  //
  // WHICH key does that depends on the transformer, and this project is on
  // vitest 4, which uses oxc. The comment here used to say the opposite — that
  // `esbuild` was live and `oxc` was "kept for forward-compat" — and every run
  // printed the correction:
  //
  //   Both esbuild and oxc options were set. oxc options will be used and
  //   esbuild options will be ignored.
  //
  // So the esbuild block was dead, the note describing it was backwards, and
  // the warning saying so was on screen ~1,300 times a run (F-F12). Only the
  // live one is kept. If this project ever moves back to an esbuild-based
  // vitest, the failure is loud and immediate, which is a better signal than a
  // dead block nobody can tell is dead.
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
    // The ONE place a Twilio-facing webhook may skip its signature check.
    //
    // lib/server/twilio-ingress.ts refuses an unverifiable callback (503)
    // rather than waving it through, which is what closes F-E07 for every
    // preview, staging and self-hosted deployment. Tests post unsigned bodies
    // to those routes by the dozen, so the bypass has to exist somewhere —
    // here, named and greppable, rather than as a NODE_ENV check compiled into
    // the routes themselves. It applies only when TWILIO_AUTH_TOKEN is unset:
    // a test that stubs a token still goes through real verification, which is
    // how tests/guardian-*-execution.test.ts exercise the signing path.
    env: { TZ: process.env.TZ ?? 'UTC', ALLOW_UNSIGNED_TWILIO_WEBHOOKS: '1' },

    // 20s, not vitest's default 5s (F-F05).
    //
    // Ninety-six cases across twelve files share one shape: a cold
    // `await import('@/app/…')` inside a default-timeout test. The first such
    // import in a worker pays for the whole module graph — route handler,
    // translation catalogues, Supabase client — and 5,000ms is not reliably
    // enough for it. Measured here: a marketing-route case timed out at
    // 5,007ms on its first case and passed in 422ms once the catalogue was
    // warm, and a full run under CPU contention timed out five unrelated cases
    // at exactly 5,000ms and passed all of them on a re-run.
    //
    // A timeout that fires on load rather than on a hang teaches everyone to
    // re-run the suite, which is how a real hang gets re-run too. 20s is long
    // enough that reaching it means something is actually stuck, and short
    // enough to stay a timeout rather than a wait.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
  resolve: {
    alias: {
      'server-only': resolve(__dirname, 'tests/stubs/server-only.ts'),
      '@': resolve(__dirname, '.'),
    },
  },
});

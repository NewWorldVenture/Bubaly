import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// MAIN-F-C07. The app read 19 environment variables that .env.example never
// mentioned, among them CONTACT_CENTER_INBOUND_SECRET (without it family email
// refuses every message) and the X OAuth pair (without it posting to X reports
// "setup required"). Whoever set up a deployment from the template could not
// know they existed. Each is now documented, and a new read has to be.

const SOURCES = execSync("git ls-files 'app/**' 'lib/**' 'components/**' middleware.ts instrumentation.ts next.config.mjs", { encoding: 'utf8' })
  .trim().split('\n').filter((f) => /\.(ts|tsx|mjs|js)$/.test(f) && !f.includes('.test.'));

/** Set by the platform or the runtime, never by whoever fills in the template. */
const PLATFORM = new Set([
  'NODE_ENV', 'TZ', 'NEXT_RUNTIME',
  'VERCEL_ENV', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_REGION', 'NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA',
]);

const read = new Set<string>();
for (const f of SOURCES) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) read.add(m[1] ?? m[2]);
}
// A variable is documented when the template names it as an assignment, live
// (`NAME=value`) or commented out (`# NAME=`), which is how optional ones are
// written because the file forbids assigning an empty value.
const documented = new Set(
  [...readFileSync('.env.example', 'utf8').matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]),
);

describe('.env.example documents every variable the app reads', () => {
  it('finds the reads at all (guards the guard)', () => {
    expect(read.size).toBeGreaterThan(60);
    expect(read.has('CONTACT_CENTER_INBOUND_SECRET')).toBe(true);
  });

  it('every read outside the platform set is in the template', () => {
    const missing = [...read].filter((v) => !PLATFORM.has(v) && !documented.has(v)).sort();
    expect(missing, 'document each in .env.example (commented out if optional)').toEqual([]);
  });

  it('the platform set names only variables the app really reads', () => {
    expect([...PLATFORM].filter((v) => !read.has(v))).toEqual([]);
  });
});

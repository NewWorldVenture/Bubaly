import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// `.env.example` is the only place an operator learns which switches exist.
// Two whole integrations — the feedback→GitHub bot and Apple/iCloud calendar
// sync — shipped without their variable names appearing in it. Both fail
// closed, which is right, so nothing broke loudly: the GitHub bot's cron just
// ran daily and did nothing, by construction, forever. An undiscoverable
// switch is a feature that is off for everyone who did not read lib/.
//
// This asserts the reverse direction of the usual env check. Not "is the value
// present" — that belongs to a running environment — but "does the name appear
// in the template at all", so a new `process.env.X` in shipped code cannot
// reach production without the operator being told it exists.

const ROOTS = ['app', 'lib', 'components'];
const FILES = ['middleware.ts'];
const CODE = /\.(ts|tsx)$/;

// Supplied by the platform or the build, never typed into a `.env` by hand.
// Adding a name here is a claim that nobody configures it — not a way to quiet
// the test.
const NOT_OPERATOR_CONFIGURED = new Set([
  'NODE_ENV', 'CI', 'PATH', 'TZ',
  'VERCEL_ENV', 'VERCEL_REGION', 'VERCEL_GIT_COMMIT_SHA', 'NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA',
  'NEXT_RUNTIME',
  // Injected by next.config.mjs from VERCEL_GIT_COMMIT_SHA.
  'BUBALY_BUILD_REVISION',
  // Test-only: points the AI provider at recorded fixtures.
  'AI_PROVIDER_STUB_DIR',
  // Read only behind a `?? 'dev'` fallback on the display error boundary.
  'NEXT_PUBLIC_BUILD_ID',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (CODE.test(entry)) out.push(path);
  }
  return out;
}

// Comments discuss variables without reading them — lib/health/status.ts
// documents the shape `process.env.X` as a placeholder, which is prose, not a
// dependency. Strip comments before scanning so the test measures what the code
// does rather than what it says.
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function envNamesReadBy(paths: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of paths) {
    const source = withoutComments(readFileSync(path, 'utf8'));
    for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      if (!found.has(match[1])) found.set(match[1], path);
    }
  }
  return found;
}

// A name counts as documented whether it is assigned or left commented out:
// the Google block deliberately ships `# GOOGLE_CALENDAR_REDIRECT_URI=` so the
// override is discoverable without an empty value defeating its fallback.
function namesDeclaredInTemplate(template: string): Set<string> {
  return new Set(Array.from(template.matchAll(/^\s*#?\s*([A-Z0-9_]+)=/gm), (m) => m[1]));
}

describe('.env.example covers the runtime configuration surface', () => {
  const template = readFileSync('.env.example', 'utf8');
  const declared = namesDeclaredInTemplate(template);
  const read = envNamesReadBy([...ROOTS.flatMap((r) => walk(r)), ...FILES]);

  it('documents every operator-configurable variable shipped code reads', () => {
    const undocumented = [...read]
      .filter(([name]) => !NOT_OPERATOR_CONFIGURED.has(name) && !declared.has(name))
      .map(([name, path]) => `${name} (first read at ${path})`)
      .sort();
    expect(undocumented).toEqual([]);
  });

  it('does not offer a variable no code reads', () => {
    // The reverse drift: `TWILIO_CALLER_NUMBER` sat in the template for as long
    // as the GitHub block was missing from it. An operator who sets it gets
    // nothing, and has no way to tell that from a setting that took effect.
    // Scoped to assigned names — a commented-out line is documentation, and
    // several legitimately describe values consumed outside app code.
    const assigned = new Set(Array.from(template.matchAll(/^([A-Z0-9_]+)=/gm), (m) => m[1]));
    const scriptsAndTooling = new Set([
      // Read by scripts/ and the E2E harness rather than by shipped code.
      'E2E_ALLOW_REMOTE_SUPABASE', 'E2E_AUTHENTICATED', 'E2E_AUTH_EMAIL',
      'SEED_CONFIRM_FAMILY_ID', 'SEED_CREATED_BY_USER_ID', 'SEED_ENVIRONMENT', 'SEED_FAMILY_ID',
      'E2E_AUTH_PASSWORD', 'PLAYWRIGHT_PORT',
      // Consumed by the Capacitor native shell config, not by the web app.
      'CAP_SERVER_URL',
    ]);
    const orphaned = [...assigned]
      .filter((name) => !read.has(name) && !scriptsAndTooling.has(name))
      .sort();
    expect(orphaned).toEqual([]);
  });

  it('documents the two switches that were missing, by name', () => {
    // Named explicitly so the regression this test was written for cannot come
    // back as a passing generic assertion.
    for (const name of ['GITHUB_TOKEN', 'GITHUB_FEEDBACK_REPO', 'APPLE_SYNC_ENABLED']) {
      expect(declared.has(name), `${name} missing from .env.example`).toBe(true);
    }
  });
});

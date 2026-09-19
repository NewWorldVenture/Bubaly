import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FEATURE_ENV, REQUIRED_ENV, checkFeatureEnv, summarizeHealth, buildHealthReport,
} from '../lib/health/status';

// A deployment can be missing CRON_SECRET and still serve every page perfectly.
// All 24 jobs in vercel.json then answer 401 — hasCronAuthorization is correctly
// fail-closed — so nightly notifications, wallet allowance, chore reminders, the
// weekly digest, autopilot scan, return reminders and calendar feeds simply stop.
// /api/health reported `ok` the whole time. CHILD_LOGIN_SECRET is the same shape:
// no child in any family can sign in, and nothing says so.
//
// These secrets must be REPORTED (degraded) and must NOT 503: a 503 would pull
// healthy instances out of rotation over a disabled feature.

const ok = { ok: true, latencyMs: 1 };
const healthyEnv = { ok: true, missing: [] };

describe('health reports the secrets whose absence silently kills a subsystem', () => {
  it('names a missing feature secret instead of ignoring it', () => {
    const r = checkFeatureEnv({ ...Object.fromEntries(FEATURE_ENV.map((n) => [n, 'set'])), CRON_SECRET: undefined });
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('CRON_SECRET');
  });

  it('treats blank as missing, not as configured', () => {
    expect(checkFeatureEnv({ CRON_SECRET: '   ' }).missing).toContain('CRON_SECRET');
  });

  it('is degraded — not ok — when a feature secret is absent', () => {
    const features = { ok: false, missing: ['CRON_SECRET'] };
    expect(summarizeHealth(healthyEnv, ok, ok, ok, features)).toBe('degraded');
    // Without this the endpoint claimed everything was fine.
    expect(summarizeHealth(healthyEnv, ok, ok, ok, features)).not.toBe('ok');
  });

  it('never turns a disabled feature into a 503', () => {
    const report = buildHealthReport(healthyEnv, ok, ok, new Date(), ok, { ok: false, missing: ['CRON_SECRET'] });
    expect(report.httpStatus).toBe(200);
    expect(report.status).toBe('degraded');
  });

  it('puts the missing names in the body so an operator can see which subsystem is dead', () => {
    const report = buildHealthReport(healthyEnv, ok, ok, new Date(), ok, { ok: false, missing: ['CRON_SECRET', 'CHILD_LOGIN_SECRET'] });
    expect(report.checks.features?.missing).toEqual(['CRON_SECRET', 'CHILD_LOGIN_SECRET']);
  });

  it('reports presence only — no secret VALUE can reach the response', () => {
    const r = checkFeatureEnv({ CRON_SECRET: 'super-secret-value', CHILD_LOGIN_SECRET: undefined });
    expect(JSON.stringify(r)).not.toContain('super-secret-value');
  });

  it('stays ok when every feature secret is set', () => {
    const features = checkFeatureEnv(Object.fromEntries(FEATURE_ENV.map((n) => [n, 'set'])));
    expect(features.ok).toBe(true);
    expect(summarizeHealth(healthyEnv, ok, ok, ok, features)).toBe('ok');
  });

  it('keeps feature secrets OUT of the hard-required list', () => {
    // Hard-required means 503. A missing cron secret must never do that.
    for (const name of FEATURE_ENV) expect(REQUIRED_ENV as readonly string[]).not.toContain(name);
  });

  it('every listed secret is actually read by the codebase (no stale entries)', () => {
    // A name that nothing reads would make this check decorative.
    for (const name of FEATURE_ENV) {
      const found = envReadLines(name).length > 0;
      expect(found, `${name} is in FEATURE_ENV but nothing reads it`).toBe(true);
    }
  });

  it('excludes secrets an admin can configure in the product', () => {
    // resolveAiSettings reads the database FIRST and falls back to env, so a
    // deployment with its key set in the admin console has no env var and a
    // working assistant. Listing these would report it degraded forever — and a
    // field that is always red is a field nobody reads.
    const settings = readFileSync('lib/ai/settings.ts', 'utf8');
    expect(settings).toMatch(/stored\.anthropicKey\s*\|\|\s*process\.env\.ANTHROPIC_API_KEY/);
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_MODEL']) {
      expect(FEATURE_ENV as readonly string[], `${name} has a database fallback and must not gate health`).not.toContain(name);
    }
  });

  it('every listed secret is env-only, with no stored fallback', () => {
    // The property that makes absence meaningful. If any of these gained a
    // database fallback, its absence from env would stop proving anything.
    for (const name of FEATURE_ENV) {
      const hits = envReadLines(name).join('\n');
      expect(hits.trim().length, `${name} is read nowhere`).toBeGreaterThan(0);
      // A stored-value fallback looks like `stored.x || process.env.NAME`.
      expect(hits, `${name} has a stored fallback — absence from env no longer proves it is unconfigured`)
        .not.toMatch(new RegExp(`stored\\.\\w+\\s*\\|\\|\\s*process\\.env\\.${name}`));
    }
  });

  it('CRON_SECRET gates every job vercel.json schedules', () => {
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons?: { path: string }[] };
    const crons = vercel.crons ?? [];
    expect(crons.length).toBeGreaterThan(0);
    const helper = readFileSync('lib/server/cron-auth.ts', 'utf8');
    // Fail-closed: an unset secret must not become a matchable "Bearer undefined".
    expect(helper).toContain('!!secret &&');
    for (const { path } of crons) {
      const route = readFileSync(`app${path}/route.ts`, 'utf8');
      expect(route, `${path} must enforce cron authorization`).toContain('if (!hasCronAuthorization');
    }
  });
});

function sourceText(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = join(dir, entry.name);
    return entry.isDirectory() ? sourceText(file)
      : /\.tsx?$/.test(entry.name) ? [readFileSync(file, 'utf8')] : [];
  });
}

const lines = ['app', 'lib'].flatMap(sourceText).flatMap(source => source.split(/\r?\n/));
function envReadLines(name: string): string[] {
  return lines.filter(line => line.includes(`process.env.${name}`));
}

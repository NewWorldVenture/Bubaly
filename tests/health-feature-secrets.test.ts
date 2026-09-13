import { readFileSync } from 'node:fs';
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
    const sources = ['app', 'lib'];
    for (const name of FEATURE_ENV) {
      const found = sources.some((dir) => {
        try {
          return execSyncGrep(dir, name);
        } catch { return false; }
      });
      expect(found, `${name} is in FEATURE_ENV but nothing reads it`).toBe(true);
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

function execSyncGrep(dir: string, name: string): boolean {
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  const out = execSync(`grep -rl "process.env.${name}" ${dir} --include=*.ts --include=*.tsx || true`, { encoding: 'utf8' });
  return out.trim().length > 0;
}

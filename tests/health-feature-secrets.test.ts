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
/**
 * Where a secret is read from the environment — in EITHER spelling.
 *
 * `process.env.NAME` is one. `privateKeyEnv('NAME')` in lib/server/native-push.ts
 * is the other: it indexes `process.env` by argument so one function can undo the
 * literal `\n` that a PEM picks up when it is pasted into a dashboard field.
 *
 * Matching only the dotted form reported both native signing keys as "read
 * nowhere" — the guard failing against an empty base rather than finding a real
 * absence, which is the exact failure mode this file exists to catch. The
 * indirect branch is deliberately narrow: it applies only when the sources really
 * do index `process.env` by a variable, and it still requires the name to appear
 * as a string literal in app/ or lib/.
 */
function envReadLines(name: string): string[] {
  const direct = lines.filter(line => line.includes(`process.env.${name}`));
  if (direct.length > 0) return direct;
  if (!lines.some(line => /process\.env\[/.test(line))) return [];
  return lines.filter(line => line.includes(`'${name}'`) || line.includes(`"${name}"`));
}

/**
 * The other direction.
 *
 * Every rule above checks that what IS listed belongs there: it is really read,
 * it is env-only, an admin cannot set it in the product. None checks that what
 * belongs there IS listed — and that is the direction a subsystem dies in. It
 * is the same asymmetry the translation catalogue had, where orphaned keys were
 * guarded and missing ones were not.
 *
 * It has already cost this codebase twice. `RESEND_API_KEY` gates every outbound
 * email and was absent from this list until an audit pass put it there
 * (audit/claude-4.md raised it). `VAPID_PRIVATE_KEY` and the native signing keys
 * gate web and native push and were absent until this one. The native names then
 * MOVED — the legacy `FCM_SERVER_KEY` endpoint was retired for FCM v1 and APNs —
 * and a list that names a retired secret reports a subsystem as configured while
 * its real credential is unset, which is the same failure one indirection later.
 *
 * So: a closed list of the gates, each carrying the evidence that it meets the
 * criteria in `lib/health/status.ts` — absence silently disables a whole shipped
 * subsystem, and the secret is read only as `process.env.X`. Adding a gate here
 * without adding it to FEATURE_ENV fails.
 */
const SUBSYSTEM_GATES: { name: string; subsystem: string; silentBecause: string }[] = [
  { name: 'CRON_SECRET', subsystem: 'all 24 scheduled jobs', silentBecause: 'hasCronAuthorization fails closed, so every job answers 401 and nothing logs an error' },
  { name: 'RESEND_API_KEY', subsystem: 'every outbound email', silentBecause: 'lib/email.ts reports success when it is unset, so rows are marked delivered for mail never sent' },
  { name: 'CHILD_LOGIN_SECRET', subsystem: 'child sign-in', silentBecause: 'no child in any family can sign in and nothing says so' },
  { name: 'VAPID_PRIVATE_KEY', subsystem: 'web push', silentBecause: 'ensureVapid() false counts every webpush device as skipped, not failed' },
  { name: 'FCM_PRIVATE_KEY', subsystem: 'native Android push (FCM v1)', silentBecause: "nativePushConfigured().fcm false makes sendNativePush answer 'unconfigured', which the sender counts as skipped, not failed" },
  { name: 'APNS_PRIVATE_KEY', subsystem: 'native iOS push (APNs)', silentBecause: "nativePushConfigured().apns false makes sendNativePush answer 'unconfigured', which the sender counts as skipped, not failed" },
];

describe('a secret that silently kills a subsystem is on the list', () => {
  it('lists every known subsystem gate', () => {
    const missing = SUBSYSTEM_GATES
      .filter((g) => !(FEATURE_ENV as readonly string[]).includes(g.name))
      .map((g) => `${g.name} — ${g.subsystem}: ${g.silentBecause}`);
    expect(
      missing,
      'these gate a whole shipped subsystem and are read only from the environment, '
      + 'so their absence is invisible from the outside — which is the entire reason '
      + 'FEATURE_ENV exists. Add them to it:\n' + missing.map((m) => `  ${m}`).join('\n'),
    ).toEqual([]);
  });

  it('states why each gate is silent rather than merely naming it', () => {
    // An entry without its mechanism is a claim nobody can check later.
    for (const g of SUBSYSTEM_GATES) {
      expect(g.silentBecause.length, `${g.name} does not say how it fails`).toBeGreaterThan(20);
      expect(g.subsystem.length, `${g.name} does not name its subsystem`).toBeGreaterThan(3);
    }
  });

  it('the push gates really do count skipped rather than failed', () => {
    // The mechanism, checked in the source rather than asserted in prose: it is
    // what makes an unset key look like success to every caller, and if it ever
    // became `failed++` these two would stop belonging on the list.
    const push = readFileSync('lib/server/push.ts', 'utf8');
    expect(push).toMatch(/if \(!vapid \|\| [^)]*\) \{ result\.skipped\+\+; continue; \}/);
    // The native path moved the gate into sendNativePush, which reports the
    // reason rather than the sender re-checking the keys. Same consequence: an
    // unconfigured provider increments `skipped`, so the caller still sees
    // { sent: 0, failed: 0 } and reads itself as clean.
    expect(push).toMatch(/else if \(outcome === 'unconfigured'\) result\.skipped\+\+;/);
    const native = readFileSync('lib/server/native-push.ts', 'utf8');
    expect(native).toMatch(/export function nativePushConfigured\(\)/);
  });

  it('neither push gate has an admin-console fallback', () => {
    // The exclusion test FEATURE_ENV applies to the AI keys, applied to these:
    // a stored fallback would make absence from env stop proving anything.
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    for (const name of ['VAPID_PRIVATE_KEY', 'FCM_PRIVATE_KEY', 'APNS_PRIVATE_KEY']) {
      // The name, not `process.env.${name}`: the two private keys are read
      // through `privateKeyEnv(name)`, which indexes `process.env` by argument
      // so it can undo the literal `\n` a PEM picks up in a dashboard field.
      // Grepping the dotted spelling reported both as "read nowhere" — a guard
      // passing on an empty base, which is the failure this file is about.
      const hits = execSync(
        `grep -rn "${name}" app lib --include=*.ts --include=*.tsx || true`,
        { encoding: 'utf8' },
      );
      expect(hits.trim().length, `${name} is read nowhere`).toBeGreaterThan(0);
      expect(
        /(stored|cfg|settings|config)\.\w+\s*(\|\||\?\?)\s*process\.env\./.test(hits),
        `${name} appears to have a stored fallback; re-check whether it belongs in FEATURE_ENV`,
      ).toBe(false);
    }
  });
});

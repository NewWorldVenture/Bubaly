// lib/health/status.ts — pure, dependency-free helpers behind the /api/health
// readiness endpoint. Kept separate from the route so the decision logic is unit
// testable without a live network or Supabase project.

/**
 * Environment variables the app CANNOT boot/serve requests without. These are the
 * three Supabase core credentials every server path assumes are present
 * (`lib/supabase/server.ts` reads them with the non-null `!` assertion, so a
 * missing one surfaces as an opaque runtime crash — this guard turns that into an
 * explicit, greppable readiness failure instead).
 *
 * Optional integrations (Stripe, Anthropic/OpenAI, push, email, cron secret) are
 * deliberately NOT listed: every one of those code paths is already feature-gated
 * and fails closed with an honest 503 when unset, so their absence is a disabled
 * feature, not an unhealthy deployment.
 */
export const REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

export type EnvCheck = { ok: boolean; missing: string[] };

/**
 * Reports which required env vars are absent/blank. Only presence is inspected —
 * values are never read into the response, so no secret can leak through /health.
 */
export function checkRequiredEnv(env: Record<string, string | undefined>): EnvCheck {
  const missing = REQUIRED_ENV.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });
  return { ok: missing.length === 0, missing };
}

export type DatabaseCheck = { ok: boolean; latencyMs: number | null; error?: string };

export type HealthStatus = 'ok' | 'degraded' | 'error';

export type HealthReport = {
  status: HealthStatus;
  httpStatus: 200 | 503;
  timestamp: string;
  checks: {
    env: EnvCheck;
    database: DatabaseCheck;
  };
};

/**
 * Folds the individual probe results into one overall status + HTTP code.
 *
 * - `error` / 503 when a hard dependency is broken: a required env var is missing,
 *   OR the env is configured but the database is unreachable (a monitor should
 *   page on this — the app cannot serve authenticated traffic).
 * - `degraded` / 200 when env is complete but the DB probe was skipped (e.g. env
 *   missing made the probe moot) — reserved; not emitted in the normal path.
 * - `ok` / 200 when every probe passed.
 */
export function summarizeHealth(env: EnvCheck, database: DatabaseCheck): HealthStatus {
  if (!env.ok) return 'error';
  if (!database.ok) return 'error';
  return 'ok';
}

export function buildHealthReport(
  env: EnvCheck,
  database: DatabaseCheck,
  now: Date = new Date(),
): HealthReport {
  const status = summarizeHealth(env, database);
  return {
    status,
    httpStatus: status === 'ok' ? 200 : 503,
    timestamp: now.toISOString(),
    checks: { env, database },
  };
}

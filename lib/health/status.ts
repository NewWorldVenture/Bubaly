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

// A probe result. `database` (PostgREST) and `auth` (GoTrue) share this shape.
export type ProbeCheck = { ok: boolean; latencyMs: number | null; error?: string };
// Retained alias for the original database-only name (back-compat for importers).
export type DatabaseCheck = ProbeCheck;

export type HealthStatus = 'ok' | 'degraded' | 'error';

export type HealthReport = {
  status: HealthStatus;
  httpStatus: 200 | 503;
  timestamp: string;
  checks: {
    env: EnvCheck;
    database: ProbeCheck;
    auth: ProbeCheck;
    // Optional: only reported when the caller supplied a service-role probe.
    // Absent means "not checked", which is different from "checked and fine".
    serviceRole?: ProbeCheck;
  };
};

/**
 * Folds the individual probe results into one overall status + HTTP code.
 *
 * - `error` / 503 — a HARD dependency is broken: a required env var is missing, OR
 *   the env is configured but PostgREST (the data layer) is unreachable. A monitor
 *   should page: the app cannot serve its core data, and returning 503 correctly
 *   removes the instance from rotation.
 * - `degraded` / **200** — env + data are healthy but the Supabase **auth** service
 *   (GoTrue) is unreachable. This is exactly the LB-001 failure mode. It is
 *   deliberately NOT a 503: GoTrue is a shared upstream, so failing the health
 *   check on every instance would yank the whole fleet out of rotation and turn an
 *   auth-only outage into a total (even anonymous-traffic) outage. 200+`degraded`
 *   keeps healthy instances serving public/cached traffic while still signalling
 *   the problem in the body for alerting.
 * - `ok` / 200 — every probe passed.
 */
export function summarizeHealth(
  env: EnvCheck,
  database: ProbeCheck,
  auth: ProbeCheck,
  serviceRole?: ProbeCheck,
): HealthStatus {
  if (!env.ok) return 'error';
  if (!database.ok) return 'error';
  if (!auth.ok) return 'degraded';
  // Present-but-invalid service-role key. `checkRequiredEnv` cannot see this —
  // it only tests presence — so without this branch the endpoint reports `ok`
  // while every admin page, webhook and cron job reads nothing at all.
  if (serviceRole && !serviceRole.ok) return 'degraded';
  return 'ok';
}

export function buildHealthReport(
  env: EnvCheck,
  database: ProbeCheck,
  auth: ProbeCheck,
  now: Date = new Date(),
  serviceRole?: ProbeCheck,
): HealthReport {
  const status = summarizeHealth(env, database, auth, serviceRole);
  return {
    status,
    httpStatus: status === 'error' ? 503 : 200,
    timestamp: now.toISOString(),
    checks: { env, database, auth, ...(serviceRole ? { serviceRole } : {}) },
  };
}

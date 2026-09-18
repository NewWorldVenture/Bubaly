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
 * Optional integrations (Stripe, Anthropic/OpenAI, push, email) are deliberately
 * NOT listed: their code paths are feature-gated, so absence is a disabled
 * feature, not an unhealthy deployment, and a 503 would wrongly pull the
 * instance from rotation.
 *
 * That reasoning is right about the 503 and was wrong about the reporting. See
 * FEATURE_ENV below: some of those "disabled features" are entire subsystems
 * that go silent, and this endpoint used to say `ok` while they were dead.
 */
export const REQUIRED_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

export type EnvCheck = { ok: boolean; missing: string[] };

/**
 * Secrets whose absence silently disables a WHOLE shipped subsystem.
 *
 * These are not hard dependencies — the app boots and serves every page without
 * them — so they must not produce a 503. But they were not reported anywhere
 * either, and the failure they cause is invisible from the outside:
 *
 * - `CRON_SECRET` gates all 24 scheduled jobs declared in `vercel.json`.
 *   `hasCronAuthorization` is correctly fail-closed, so with the secret unset
 *   every one of them answers **401** — not 503, and not logged as an error.
 *   Nightly notifications, wallet allowance, chore reminders, the weekly digest,
 *   autopilot scan, return reminders and calendar feeds all just stop, and
 *   `/api/health` reported `ok` throughout.
 * - `CHILD_LOGIN_SECRET` gates child sign-in end to end: `childSignInAction`
 *   returns "kid sign-in isn't set up" before reading anything, so no child in
 *   any family can log in.
 * - The remaining four gate provider ingress and signed links; each fails closed
 *   in its own handler, which is correct, and equally invisible.
 *
 * Reported as `degraded` + **200**, which is what that status was built for:
 * signal it in the body for alerting without yanking healthy instances out of
 * rotation. A preview deployment that legitimately runs no crons will show
 * degraded with the names listed, which is accurate rather than noisy.
 */
/**
 * The inclusion rule, because the obvious extension of this list is wrong.
 *
 * A name belongs here only if the environment is the ONLY place it can come
 * from. The AI provider keys look like they qualify and do not:
 * `resolveAiSettings` reads admin-saved values from the database FIRST and falls
 * back to env (`stored.anthropicKey || process.env.ANTHROPIC_API_KEY`). A
 * deployment that configures its key in the admin console has no such env var
 * and a perfectly working assistant — listing it here would report that healthy
 * deployment as degraded forever, which trains operators to ignore the field.
 *
 * Same test for anything added later: if an admin can set it in the product,
 * absence from the environment proves nothing. Every name below is read only as
 * `process.env.X`, with no stored fallback.
 */
export const FEATURE_ENV = [
  'CRON_SECRET',
  // Every outbound email: notification digests, family invites, marketing sends.
  // Worse than merely silent — `lib/email.ts` reports success when it is unset,
  // so notification rows are marked delivered for mail that was never sent, and
  // the dedupe then suppresses the retry. Env-only across five read sites, no
  // stored fallback, so absence here does prove it is unconfigured.
  'RESEND_API_KEY',
  'CHILD_LOGIN_SECRET',
  'INTERNAL_SECRET',
  'CONTACT_CENTER_INBOUND_SECRET',
  'MARKETING_UNSUB_SECRET',
  'GUARDIAN_INTERNAL_SECRET',
  // Web Push, end to end. `ensureVapid()` in lib/server/push.ts needs the pair
  // and, without it, every webpush device is counted `skipped` rather than
  // `failed` — so the caller sees { sent: 0, failed: 0 } and reports itself
  // clean while no push has left the building. Exactly the RESEND_API_KEY shape
  // above: not an error, an absence that reads as success. Env-only at its one
  // read site, with no admin-console fallback, unlike the AI keys.
  'VAPID_PRIVATE_KEY',
  // The same, for the native iOS/Android apps: `fcmConfigured()` gates the FCM
  // path and an unset key skips every native device just as quietly. The admin
  // push page already tells an operator delivery is "skipped until keys are
  // set" — /api/health was the one place that did not.
  'FCM_SERVER_KEY',
] as const;

/**
 * Which feature-gating secrets are absent. Presence only — no value is ever read
 * into the response, exactly as `checkRequiredEnv` guarantees.
 */
export function checkFeatureEnv(env: Record<string, string | undefined>): EnvCheck {
  const missing = FEATURE_ENV.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });
  return { ok: missing.length === 0, missing };
}

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
    features?: EnvCheck;
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
  features?: EnvCheck,
): HealthStatus {
  if (!env.ok) return 'error';
  if (!database.ok) return 'error';
  if (!auth.ok) return 'degraded';
  // Present-but-invalid service-role key. `checkRequiredEnv` cannot see this —
  // it only tests presence — so without this branch the endpoint reports `ok`
  // while every admin page, webhook and cron job reads nothing at all.
  if (serviceRole && !serviceRole.ok) return 'degraded';
  // Same shape, one level out: a missing feature secret leaves the deployment
  // able to serve every page while a whole subsystem is dead. Reported, never
  // a 503 — see FEATURE_ENV.
  if (features && !features.ok) return 'degraded';
  return 'ok';
}

export function buildHealthReport(
  env: EnvCheck,
  database: ProbeCheck,
  auth: ProbeCheck,
  now: Date = new Date(),
  serviceRole?: ProbeCheck,
  features?: EnvCheck,
): HealthReport {
  const status = summarizeHealth(env, database, auth, serviceRole, features);
  return {
    status,
    httpStatus: status === 'error' ? 503 : 200,
    timestamp: now.toISOString(),
    checks: {
      env,
      database,
      auth,
      ...(serviceRole ? { serviceRole } : {}),
      ...(features ? { features } : {}),
    },
  };
}

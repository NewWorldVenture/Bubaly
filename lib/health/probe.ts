// lib/health/probe.ts — the one impure part of the readiness check: a bounded,
// RLS-independent connectivity probe against the Supabase PostgREST root.
//
// We hit `${url}/rest/v1/` (the OpenAPI/root document) rather than any table so
// the probe never depends on row-level security, seed data, or a specific schema —
// a reachable PostgREST replies regardless of what the caller may read. The anon
// key is sent as the apikey so the gateway accepts the request. A short Abort
// timeout keeps a stalled DB from hanging the health check (and any monitor).

import type { ProbeCheck } from './status';

const DEFAULT_TIMEOUT_MS = 3000;

// Shared bounded GET probe. `unhealthyAt` is the first status code treated as a
// failure (default 500) so a probe can decide whether a given HTTP response means
// "reachable" or "broken". Always fails closed (never throws) on timeout/reject.
async function probe(
  path: string,
  label: string,
  url: string | undefined,
  anonKey: string | undefined,
  timeoutMs: number,
  // When true, a 401/403 counts as a FAILURE rather than "reachable". The
  // connectivity probes want the opposite — being told "not authorised" still
  // proves the gateway answered — but a probe whose whole purpose is to check a
  // credential must not pass when that credential is rejected.
  keyMustBeAccepted = false,
): Promise<ProbeCheck> {
  if (!url || !anonKey) {
    return { ok: false, latencyMs: null, error: 'supabase env not configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}${path}`, {
      method: 'GET',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    const latencyMs = Date.now() - startedAt;
    // Any HTTP response means the gateway is reachable; a 5xx means it is up but
    // broken (this is the LB-001 shape for the auth service).
    if (res.status >= 500) {
      return { ok: false, latencyMs, error: `${label} ${res.status}` };
    }
    if (keyMustBeAccepted && (res.status === 401 || res.status === 403)) {
      return { ok: false, latencyMs, error: `${label} rejected the key (${res.status})` };
    }
    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const reason = err instanceof Error && err.name === 'AbortError'
      ? `timeout after ${timeoutMs}ms`
      : err instanceof Error ? err.message : 'unreachable';
    return { ok: false, latencyMs, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

// PostgREST connectivity — RLS-independent (hits the OpenAPI root, no table/seed).
export function probeDatabase(
  url: string | undefined,
  anonKey: string | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeCheck> {
  return probe('/rest/v1/', 'postgrest', url, anonKey, timeoutMs);
}

// Supabase Auth (GoTrue) liveness — hits the service's own /auth/v1/health, so it
// surfaces the exact LB-001 failure (auth 500 while the database is fine).
export function probeAuth(
  url: string | undefined,
  anonKey: string | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeCheck> {
  return probe('/auth/v1/health', 'gotrue', url, anonKey, timeoutMs);
}

/**
 * Does the SERVICE-ROLE key still work?
 *
 * The other probes deliberately send the anon key, so they answer "is Supabase
 * reachable" and nothing more. That left a real gap: `checkRequiredEnv` only
 * tests that SUPABASE_SERVICE_ROLE_KEY is *present*, never that it is *valid* —
 * so a wrong, rotated, or truncated key reported a perfectly healthy `ok` while
 * every admin page, webhook and cron job silently read nothing. That is exactly
 * the state production reached, and the only thing that surfaced it was an
 * administrator noticing an empty dashboard.
 *
 * A rejected key is reported as `degraded`, never 503: admin and background work
 * are broken, but public and signed-in traffic still serve fine, so failing the
 * health check would yank healthy instances out of rotation over an outage that
 * does not affect them.
 */
export function probeServiceRole(
  url: string | undefined,
  serviceRoleKey: string | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<ProbeCheck> {
  return probe('/rest/v1/', 'service-role', url, serviceRoleKey, timeoutMs, true);
}

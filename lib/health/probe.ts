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

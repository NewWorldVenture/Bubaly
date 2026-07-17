// lib/health/probe.ts — the one impure part of the readiness check: a bounded,
// RLS-independent connectivity probe against the Supabase PostgREST root.
//
// We hit `${url}/rest/v1/` (the OpenAPI/root document) rather than any table so
// the probe never depends on row-level security, seed data, or a specific schema —
// a reachable PostgREST replies regardless of what the caller may read. The anon
// key is sent as the apikey so the gateway accepts the request. A short Abort
// timeout keeps a stalled DB from hanging the health check (and any monitor).

import type { DatabaseCheck } from './status';

const DEFAULT_TIMEOUT_MS = 3000;

export async function probeDatabase(
  url: string | undefined,
  anonKey: string | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<DatabaseCheck> {
  if (!url || !anonKey) {
    return { ok: false, latencyMs: null, error: 'supabase env not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/`, {
      method: 'GET',
      headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
      signal: controller.signal,
      cache: 'no-store',
    });
    const latencyMs = Date.now() - startedAt;
    // Any HTTP response from PostgREST means the DB gateway is reachable. A 5xx is
    // treated as unhealthy; 2xx/3xx/4xx (incl. the root doc) count as reachable.
    if (res.status >= 500) {
      return { ok: false, latencyMs, error: `postgrest ${res.status}` };
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

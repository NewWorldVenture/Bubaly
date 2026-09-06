// lib/supabase/service-writer.ts — "this row is the server's, not the caller's".
//
// Some tables are written on a family's behalf rather than by them: the trust
// ledger (0260 removed member INSERT entirely), approval requests (0252 pins
// what a member may file), the brief delivery row (0262 — `delivered_at` is a
// compare-and-set that decides whether a family is told once or twice). The
// server code that writes them escalates to the service role here.
//
// The fallback matters as much as the escalation: unit tests and any
// environment without service credentials keep writing through the caller's
// client, which is what happened before these lockdowns and what the
// recorder-based tests observe.
import 'server-only';

export async function serverWriter<T>(fallback: T): Promise<T> {
  try {
    const { createServiceClient } = await import('@/lib/supabase/server');
    return createServiceClient() as unknown as T;
  } catch {
    return fallback;
  }
}

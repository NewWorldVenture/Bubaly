// lib/trust/ledger.ts — who writes the trust ledger.
//
// trust_audit_logs is the record a family can point at to say "this is what
// Bubaly did and this is who said yes". 0260 removed the member INSERT policy,
// so the only writer left is server code holding the service role. Every
// recorder in the codebase goes through this one helper.
//
// The fallback matters as much as the escalation: unit tests and any
// environment without service credentials keep writing through the caller's
// client, which is exactly what happened before 0260 and what the
// recorder-based tests observe.
import 'server-only';

export async function ledgerWriter<T>(fallback: T): Promise<T> {
  try {
    const { createServiceClient } = await import('@/lib/supabase/server');
    return createServiceClient() as unknown as T;
  } catch {
    return fallback;
  }
}

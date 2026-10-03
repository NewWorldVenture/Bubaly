import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type AuditEntry = {
  familyId: string | null;
  actorId?: string | null;
  action: string;
  resource: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** Whether an audit row landed; `error` is what the database answered. */
export type AuditOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * Append an entry to the family audit log and SAY whether it landed.
 *
 * For the caller that must not go on without its row. An export of personal
 * data is the clear case: the audit row is the only record that it happened,
 * and when the write is refused nothing has been sent yet, so refusing costs
 * the operator a retry and nothing else. The privacy export already does this
 * against trust_audit_logs; this is the same rule for audit_logs. Where the
 * action has already happened by the time the row is written — money moved, a
 * login created — use logAudit below: being loud is the fix there, being fatal
 * is not. Never rejects.
 */
export async function recordAudit(
  supabase: SupabaseClient<Database>,
  entry: AuditEntry,
): Promise<AuditOutcome> {
  try {
    const { error } = await supabase.from('audit_logs').insert({
      family_id: entry.familyId,
      actor_id: entry.actorId ?? null,
      action: entry.action,
      resource: entry.resource,
      resource_id: entry.resourceId ?? null,
      metadata: (entry.metadata ?? null) as Database['public']['Tables']['audit_logs']['Insert']['metadata'],
    });
    // The error has to be READ, not caught. A PostgREST call resolves with
    // { data, error } and rejects only under .throwOnError() — without it, even
    // a fetch-level failure is converted into a resolved error. So the catch
    // below could never see an RLS denial, a constraint violation, a column
    // mismatch or a dead connection: every one of those resolves. The line that
    // was written to notice a failed audit write had never run, and could not,
    // which is why every failure across all 14 callers was silent.
    return error ? { ok: false, error } : { ok: true };
  } catch (e) {
    // Kept for the one way left to arrive here: a synchronous throw while the
    // query is being built, e.g. a client constructed without a URL.
    return { ok: false, error: e };
  }
}

/** Append an entry to the family audit log. Best-effort: reports a lost row, never throws into the caller. */
export async function logAudit(supabase: SupabaseClient<Database>, entry: AuditEntry): Promise<void> {
  const outcome = await recordAudit(supabase, entry);
  if (!outcome.ok) console.error('[audit] failed to write log', outcome.error);
}

/**
 * Append a row to the wallet audit trail, reporting a write that did not land.
 *
 * Separate from logAudit because it is a different table with a different
 * shape, and shared because it was written out longhand at eight call sites,
 * every one of them discarding the result — so a transfer, a card issue or a
 * claimed Pay-ID could be recorded with no audit row and nobody would know.
 *
 * Deliberately does NOT fail the caller. By the time this runs the money has
 * already moved; refusing the whole action because its log failed would turn a
 * bookkeeping problem into a financial one. Being loud is the fix; being fatal
 * is not.
 */
export async function logWalletAudit(
  supabase: SupabaseClient<Database>,
  row: Database['public']['Tables']['wallet_audit_logs']['Insert'],
  operation: string,
): Promise<void> {
  try {
    const { error } = await supabase.from('wallet_audit_logs').insert(row);
    if (error) console.error(`[wallet-audit] ${operation} was not recorded`, error);
  } catch (e) {
    console.error(`[wallet-audit] ${operation} was not recorded`, e);
  }
}

// Persisted snapshots are quarantined until every source's current access can
// be revalidated. Family/member identity alone cannot establish that an old
// snapshot is still authorized. Fresh briefing generation remains independent.
// These helpers must not access snapshots even with a privileged DB override;
// migration 0262 also blocks direct access for database roles subject to RLS.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import type { Brief, BriefKind } from './build';

type DB = SupabaseClient<Database>;

/**
 * Snapshot persistence is paused. Preserve the non-throwing result contract,
 * but never fabricate an id or encourage retries for an intentionally blocked
 * write. Callers can still generate and display a fresh brief.
 */
export async function saveBrief(_scope: ServiceScope, _brief: Brief, _opts?: { db?: DB }): Promise<ServiceResult<{ id: string }>> {
  return fail('Saved briefs are temporarily unavailable. Generate a fresh brief.', {
    code: SERVICE_CODES.denied,
    retryable: false,
  });
}

/** Always miss: legacy, shared and member-labelled snapshots are not reusable. */
export async function loadBrief(
  _scope: ServiceScope,
  _args: { asOfDate: string; kind: BriefKind },
  _opts?: { db?: DB },
): Promise<ServiceResult<{ id: string; brief: Brief; deliveredAt: string | null } | null>> {
  return ok(null);
}

/**
 * A quarantined snapshot cannot authorize a delivery claim. Return false
 * without reading or mutating a row, including for privileged callers.
 */
export async function markDelivered(
  _scope: ServiceScope,
  _briefId: string,
  _opts?: { db?: DB; now?: Date },
): Promise<ServiceResult<boolean>> {
  return ok(false);
}

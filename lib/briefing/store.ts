// Reading and writing `home_briefs` — the delivery half of §49.
//
// A brief is filed once per family per day per kind (0258's unique index), so
// this module is deliberately built around an upsert on that key: a cron that
// runs twice, a page that rebuilds while the cron is mid-flight, and a retried
// invocation all converge on one row rather than three. `delivered_at` is
// separate from the row's existence for the same reason — building a brief and
// telling the family about it are two different events, and only the second
// one may happen once.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { serverWriter } from '@/lib/supabase/service-writer';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { briefRow, briefSchema, type Brief, type BriefKind } from './build';

type DB = SupabaseClient<Database>;

/**
 * Save (or refresh) today's brief. Returns the row id either way.
 *
 * Never throws: a brief is something a family reads, and filing it is a side
 * effect of showing it. A storage problem — a client without `upsert`, a
 * dropped connection, a table that has not been migrated yet — must cost the
 * row, never the briefing, so everything here comes back as a ServiceResult.
 */
export async function saveBrief(scope: ServiceScope, brief: Brief, opts?: { db?: DB }): Promise<ServiceResult<{ id: string }>> {
  // 0262 removed member INSERT/UPDATE on home_briefs. The row is a delivery
  // ledger, not a document a family edits: `delivered_at` is the compare-and-set
  // that decides whether they are told once or twice, and a member who could
  // stamp it could silence their own family's morning brief.
  const db = opts?.db ?? await serverWriter(scope.db);
  const row = briefRow(brief, scope.familyId, scope.userId);
  try {
    const { data, error } = await db
      .from('home_briefs')
      .upsert(row as never, { onConflict: 'family_id,as_of_date,kind' })
      .select('id')
      .single();
    if (error || !data) {
      console.error('[briefing] could not save the brief', error);
      return fail(describeDbError(error, 'Bubaly could not save your brief.'), { code: SERVICE_CODES.db, retryable: true });
    }
    return ok({ id: data.id });
  } catch (error) {
    console.error('[briefing] the brief could not be filed', error);
    return fail('Bubaly could not save your brief.', { code: SERVICE_CODES.db, retryable: true });
  }
}

/** Today's brief for this family, or null. Validated, so a corrupt row reads as absent rather than crashing a page. */
export async function loadBrief(
  scope: ServiceScope,
  args: { asOfDate: string; kind: BriefKind },
  opts?: { db?: DB },
): Promise<ServiceResult<{ id: string; brief: Brief; deliveredAt: string | null } | null>> {
  const db = opts?.db ?? scope.db;
  const { data, error } = await db
    .from('home_briefs')
    .select('id, brief, delivered_at')
    .eq('family_id', scope.familyId)
    .eq('as_of_date', args.asOfDate)
    .eq('kind', args.kind)
    .maybeSingle();
  if (error) {
    console.error('[briefing] could not read the brief', error);
    return fail(describeDbError(error, 'Bubaly could not open your brief.'), { code: SERVICE_CODES.db, retryable: true });
  }
  if (!data) return ok(null);
  const parsed = briefSchema.safeParse(data.brief);
  if (!parsed.success) {
    // A row written by an older shape is not an error the family should see;
    // the caller rebuilds. Saying "no brief yet" is the honest degradation.
    console.error('[briefing] stored brief did not match the schema', parsed.error.issues.slice(0, 3));
    return ok(null);
  }
  // The schema is deliberately looser than `Brief` on the nested arrays (it
  // validates shape, not every field of an engine's own output), so the cast
  // goes through `unknown`: what came back parsed, and the builder is the only
  // thing that writes here.
  return ok({ id: data.id, brief: parsed.data as unknown as Brief, deliveredAt: data.delivered_at });
}

/**
 * Mark a brief delivered, once.
 *
 * The compare-and-set on `delivered_at is null` is what stops a family being
 * told twice: two crons racing both see the row, one wins the update, and the
 * loser gets `false` and sends nothing.
 */
export async function markDelivered(
  scope: ServiceScope,
  briefId: string,
  opts?: { db?: DB; now?: Date },
): Promise<ServiceResult<boolean>> {
  // Server-written for the same reason as `saveBrief`: this stamp is what makes
  // "tell the family" happen exactly once.
  const db = opts?.db ?? await serverWriter(scope.db);
  const { data, error } = await db
    .from('home_briefs')
    .update({ delivered_at: (opts?.now ?? scope.now ?? new Date()).toISOString() })
    .eq('id', briefId)
    .eq('family_id', scope.familyId)
    .is('delivered_at', null)
    .select('id');
  if (error) {
    console.error('[briefing] could not mark the brief delivered', error);
    return fail(describeDbError(error, 'Bubaly could not record that delivery.'), { code: SERVICE_CODES.db, retryable: true });
  }
  return ok((data ?? []).length > 0);
}

// One Guardian learning run per family at a time.
//
// runLearningForFamily dedupes by READING the family's suggestion history and
// then INSERTING each draft whose key it did not find, and guardian_suggestions
// has no unique key to refuse a second writer (01370 adds only a plain index).
// Two runs for one family inside that read-to-insert span both insert: the
// nightly cron and the dispatcher's mirrored 02:00 tick, two managers pressing
// "Scan for tips", or one pressing it during the sweep. The partial unique
// index on the pending dedupe key is the owner's migration; until it lands,
// the run that holds this lease (lib/server/app-settings-lease.ts) is the only
// one that learns for the family, and it stays correct after.
//
// Every writer of a learning suggestion takes it: the cron with its own
// service client, the manager's action with a service client (app_settings is
// service-role only), and the inbound-SMS path (lib/guardian/sms-processing.ts)
// for its "add to contacts?" suggestion, the same trust:<phone>:known_contact
// key the run drafts.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { claimLease, releaseLease } from '@/lib/server/app-settings-lease';
import type { LearningRunResult } from './learning-run';

/** Far longer than a run's four reads and its inserts; a holder that died frees it after this. */
const LEARNING_LEASE_TTL_MS = 60_000;

export const learningLeaseKey = (familyId: string) => `guardian-learning:${familyId}`;

export type LeasedLearning<T = LearningRunResult> =
  | { ran: true; result: T }
  /** `held`: another run is learning for this family now. `error`: the lease could not be read or written. */
  | { ran: false; reason: 'held' | 'error' };

export async function runUnderLearningLease<T = LearningRunResult>(
  db: SupabaseClient<Database>,
  familyId: string,
  run: () => Promise<T>,
): Promise<LeasedLearning<T>> {
  const key = learningLeaseKey(familyId);
  const lease = await claimLease(db, key, { ttlMs: LEARNING_LEASE_TTL_MS });
  if (!lease.claimed) return { ran: false, reason: lease.reason };
  try {
    return { ran: true, result: await run() };
  } finally {
    await releaseLease(db, key, lease.token);
  }
}

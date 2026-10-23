// One generator per family at a time.
//
// `generateFamilyNotifications` (lib/server/notifications.ts) dedupes by reading
// the family's existing notifications and then inserting the batch that is not
// there yet; `public.notifications` has no unique key to refuse a second writer.
// Two generators inside one family's read→insert window — the notifications
// cron and the push scan on mirrored schedules, or a member's Scan button while
// a cron is on their family — therefore insert every "who needs to know" row
// twice, and each copy is then pushed and emailed. The database key (a partial
// unique index with an ignore-duplicates insert) is the owner's migration; this
// lease is what keeps the two writers apart until it lands, and stays correct
// after.
//
// The lease is per family, in app_settings, held for a minute from the claim
// and released when the generator finishes: a family's generation is a dozen
// round trips, and a crashed holder costs the next generator one skipped pass,
// never a lost notification — the next tick generates the same rows. A caller
// that finds the lease held skips generation for that family and says so; one
// that cannot read or write the lease treats the family as failed, because "I
// could not tell" is not "nobody else is writing".
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { claimLease, releaseLease } from './app-settings-lease';

type DB = SupabaseClient<Database>;

/** How long one generator's claim on a family stands without a release. */
export const NOTIFICATION_GENERATION_LEASE_MS = 60_000;

export function generationLeaseKey(familyId: string): string {
  return `notification_generation_lease:v1:family:${familyId}`;
}

export type GenerationLease =
  | { state: 'claimed'; release: () => Promise<void> }
  | { state: 'held' }
  | { state: 'error' };

/** Claim the right to generate `familyId`'s notifications until released or expired. */
export async function claimGenerationLease(db: DB, familyId: string, now?: Date): Promise<GenerationLease> {
  const key = generationLeaseKey(familyId);
  const lease = await claimLease(db, key, { ttlMs: NOTIFICATION_GENERATION_LEASE_MS, now });
  if (!lease.claimed) return { state: lease.reason };
  return { state: 'claimed', release: () => releaseLease(db, key, lease.token) };
}

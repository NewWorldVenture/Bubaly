// lib/library/curator.ts
//
// Who put a feed or a media address in the family library, and whether that
// person is (still) one of the family's adults.
//
// Adding a feed or an audio address is a parent's or another adult's call
// (app/(app)/dashboard/library/actions.ts, refuseUnlessCurator): what it names
// is fetched by Bubaly's server and streamed to every member, a young child's
// included, from Bubaly's own origin and past any filter a parent set on the
// device for the publisher's host. The two actions were the only place that
// rule lived. RLS on library_feeds and library_items is `is_family_member`, so a
// child could insert or retarget a row over PostgREST, and the media proxy,
// Refresh and the nightly cron honoured whatever row they found.
//
// So the places that FETCH ask here too. This reads `created_by` and is only as
// strong as that column, which RLS does not pin to the writer: a member can
// still name a parent in it, leave a feed's empty, file an episode under an
// adult's feed, or change the media_url of an adult's book in place, and every
// one of those is fetched. The durable rule is a database trigger on
// library_items (media_url, feed_id, created_by) and library_feeds (feed_url,
// created_by), an owner migration: the held 0526 (supabase/reserved/).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { MANAGER_ROLES } from '@/lib/constants/roles';

type Client = SupabaseClient<Database>;

export type CuratorRead = { ok: true; curators: Set<string> } | { ok: false; error: unknown };

/** The key `readCurators` answers in: this user, in this family. */
export const curatorKey = (familyId: string, userId: string | null | undefined): string => `${familyId}:${userId ?? ''}`;

/**
 * Whether a row `addedBy` wrote may be fetched for `familyId`: its writer is one
 * of that family's active parents or adults. An EMPTY `created_by` is let
 * through, deliberately: 0284 sets it null when the subscriber's account is
 * deleted, and a feed whose subscriber has gone keeps gaining its episodes
 * (tests/the-family-library-keeps-every-book-and-asks-a-grown-up.test.ts, S20).
 * A book typed in by hand has no such reason, and the media route refuses one
 * that names nobody before it asks here. A row naming a member who is not an
 * adult is not fetched.
 */
export function addedByAnAdult(read: { curators: Set<string> }, familyId: string, addedBy: string | null | undefined): boolean {
  return !addedBy || read.curators.has(curatorKey(familyId, addedBy));
}

/**
 * Which of `userIds` are active parents or adults of which of `familyIds`, as
 * `curatorKey`s. A failed read is an error, never an empty set: the callers
 * refuse on it rather than fetch on a guess.
 */
export async function readCurators(db: Client, familyIds: readonly string[], userIds: readonly (string | null)[]): Promise<CuratorRead> {
  const families = [...new Set(familyIds.filter(Boolean))];
  const users = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (families.length === 0 || users.length === 0) return { ok: true, curators: new Set() };
  try {
    const { data, error } = await db.from('family_members')
      .select('family_id, user_id')
      .in('family_id', families)
      .in('user_id', users)
      .in('role', MANAGER_ROLES)
      .eq('is_active', true);
    if (error) return { ok: false, error };
    return { ok: true, curators: new Set((data ?? []).map((m) => curatorKey(m.family_id, m.user_id))) };
  } catch (error) {
    return { ok: false, error };
  }
}

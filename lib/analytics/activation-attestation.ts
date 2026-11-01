import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { readAllByIdAsQuery } from '@/lib/supabase/read-all';

type Db = SupabaseClient<Database>;

/** The columns that say who recorded an activation milestone, and for which household. */
export type AttributedActivation = { user_id: string | null; family_id: string | null; session_id: string };

const FAMILY_CHUNK = 100;

/**
 * Only the activation rows a member of the household recorded about it.
 *
 * `activation_events_insert` (0146) accepts `user_id is null` from anyone
 * holding the public anon key, names no family check and lets the caller
 * choose `session_id`, `family_id` and `created_at`. Every real writer — the
 * Outcomes and Briefing beacons and `recordActivationServer` — stamps the
 * signed-in user, the active family, and `session_id = family_id`. So a row
 * counts only when it carries a user, names a family, keys its cohort by that
 * family, and that user has (or had) a membership row in it: an anonymous
 * plant, a made-up cohort and a row naming a household the writer never
 * belonged to are all dropped. What remains forgeable — a member backdating
 * their own household's row — needs the insert policy the owner holds.
 *
 * A failed membership read fails the whole read; the callers render
 * "unavailable" rather than numbers built on rows nobody could vouch for.
 */
export async function keepAttestedActivations<T extends AttributedActivation>(
  db: Db, rows: T[],
): Promise<{ data: T[]; error: null } | { data: null; error: unknown }> {
  const candidates = rows.filter((row) => row.user_id && row.family_id && row.session_id === row.family_id);
  const familyIds = [...new Set(candidates.map((row) => row.family_id as string))].sort();
  const members = new Set<string>();
  for (let start = 0; start < familyIds.length; start += FAMILY_CHUNK) {
    const chunk = familyIds.slice(start, start + FAMILY_CHUNK);
    const read = await readAllByIdAsQuery<{ id: string; family_id: string; user_id: string | null }>((after, limit) => {
      let query = db.from('family_members').select('id, family_id, user_id')
        .in('family_id', chunk).not('user_id', 'is', null);
      if (after) query = query.gt('id', after);
      return query.order('id').limit(limit);
    });
    if (read.error || !read.data) return { data: null, error: read.error ?? new Error('Activation membership read was unavailable') };
    for (const member of read.data) if (member.user_id) members.add(`${member.family_id}:${member.user_id}`);
  }
  return { data: candidates.filter((row) => members.has(`${row.family_id}:${row.user_id}`)), error: null };
}

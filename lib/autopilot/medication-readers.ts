import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

export { medicationReaderIds } from '@/lib/medications/readers';

export type RosterMember = { id: string; role: string };

/**
 * The family's active members and their roles, or null when they could not be
 * read. A refill notice that names the drug goes only to the medication's
 * readers (lib/medications/readers.ts); a caller that cannot tell who they
 * are tells the managers only, never the whole family.
 */
export async function activeRoster(db: SupabaseClient<Database>, familyId: string): Promise<RosterMember[] | null> {
  const { data, error } = await db.from('family_members').select('id, role').eq('family_id', familyId).eq('is_active', true);
  if (error) {
    console.error('[autopilot] member read for a private refill failed', { familyId, error });
    return null;
  }
  return (data ?? []) as RosterMember[];
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

/** Withdraw without erasing the evidence. An archive key releases the live
 * dedupe slot so a recurring signal can be offered again, as it could before
 * withdrawal used retention instead of deletion. Human-resolved rows keep
 * their original keys and are never reopened by a scan. */
export async function archiveStaleSuggestions(
  sb: SupabaseClient<Database>, familyId: string,
  rows: readonly { id: string; dedupe_key: string }[], now: Date,
): Promise<number> {
  let archived = 0;
  for (let offset = 0; offset < rows.length; offset += 20) {
    const counts = await Promise.all(rows.slice(offset, offset + 20).map(async (row) => {
      const { data, error } = await sb.from('autopilot_suggestions').update({
        status: 'snoozed', expires_at: now.toISOString(),
        dedupe_key: `archived:${row.id}:${row.dedupe_key}`,
      }).eq('family_id', familyId).eq('id', row.id).eq('status', 'open').select('id');
      if (error) {
        console.error('[autopilot] history archive write failed', error);
        throw new Error('Autopilot could not archive stale suggestions');
      }
      return data?.length ?? 0;
    }));
    archived += counts.reduce((sum, count) => sum + count, 0);
  }
  return archived;
}

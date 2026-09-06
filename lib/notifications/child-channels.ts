// lib/notifications/child-channels.ts — "how Bubaly may reach a child directly".
//
// `family_ai_settings.child_channels` is `{"push": true, "email": false}` per
// 0257. It was stored and read into `AISettings.childChannels` and then consulted
// by NOTHING: five references in the whole repo, not one of them a decision. A
// family that switched a channel off was told nothing and silenced nothing.
//
// This is enforced at DELIVERY rather than in `notify()` on purpose. The setting
// says how Bubaly may REACH a child, not what a child may be told: turning push
// off should stop the phone buzzing, not erase the notice from the in-app list
// the child opens themselves.
//
// Scope is the `child` role, which is what 0257 says ("reach a CHILD directly").
// Teens are not covered — they hold their own logins and are not what a parent is
// limiting here. Widening it to teens would be a product decision, not a reading
// of the contract.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type DB = SupabaseClient<Database>;
export type DeliveryChannel = 'push' | 'email';

/**
 * Of `userIds`, those Bubaly may NOT reach on `channel` because they are a child
 * in a family that switched that channel off.
 *
 * Absent means allowed. The column defaults to `{}` and only an explicit `false`
 * is a decision — the same rule `settingsFromRow` applies to `enabled`. A family
 * that never opened the setting must not have its children silenced by it.
 *
 * A failed read returns an EMPTY set: delivery continues. This governs which
 * channel a notice takes, not whether a child may be told something, so failing
 * closed would silently drop notifications on a transient database error. The
 * quiet-hours window and the trust gate are the boundaries that fail closed.
 */
export async function childrenBlockedOn(
  supabase: DB,
  channel: DeliveryChannel,
  userIds: string[],
): Promise<Set<string>> {
  const blocked = new Set<string>();
  const wanted = [...new Set(userIds.filter(Boolean))];
  if (wanted.length === 0) return blocked;

  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('user_id, family_id')
    .in('user_id', wanted)
    .eq('role', 'child')
    .eq('is_active', true);
  if (membersError) {
    console.error('[child-channels] member read failed', { channel, error: membersError });
    return blocked;
  }
  if (!members?.length) return blocked;

  const familyIds = [...new Set(members.map((m) => m.family_id))];
  const { data: settings, error: settingsError } = await supabase
    .from('family_ai_settings')
    .select('family_id, child_channels')
    .in('family_id', familyIds);
  if (settingsError) {
    console.error('[child-channels] settings read failed', { channel, error: settingsError });
    return blocked;
  }

  const off = new Set<string>();
  for (const row of settings ?? []) {
    const map = row.child_channels;
    if (map && typeof map === 'object' && !Array.isArray(map)
      && (map as Record<string, unknown>)[channel] === false) {
      off.add(row.family_id);
    }
  }
  if (off.size === 0) return blocked;

  for (const m of members) {
    if (m.user_id && off.has(m.family_id)) blocked.add(m.user_id);
  }
  return blocked;
}

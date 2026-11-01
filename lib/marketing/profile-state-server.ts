import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { profileStateFromRow, type ProfileRow, type ProfileState } from '@/lib/marketing/progressive-profile';

type Admin = SupabaseClient<Database>;

/**
 * The profile nudge's state for the settings page to render with, READ ONLY
 * (PERF-001). The nudge used to ask getProfileStateAction once the page had
 * loaded, and its card arriving moved everything below it down: layout shift
 * 0.13 on /dashboard/settings.
 *
 * The page cannot call that action. It resolves the contact, and when the
 * user has none it claims a lead by email or creates one: writes a page GET,
 * or a prefetch of one, must not make. This reads only what the user already
 * owns, their contact by owner_id and its profile, and answers null when they
 * own none yet or a read does not answer. The nudge then asks the action from
 * the browser, as it always has.
 */
export async function readOwnedProfileState(admin: Admin, userId: string): Promise<ProfileState | null> {
  try {
    const owned = await admin.from('crm_contacts').select('id').eq('owner_id', userId).limit(1);
    const contactId = !owned.error && Array.isArray(owned.data) ? owned.data[0]?.id : undefined;
    if (!contactId) return null;
    const profile = await admin.from('crm_contact_profile')
      .select('role, top_priority, household_size, child_ages, interests, extra')
      .eq('contact_id', contactId).limit(1);
    if (profile.error || !Array.isArray(profile.data)) return null;
    return profileStateFromRow(profile.data[0] as ProfileRow | undefined);
  } catch {
    return null;
  }
}

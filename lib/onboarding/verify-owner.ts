import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { onboardingOwnerSchema, type OnboardingOwner } from './owner';

/** Check before any onboarding write, using freshly authenticated server data. */
export async function verifyOnboardingOwner(db: SupabaseClient<Database>, userId: string, expected?: OnboardingOwner): Promise<boolean> {
  if (expected === undefined) return true; // Existing non-wizard callers keep their established action contract.
  const parsed = onboardingOwnerSchema.safeParse(expected);
  if (!parsed.success || parsed.data.userId !== userId) return false;
  const [members, preferences] = await Promise.all([
    db.from('family_members').select('family_id, role').eq('user_id', userId).eq('is_active', true),
    db.from('user_preferences').select('active_family_id').eq('user_id', userId).maybeSingle(),
  ]);
  if (members.error || !members.data || preferences.error) return false;
  const activeId = preferences.data?.active_family_id ?? null;
  if (members.data.length === 0) return parsed.data.familyId === null && activeId === null;
  // A pending first-family setup has one owned parent membership. Never adopt
  // an invited household or an ambiguous active-family fallback from an old tab.
  if (members.data.length !== 1 || members.data[0].role !== 'parent' || members.data[0].family_id !== activeId) return false;
  if (parsed.data.familyId !== null) return parsed.data.familyId === activeId;
  // A partial Finish or explicit Connect may have claimed this same user's
  // family since the initial no-family render. Its existing wizard marker and
  // creator identity make that retry safe without changing the business keys.
  const [progress, family] = await Promise.all([
    db.from('onboarding_progress').select('family_id, source').eq('user_id', userId).maybeSingle(),
    db.from('families').select('created_by').eq('id', activeId!).maybeSingle(),
  ]);
  return !progress.error && !family.error && family.data?.created_by === userId &&
    progress.data?.family_id === activeId && ['wizard', 'auto_provision'].includes(progress.data.source);
}

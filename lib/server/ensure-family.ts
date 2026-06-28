import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

// Guarantees an authenticated user always has a family space, so onboarding can
// never trap them in a redirect loop (sign up → land on the dashboard with an
// "Invite your family" card — the lightweight journey). Uses only core tables
// (families/family_members/user_preferences from migrations 0002–0003, in prod):
// inserting a `families` row fires the `handle_new_family` trigger, which creates
// the owner's active `parent` member + a trial subscription. Idempotent.

type AuthUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

function deriveName(user: AuthUser, profileName?: string | null): string {
  const meta = (user.user_metadata?.full_name ?? user.user_metadata?.name) as string | undefined;
  return (profileName?.trim() || meta?.trim() || user.email?.split('@')[0] || 'My').trim();
}

/**
 * Ensure the user has an active family membership. Returns true when one exists
 * (already, or freshly provisioned), false only if provisioning genuinely failed
 * (caller can then fall back to the manual onboarding wizard).
 */
export async function ensureActiveFamily(
  supabase: SupabaseClient,
  user: AuthUser,
): Promise<boolean> {
  // Already in a family? Nothing to do.
  const { data: existing } = await supabase
    .from('family_members')
    .select('family_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .limit(1);
  if (existing && existing.length > 0) return true;

  const { data: profile } = await supabase
    .from('profiles')
    .select('display_name, full_name')
    .eq('id', user.id)
    .maybeSingle();
  const ownerName = deriveName(user, profile?.display_name ?? profile?.full_name ?? null);
  const familyName = ownerName.endsWith('s') ? `${ownerName}' Family` : `${ownerName}'s Family`;

  // Insert the family — the handle_new_family trigger creates the active parent
  // member + trial subscription (SECURITY DEFINER, so RLS doesn't block it).
  const { data: family, error } = await supabase
    .from('families')
    .insert({ name: familyName, timezone: 'UTC', created_by: user.id })
    .select('id')
    .single();
  if (error || !family) return false;

  // Make it the active family.
  await supabase.from('user_preferences').upsert(
    { user_id: user.id, active_family_id: family.id },
    { onConflict: 'user_id' },
  );

  // The trigger names the member from profiles.full_name (or 'Parent'); make sure
  // it shows the user's real name even when the profile row isn't populated yet.
  try {
    await supabase
      .from('family_members')
      .update({ display_name: ownerName })
      .eq('family_id', family.id)
      .eq('user_id', user.id)
      .or('display_name.is.null,display_name.eq.Parent');
  } catch { /* best-effort cosmetic */ }

  // Confirm membership is now visible (the trigger ran in the same transaction).
  const { data: confirm } = await supabase
    .from('family_members')
    .select('family_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .limit(1);
  return Boolean(confirm && confirm.length > 0);
}

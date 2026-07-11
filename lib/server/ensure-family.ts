import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createServiceClient } from '@/lib/supabase/server';

// Guarantees an authenticated user always has a family space, so onboarding can
// never trap them in a redirect loop (sign up → land on the dashboard with an
// "Invite your family" card — the lightweight journey). Uses only core tables
// (families/family_members/user_preferences from migrations 0002–0003, in prod):
// inserts the `families` row, then EXPLICITLY creates the owner's active `parent`
// member + a trial subscription (not relying on the `handle_new_family` trigger,
// which isn't guaranteed active in every environment). Idempotent.
//
// IMPORTANT: provisioning runs through the SERVICE-ROLE client, not the caller's
// RLS-scoped client. The family-scoped RLS helper `is_family_member()` is STABLE,
// so it reads the statement's start-of-statement snapshot. When the user client
// does `insert(families).select()`, the RETURNING row is filtered by the
// `families_select` policy (`is_family_member(id)`) — but the membership the
// AFTER-INSERT trigger just created isn't visible to that STABLE snapshot yet, so
// RETURNING comes back empty and the insert "fails" with no row. Provisioning is a
// trusted server operation for an already-authenticated user, so we bypass RLS to
// sidestep that read-back race entirely. Identity is verified by the caller (the
// user.id is taken from a validated `auth.getUser()`).

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
 * (caller can then fall back to the manual onboarding wizard). The real cause of
 * any failure is logged server-side under the `[ensure-family]` tag.
 *
 * The `supabase` argument is accepted for API symmetry with the call sites (and
 * so the "already a member?" check can run as the user) but all writes use the
 * service-role client — see the note above.
 */
export async function ensureActiveFamily(
  _supabase: SupabaseClient,
  user: AuthUser,
): Promise<boolean> {
  const admin = createServiceClient();

  // Already in a family? Nothing to do. (Service client → never hidden by RLS.)
  const { data: existing, error: existErr } = await admin
    .from('family_members')
    .select('family_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .limit(1);
  if (existErr) {
    console.error('[ensure-family] membership lookup failed', existErr);
    return false;
  }
  if (existing && existing.length > 0) return true;

  const { data: profile } = await admin
    .from('profiles')
    .select('display_name, full_name')
    .eq('id', user.id)
    .maybeSingle();
  const ownerName = deriveName(user, profile?.display_name ?? profile?.full_name ?? null);
  const familyName = ownerName.endsWith('s') ? `${ownerName}' Family` : `${ownerName}'s Family`;

  // Insert the family. Bypassing RLS means the RETURNING row isn't filtered, so
  // we reliably get the new family id back.
  const { data: family, error } = await admin
    .from('families')
    .insert({ name: familyName, timezone: 'UTC', created_by: user.id })
    .select('id')
    .single();
  if (error || !family) {
    console.error('[ensure-family] family insert failed', error);
    return false;
  }

  // Explicitly create the owner's parent membership — do NOT rely on the
  // `handle_new_family` trigger, which isn't guaranteed to be installed/active in
  // every environment. (Both the original onboarding loop and the "couldn't
  // finish setting up your space" error came from trusting that trigger; the
  // working createFamily path always inserted the member itself.) Upsert is
  // idempotent, so if the trigger DID fire we just reconcile name/role instead
  // of duplicating.
  const { error: memberErr } = await admin.from('family_members').upsert(
    { family_id: family.id, user_id: user.id, role: 'parent', display_name: ownerName, is_active: true },
    { onConflict: 'family_id,user_id' },
  );
  if (memberErr) {
    console.error('[ensure-family] parent member upsert failed', memberErr);
    return false;
  }

  // Ensure a trial subscription exists (the trigger may have created one; only
  // insert when missing so we never duplicate). Non-fatal.
  const { data: existingSub } = await admin
    .from('subscriptions').select('id').eq('family_id', family.id).limit(1);
  if (!existingSub || existingSub.length === 0) {
    const { error: subErr } = await admin.from('subscriptions').insert({
      family_id: family.id, plan: 'free', status: 'trialing',
      current_period_end: new Date(Date.now() + 14 * 86400000).toISOString(),
    });
    if (subErr) console.error('[ensure-family] trial subscription insert failed', subErr);
  }

  // Make it the active family.
  const { error: prefErr } = await admin.from('user_preferences').upsert(
    { user_id: user.id, active_family_id: family.id },
    { onConflict: 'user_id' },
  );
  if (prefErr) console.error('[ensure-family] active family upsert failed', prefErr);

  // Confirm the membership is in place before we report success.
  const { data: confirm, error: confirmErr } = await admin
    .from('family_members')
    .select('family_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .limit(1);
  if (confirmErr) {
    console.error('[ensure-family] membership confirm failed', confirmErr);
    return false;
  }
  if (!confirm || confirm.length === 0) {
    console.error('[ensure-family] membership missing after provisioning family', family.id);
    return false;
  }

  // Mark this account as the "needs setup" cohort: it got a space WITHOUT going
  // through the guided wizard, so it has no questionnaire/goals/marketing profile.
  // The onboarding_progress row (migration 0159) makes that visible so the app can
  // nudge them to finish and marketing can segment them. Best-effort, never blocks
  // — and never DOWNGRADES a completed record (only creates when absent).
  try {
    const { data: prior } = await admin
      .from('onboarding_progress').select('user_id').eq('user_id', user.id).maybeSingle();
    if (!prior) {
      await admin.from('onboarding_progress').insert({
        user_id: user.id, family_id: family.id, source: 'auto_provision',
        status: 'in_progress', steps_completed: ['profile'], completeness: 40,
      } as never);
    }
  } catch { /* table may be pre-migration — degrade silently */ }

  return true;
}

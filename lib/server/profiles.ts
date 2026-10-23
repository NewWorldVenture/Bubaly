import 'server-only';
import { createServiceClient } from '@/lib/supabase/server';
import { joinName, normalizePhone } from '@/lib/onboarding/profile';
import { describeActionError } from '@/lib/supabase/errors';
import { AVATAR_BUCKET, avatarObjectPathFor } from '@/lib/storage/avatars';
import { removeConfirmed } from '@/lib/storage/confirm-removal';

/**
 * Writes the signed-in user's own profile (name + phone, optionally email) and
 * keeps their family_members display name in sync.
 *
 * Why the service-role client: `profiles` rows are created by the
 * `handle_new_user` SECURITY DEFINER trigger, so an app-level upsert is the
 * first RLS-scoped write to that table — and an `INSERT ... ON CONFLICT` upsert
 * evaluates the INSERT `WITH CHECK (id = auth.uid())` policy, which was tripping
 * "new row violates row-level security policy" in production. We authenticate
 * the caller on the cookie-bound client first (see callers), then perform the
 * write with the service role scoped strictly to that authenticated `userId`,
 * so RLS is bypassed safely without ever trusting client-supplied identity.
 */
export async function saveUserProfile(
  userId: string,
  input: { firstName: string; lastName: string; phone: string; email?: string | null; avatarUrl?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient();

  const row: {
    id: string; full_name: string; display_name: string; phone: string; email?: string; avatar_url?: string | null;
  } = {
    id: userId,
    full_name: joinName(input.firstName, input.lastName),
    display_name: input.firstName.trim(),
    phone: normalizePhone(input.phone),
  };
  if (input.email) row.email = input.email;
  if (input.avatarUrl !== undefined) row.avatar_url = input.avatarUrl || null;

  // The photo being replaced or removed, read before it is overwritten. The
  // picker uploads every avatar as a NEW object in the public `avatars` bucket
  // and "Remove" only blanks the field, so each superseded face photo stayed
  // fetchable by anyone who ever held its URL (rendered app-wide, so cached
  // and logged) for ever. A failed read leaves the old object where it is and
  // is logged; the profile write below still stands.
  let previousAvatar: string | null = null;
  if (input.avatarUrl !== undefined) {
    const { data: current, error: readError } = await svc.from('profiles').select('avatar_url').eq('id', userId).maybeSingle();
    if (readError) console.error('[profile-action] previous avatar read failed; the old photo stays in the bucket', readError);
    else previousAvatar = current?.avatar_url ?? null;
  }

  const { error } = await svc.from('profiles').upsert(row, { onConflict: 'id' });
  if (error) {
    console.error('[profile-action] profile update failed', error);
    return { ok: false, error: describeActionError(error, 'Could not update your profile.') };
  }

  // The row no longer names the old photo, so it leaves the bucket — only when
  // it is this user's own object (avatarObjectPathFor refuses any other folder
  // or an external URL), and only confirmed gone (removeConfirmed). A removal
  // that fails is logged with its path and the profile write stands: the
  // family's change is saved either way.
  if (input.avatarUrl !== undefined && previousAvatar && previousAvatar !== (input.avatarUrl || null)) {
    const path = avatarObjectPathFor(userId, previousAvatar);
    if (path) {
      const removed = await removeConfirmed(svc.storage.from(AVATAR_BUCKET), path);
      if (removed.error) console.error('[profile-action] the previous avatar was not removed from the bucket', { path, error: removed.error });
    }
  }

  // Keep the user's family display name(s) in sync with their first name.
  // Rows deliberately not checked: someone who has not joined a family yet has
  // no membership rows, and zero is the right answer for them. Audit C1-S9-68.
  const { error: memberError } = await svc
    .from('family_members')
    .update({ display_name: input.firstName.trim() })
    .eq('user_id', userId);
  if (memberError) {
    console.error('[profile-action] family display name sync failed', memberError);
    return { ok: false, error: describeActionError(memberError, 'Could not update your family profile.') };
  }

  return { ok: true };
}

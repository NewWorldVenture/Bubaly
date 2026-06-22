import 'server-only';
import { createServiceClient } from '@/lib/supabase/server';
import { joinName, normalizePhone } from '@/lib/onboarding/profile';

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
  input: { firstName: string; lastName: string; phone: string; email?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const svc = createServiceClient();

  const row: {
    id: string; full_name: string; display_name: string; phone: string; email?: string;
  } = {
    id: userId,
    full_name: joinName(input.firstName, input.lastName),
    display_name: input.firstName.trim(),
    phone: normalizePhone(input.phone),
  };
  if (input.email) row.email = input.email;

  const { error } = await svc.from('profiles').upsert(row, { onConflict: 'id' });
  if (error) return { ok: false, error: error.message };

  // Keep the user's family display name(s) in sync with their first name.
  await svc.from('family_members').update({ display_name: input.firstName.trim() }).eq('user_id', userId);

  return { ok: true };
}

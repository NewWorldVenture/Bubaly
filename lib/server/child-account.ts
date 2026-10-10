import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

/**
 * Whether this auth user is a parent-issued child login (username + PIN).
 *
 * Such an account exists only as a member of the family that created it. When
 * that family removes the member (a soft `is_active = false`), the account has
 * no family — and every "no family yet" path (ensureActiveFamily, onboarding's
 * family claim) used to give it a brand-new household with the child as its
 * PARENT, outside every parental control. Those paths ask this first.
 *
 * Fails CLOSED: a lookup that cannot be answered counts as a child account, so
 * the cost of an outage is a delayed provision, never an unsupervised admin.
 */
export async function isChildLoginAccount(
  admin: SupabaseClient<Database>,
  user: { id: string; user_metadata?: Record<string, unknown> | null },
): Promise<boolean> {
  if (user.user_metadata?.child === true) return true;
  const { data, error } = await admin.from('child_logins').select('id').eq('user_id', user.id).limit(1);
  if (error) {
    console.error('[child-account] child login lookup failed; treating as a child account', error);
    return true;
  }
  return (data?.length ?? 0) > 0;
}

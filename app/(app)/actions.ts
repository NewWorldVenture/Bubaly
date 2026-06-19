'use server';

import { revalidatePath } from 'next/cache';
import { createServer } from '@/lib/supabase/server';

/** Switches the user's active family (used by the family switcher). */
export async function setActiveFamilyAction(familyId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createServer();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return { ok: false, error: 'Not signed in' };

  // Verify membership before switching (defense in depth; RLS also guards reads).
  const { data: member } = await supabase
    .from('family_members')
    .select('id')
    .eq('family_id', familyId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!member) return { ok: false, error: 'Not a member of that family' };

  await supabase
    .from('user_preferences')
    .upsert({ user_id: auth.user.id, active_family_id: familyId }, { onConflict: 'user_id' });

  revalidatePath('/dashboard', 'layout');
  return { ok: true };
}

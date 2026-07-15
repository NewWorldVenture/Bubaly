'use server';

import { revalidatePath } from 'next/cache';
import { createServiceClient } from '@/lib/supabase/server';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };

// Mark admin notifications read from the global admin bell. Super-admin only;
// service role (admin_notifications has no client policy). Revalidates the admin
// layout so the badge updates.
export async function markAdminNotesReadAction(ids?: string[]): Promise<Result> {
  if (!(await isSuperAdmin())) return { ok: false, error: 'Not authorized.' };
  const supabase = createServiceClient();
  let q = supabase.from('admin_notifications').update({ is_read: true });
  q = ids && ids.length ? q.in('id', ids) : q.eq('is_read', false);
  const { error } = await q;
  if (error) return { ok: false, error: describeActionError(error, 'Could not update notifications.') };
  revalidatePath('/admin', 'layout');
  return { ok: true };
}

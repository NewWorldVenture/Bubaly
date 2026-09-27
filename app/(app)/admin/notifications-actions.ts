'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: true } | { ok: false; error: string };

// Mark admin notifications read from the global admin bell. Super-admin only;
// service role (admin_notifications has no client policy). Revalidates the admin
// layout so the badge updates.
export async function markAdminNotesReadAction(ids?: string[]): Promise<Result> {
  const t = await getTranslations();
  if (!(await isSuperAdmin())) return { ok: false, error: t('notificationsActions.notAuthorized') };
  const supabase = createServiceClient();
  // Deliberately NOT confirmed. Without ids this is `.eq('is_read', false)`,
  // where zero rows is the ordinary "nothing unread"; with ids, zero rows means
  // they no longer exist, and there is nothing left to mark. Either way the
  // badge is re-read by the revalidation below, so it cannot go on showing a
  // count that is not there. Built across three statements, which is why the
  // ratchet could not see it until C1-S9-61. Audit C1-S9-61.
  let q = supabase.from('admin_notifications').update({ is_read: true });
  q = ids && ids.length ? q.in('id', ids) : q.eq('is_read', false);
  const { error } = await q;
  if (error) return { ok: false, error: describeActionError(error, t('notificationsActions.couldNotUpdateNotifications')) };
  revalidatePath('/admin', 'layout');
  return { ok: true };
}

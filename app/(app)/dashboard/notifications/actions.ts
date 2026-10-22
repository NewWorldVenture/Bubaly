'use server';

import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { DISMISSED_SEND_AT } from '@/lib/notifications/dismissed';

/**
 * Dismiss one notification from the caller's list.
 *
 * The bin used to DELETE the row, and the generator — whose only memory of
 * what it already said is this table — re-created it on the next cron, Scan
 * or push-scan, then pushed and emailed it again, every day until the item
 * left its window. The row is now kept, marked read, settled for push and
 * email, and parked out of every surface (lib/notifications/dismissed.ts), so
 * the dedupe still finds it.
 *
 * Who may dismiss is who could delete (notif_delete): the recipient, or a
 * manager for a family-wide row. The row is read through the caller's own
 * session, so it is one they can see; the write is the service role's, because
 * a member's grant on this table is `is_read` alone (0301).
 */
export async function dismissNotificationAction(input: { id: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = await getTranslations();
  const notSaved = { ok: false as const, error: t('errors.thatChangeWasNotSaved') };
  if (typeof input?.id !== 'string' || !input.id || input.id.length > 80) return notSaved;
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;

  const supabase = await createServer();
  const { data: row, error: readError } = await supabase.from('notifications')
    .select('id, user_id, sent_at, pushed_at').eq('id', input.id).eq('family_id', familyId).maybeSingle();
  if (readError) return { ok: false, error: describeActionError(readError, t('errors.thatChangeWasNotSaved')) };
  if (!row) return notSaved;
  const mayDismiss = row.user_id === ctx.user.id || (row.user_id === null && isManager(ctx.active.role));
  if (!mayDismiss) return notSaved;

  const nowIso = new Date().toISOString();
  // `send_at` is outside the typed client patch (lib/database.types.ts lists
  // only what a member may change, is_read, plus the cron's stamps); the
  // service role may write it.
  const dismissal = { is_read: true, send_at: DISMISSED_SEND_AT, sent_at: row.sent_at ?? nowIso, pushed_at: row.pushed_at ?? nowIso };
  const { data: rows, error } = await createServiceClient().from('notifications')
    .update(dismissal as never)
    .eq('id', row.id).eq('family_id', familyId)
    .select('id');
  if (error) return { ok: false, error: describeActionError(error, t('errors.thatChangeWasNotSaved')) };
  if (wroteNoRows(rows)) return notSaved;
  return { ok: true };
}

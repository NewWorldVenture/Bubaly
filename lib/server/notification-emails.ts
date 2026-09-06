// Delivers pending Bubaly notifications as per-recipient email digests.
// Runs after the notification generator (same cron). Idempotent via the
// notifications.sent_at column: a row is emailed (or intentionally skipped)
// exactly once. No-ops cleanly when RESEND_API_KEY isn't configured.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { sendReactEmail, emailEnabled } from '@/lib/email';
import { NotificationDigestEmail } from '@/lib/emails/notification-digest';
import { iconForType, groupByUser } from '@/lib/notifications/digest';
import * as React from 'react';
import { childrenBlockedOn } from '@/lib/notifications/child-channels';

type DB = SupabaseClient<Database>;
export type NotificationEmailResult = { sent: number; failed: number; skipped: number };

const emptyResult = (): NotificationEmailResult => ({ sent: 0, failed: 0, skipped: 0 });

/**
 * Emails each member a digest of their unsent, user-targeted notifications that
 * are due (send_at <= now). Whole-family (null user_id) rows stay in-app only.
 * Database and provider failures remain visible so cron monitoring can retry.
 */
export async function deliverNotificationEmails(supabase: DB): Promise<NotificationEmailResult> {
  if (!emailEnabled()) return emptyResult();

  const nowIso = new Date().toISOString();
  const { data: pending, error: pendingError } = await supabase
    .from('notifications')
    .select('id, user_id, type, title, body')
    .is('sent_at', null)
    .not('user_id', 'is', null)
    .lte('send_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(500);
  if (pendingError) {
    console.error('[notification-email] pending notification read failed', pendingError);
    return { sent: 0, failed: 1, skipped: 0 };
  }

  if (!pending?.length) return emptyResult();

  const byUser = groupByUser(pending);
  const userIds = [...byUser.keys()];

  // Respect the per-user email toggle (default on).
  const { data: prefs, error: prefsError } = await supabase
    .from('user_preferences')
    .select('user_id, email_enabled')
    .in('user_id', userIds);
  if (prefsError) {
    console.error('[notification-email] preference read failed', prefsError);
    return { sent: 0, failed: 1, skipped: 0 };
  }
  const emailOff = new Set((prefs ?? []).filter((p) => !p.email_enabled).map((p) => p.user_id));

  // "How Bubaly may reach a child directly" (0257's `child_channels`) — stored,
  // and until now consulted by nothing. The per-user toggle above is the
  // RECIPIENT's own choice; this is the family's choice about its children, and
  // a child has no reason to hold the parent's setting on their own row.
  // Blocked recipients are resolved into `sent_at` below exactly like the
  // per-user toggle, so a withheld email is settled rather than retried forever.
  const childEmailOff = await childrenBlockedOn(supabase, 'email', userIds);
  for (const id of childEmailOff) emailOff.add(id);

  // Resolve recipient emails + names. Mirrors the weekly-digest cron's approach.
  const { data: authUsers, error: authUsersError } = await supabase.auth.admin.listUsers();
  if (authUsersError) {
    console.error('[notification-email] recipient lookup failed', authUsersError);
    return { sent: 0, failed: 1, skipped: 0 };
  }
  const userMeta = new Map(
    (authUsers?.users ?? []).map((u) => [
      u.id,
      {
        email: u.email ?? null,
        name: (u.user_metadata?.display_name as string | undefined)
          ?? (u.user_metadata?.full_name as string | undefined)
          ?? (u.email ? u.email.split('@')[0] : 'there'),
      },
    ]),
  );

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  const resolvedIds: string[] = []; // emailed OR intentionally skipped → mark sent_at

  for (const [userId, notifs] of byUser) {
    const ids = notifs.map((n) => n.id);
    const meta = userMeta.get(userId);

    // No email on file, or the member opted out → resolve without sending.
    if (emailOff.has(userId) || !meta?.email) {
      skipped += 1;
      resolvedIds.push(...ids);
      continue;
    }

    const items = notifs.map((n) => ({ title: n.title, body: n.body, icon: iconForType(n.type) }));
    const { ok } = await sendReactEmail({
      to: meta.email,
      subject: `${notifs.length} family update${notifs.length > 1 ? 's' : ''} · Bubaly`,
      react: React.createElement(NotificationDigestEmail, { name: meta.name, items }),
    });
    if (ok) {
      sent++;
      resolvedIds.push(...ids);
    } else {
      failed++;
    }
    // On send failure we leave sent_at null so the next run retries.
  }

  if (resolvedIds.length) {
    const { error: resolveError } = await supabase.from('notifications').update({ sent_at: nowIso }).in('id', resolvedIds);
    if (resolveError) {
      console.error('[notification-email] notification resolve update failed', resolveError);
      failed++;
    }
  }
  return { sent, failed, skipped };
}

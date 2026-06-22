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

type DB = SupabaseClient<Database>;

/**
 * Emails each member a digest of their unsent, user-targeted notifications that
 * are due (send_at <= now). Returns the number of emails sent. Whole-family
 * (null user_id) rows stay in-app only.
 */
export async function deliverNotificationEmails(supabase: DB): Promise<number> {
  if (!emailEnabled()) return 0;

  const nowIso = new Date().toISOString();
  const { data: pending } = await supabase
    .from('notifications')
    .select('id, user_id, type, title, body')
    .is('sent_at', null)
    .not('user_id', 'is', null)
    .lte('send_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(500);

  if (!pending?.length) return 0;

  const byUser = groupByUser(pending);
  const userIds = [...byUser.keys()];

  // Respect the per-user email toggle (default on).
  const { data: prefs } = await supabase
    .from('user_preferences')
    .select('user_id, email_enabled')
    .in('user_id', userIds);
  const emailOff = new Set((prefs ?? []).filter((p) => !p.email_enabled).map((p) => p.user_id));

  // Resolve recipient emails + names. Mirrors the weekly-digest cron's approach.
  const { data: authUsers } = await supabase.auth.admin.listUsers();
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
  const resolvedIds: string[] = []; // emailed OR intentionally skipped → mark sent_at

  for (const [userId, notifs] of byUser) {
    const ids = notifs.map((n) => n.id);
    const meta = userMeta.get(userId);

    // No email on file, or the member opted out → resolve without sending.
    if (emailOff.has(userId) || !meta?.email) {
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
    }
    // On send failure we leave sent_at null so the next run retries.
  }

  if (resolvedIds.length) {
    await supabase.from('notifications').update({ sent_at: nowIso }).in('id', resolvedIds);
  }
  return sent;
}

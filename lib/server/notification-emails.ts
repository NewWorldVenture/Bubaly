// Delivers pending Bubaly notifications as per-recipient email digests.
// Runs after the notification generator (same cron). sent_at records accepted
// or intentionally skipped rows; a stable digest key protects identical replay
// within the provider's retention window. Changed batches and expired keys can
// still duplicate delivery. No-ops when RESEND_API_KEY isn't configured.
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { sendReactEmail, emailEnabled } from '@/lib/email';
import { NotificationDigestEmail } from '@/lib/emails/notification-digest';
import { iconForType, groupByUser, digestTimeZone } from '@/lib/notifications/digest';
import * as React from 'react';
import { listAllAuthUsers } from './list-all-auth-users';
import { childrenBlockedOn } from '@/lib/notifications/child-channels';
import { readAllInChunks, readInChunks } from '@/lib/supabase/chunked-in';

type DB = SupabaseClient<Database>;
export type NotificationEmailResult = { sent: number; failed: number; skipped: number };

const emptyResult = (): NotificationEmailResult => ({ sent: 0, failed: 0, skipped: 0 });

function digestIdempotencyKey(userId: string, notificationIds: string[]): string {
  return `notification-digest/v1/${createHash('sha256')
    .update(JSON.stringify([userId, [...notificationIds].sort()]))
    .digest('hex')}`;
}

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
    .select('id, family_id, user_id, type, title, body')
    .is('sent_at', null)
    // Chat notices are in-app only; do not turn every message into an email.
    .or('related_type.is.null,related_type.neq.family_message')
    .not('user_id', 'is', null)
    .lte('send_at', nowIso)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(500);
  if (pendingError) {
    console.error('[notification-email] pending notification read failed', pendingError);
    return { sent: 0, failed: 1, skipped: 0 };
  }

  if (!pending?.length) return emptyResult();

  // A queued notification can outlive the recipient's membership. The service
  // client still knows their email, so authorize each family/user pair before
  // grouping content. Read every roster page before any send or acknowledgement.
  const queuedUserIds = [...new Set(pending.map((n) => n.user_id).filter((id): id is string => Boolean(id)))];
  const { data: members, error: membersError } = await readAllInChunks<{
    id: string; user_id: string | null; family_id: string;
  }>(queuedUserIds, (chunk, from, to) => supabase
    .from('family_members')
    .select('id, user_id, family_id')
    .in('user_id', chunk)
    .eq('is_active', true)
    .order('id')
    .range(from, to));
  if (membersError) {
    console.error('[notification-email] membership read failed', membersError);
    return { sent: 0, failed: 1, skipped: 0 };
  }
  const currentPairs = new Set((members ?? []).map((m) => `${m.family_id}:${m.user_id}`));
  const permitted = pending.filter((n) => currentPairs.has(`${n.family_id}:${n.user_id}`));
  const withheldIds = pending.filter((n) => !currentPairs.has(`${n.family_id}:${n.user_id}`)).map((n) => n.id);
  const byUser = groupByUser(permitted);

  // The digest's date line is the recipient's FAMILY's day. This runs from a
  // cron on a UTC host, so with no zone it was Greenwich's date — tomorrow's,
  // from 5pm in California. One batched read for every family in the batch; a
  // failed read is logged and dates those digests in an explicit UTC rather
  // than holding the digests themselves, which is the one thing a cosmetic
  // lookup must not do. A recipient can belong to several families and one
  // digest holds all of their rows, so it is dated only when every family in
  // it keeps the same zone (digestTimeZone) — never in the first row's
  // family's zone over another family's rows.
  const familyIds = [...new Set(permitted.map((n) => n.family_id))];
  const { data: familyZones, error: familyZonesError } = await readInChunks<{ id: string; timezone: string | null }, { message: string }>(
    familyIds,
    (chunk) => supabase.from('families').select('id, timezone').in('id', chunk),
  );
  if (familyZonesError) console.error('[notification-email] family timezone read failed; dating digests in UTC', familyZonesError);
  const zoneByFamily = new Map((familyZones ?? []).map((f) => [f.id, f.timezone || 'UTC']));
  const userIds = [...byUser.keys()];

  // Respect the per-user email toggle (default on).
  //
  // Chunked: `pending` is .limit(500), so userIds can hold up to 500 UUIDs, and
  // lib/supabase/chunked-in.ts puts one `.in()` at roughly 40 bytes per id —
  // 500 is a ~20 KB query string against a common 8 KB request-line limit. The
  // read comes back "URI too long", this function returns failed:1 without
  // marking anything sent, and the next run reads the SAME 500 rows and fails
  // the same way. Nothing is settled before this point, so the stall is
  // self-reinforcing: it begins exactly when the backlog is big enough to
  // matter and never clears on its own.
  // One preference row per user fits the ordinary 1000-row cap in a 100-ID
  // chunk. A smaller configured cap can still hide an explicit opt-out, so
  // complete every ordered chunk through its empty end page before delivery.
  const { data: prefs, error: prefsError } = await readAllInChunks<
    { user_id: string; email_enabled: boolean | null }, { message: string }
  >(userIds, (chunk, from, to) => supabase
    .from('user_preferences')
    .select('user_id, email_enabled')
    .in('user_id', chunk)
    .order('user_id')
    .range(from, to));
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

  // Resolve recipient emails + names. EVERY auth user, not the first page:
  // a bare listUsers() returns GoTrue's default 50, and a recipient missing from
  // this map takes the "no email on file" branch below, which stamps sent_at.
  // Truncation there is not a delayed email, it is a deleted one — the
  // notification is settled as `skipped` and never retried.
  const { users: allAuthUsers, error: authUsersError } = await listAllAuthUsers(supabase);
  if (authUsersError) {
    console.error('[notification-email] recipient lookup failed', authUsersError);
    return { sent: 0, failed: 1, skipped: 0 };
  }
  const userMeta = new Map(
    allAuthUsers.map((u) => [
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
  // Counts are per recipient digest: a mixed digest retains only permitted
  // content and is counted once; a wholly withheld recipient is one skip.
  let skipped = queuedUserIds.filter((id) => !byUser.has(id)).length;
  const resolvedIds: string[] = [...withheldIds]; // emailed OR intentionally skipped → mark sent_at

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
    const { ok, skipped: notSent } = await sendReactEmail({
      to: meta.email,
      subject: `${notifs.length} family update${notifs.length > 1 ? 's' : ''} · Bubaly`,
      react: React.createElement(NotificationDigestEmail, { name: meta.name, items, timeZone: digestTimeZone(notifs, zoneByFamily) }),
      // Same recipient and row set reuse one request key. The provider may
      // reject an in-flight or changed-payload replay; keep those rows pending.
      // This does not cover changed row sets, partial acknowledgements or keys
      // older than the provider's 24-hour retention window.
      idempotencyKey: digestIdempotencyKey(userId, ids),
    });
    if (notSent) {
      // No mail provider: nothing was emailed. Leave sent_at null so these go
      // out once one is configured, instead of stamping them sent unseen.
      skipped += 1;
    } else if (ok) {
      sent++;
      resolvedIds.push(...ids);
    } else {
      failed++;
    }
    // On send failure we leave sent_at null so the next run retries.
  }

  if (resolvedIds.length) {
    // Rows deliberately not checked. Every caller passes the service role, so a
    // row that does not match was deleted — and a deleted notification is not
    // emailed again anyway. Audit C1-S9-68.
    const { error: resolveError } = await supabase.from('notifications').update({ sent_at: nowIso }).in('id', resolvedIds);
    if (resolveError) {
      console.error('[notification-email] notification resolve update failed', resolveError);
      failed++;
    }
  }
  return { sent, failed, skipped };
}

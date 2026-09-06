// lib/server/push.ts
// Server-side push dispatch. Delivers a notification payload to all of a user's
// registered devices:
//   - Web Push (installed PWA): real delivery via the `web-push` library + VAPID.
//   - Native (iOS/Android via Capacitor): delivered through FCM/APNs. A real FCM
//     HTTP send is wired when FCM credentials are present; otherwise native sends
//     are honestly skipped (reported, never silently "succeeded").
//
// Stale Web Push subscriptions (404/410) are pruned automatically.
import 'server-only';
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { fetchExternal } from '@/lib/server/external-fetch';
import { childrenBlockedOn } from '@/lib/notifications/child-channels';

type DB = SupabaseClient<Database>;

export type PushPayload = { title: string; body?: string | null; url?: string | null };
export type PushResult = { sent: number; skipped: number; failed: number; pruned: number };

let vapidReady: boolean | null = null;
function ensureVapid(): boolean {
  if (vapidReady !== null) return vapidReady;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:support@bubaly.com';
  if (pub && priv) {
    try {
      webpush.setVapidDetails(subject, pub, priv);
      vapidReady = true;
    } catch {
      vapidReady = false;
    }
  } else {
    vapidReady = false;
  }
  return vapidReady;
}

/** True when native push (FCM) is configured; APNs is delivered via FCM too. */
function fcmConfigured(): boolean {
  return Boolean(process.env.FCM_SERVER_KEY);
}

async function sendFcm(token: string, payload: PushPayload): Promise<boolean> {
  const key = process.env.FCM_SERVER_KEY;
  if (!key) return false;
  // FCM legacy HTTP send. Swap for HTTP v1 (service-account OAuth) in production.
  const res = await fetchExternal('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `key=${key}` },
    body: JSON.stringify({
      to: token,
      notification: { title: payload.title, body: payload.body ?? '' },
      data: { url: payload.url ?? '/dashboard' },
    }),
  }, 15_000);
  return res.ok;
}

/**
 * Send a push to every enabled device for a user. Returns delivery counts.
 * Requires a service-role client to read across users when called from cron.
 */
export async function sendPushToUser(supabase: DB, userId: string, payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { sent: 0, skipped: 0, failed: 0, pruned: 0 };
  const { data: devices } = await supabase
    .from('push_devices')
    .select('id, platform, provider, endpoint, p256dh, auth, token')
    .eq('user_id', userId)
    .eq('enabled', true);

  if (!devices || devices.length === 0) return result;
  const vapid = ensureVapid();
  const body = JSON.stringify({ title: payload.title, body: payload.body ?? '', url: payload.url ?? '/dashboard' });

  for (const d of devices) {
    try {
      if (d.provider === 'webpush') {
        if (!vapid || !d.endpoint || !d.p256dh || !d.auth) { result.skipped++; continue; }
        try {
          await webpush.sendNotification(
            { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
            body,
          );
          result.sent++;
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            await supabase.from('push_devices').delete().eq('id', d.id);
            result.pruned++;
          } else {
            result.failed++;
          }
        }
      } else {
        // Native FCM/APNs.
        if (!fcmConfigured() || !d.token) { result.skipped++; continue; }
        const ok = await sendFcm(d.token, payload);
        ok ? result.sent++ : result.failed++;
      }
    } catch {
      result.failed++;
    }
  }
  return result;
}

/** Fan out a payload to many users (e.g. a whole family). */
export async function sendPushToUsers(supabase: DB, userIds: string[], payload: PushPayload): Promise<PushResult> {
  const totals: PushResult = { sent: 0, skipped: 0, failed: 0, pruned: 0 };
  for (const uid of [...new Set(userIds)]) {
    const r = await sendPushToUser(supabase, uid, payload);
    totals.sent += r.sent; totals.skipped += r.skipped; totals.failed += r.failed; totals.pruned += r.pruned;
  }
  return totals;
}

export function pushConfigured(): { web: boolean; native: boolean } {
  return { web: ensureVapid(), native: fcmConfigured() };
}

/**
 * Deliver pushes for notification rows that are DUE (`send_at` has passed) and
 * haven't been pushed yet (pushed_at is null), then stamp pushed_at so they're
 * never pushed twice. Whole-family notifications (user_id null) fan out to every
 * active member. Call after the notification engine runs (cron + on-demand).
 * Idempotent.
 *
 * Push tracks its own pushed_at (separate from the email digest's sent_at) so a
 * notification can be both pushed AND emailed in the same cron run.
 *
 * The `send_at` filter is what makes a scheduled notification actually wait.
 * `notify()` lets a caller set a future `sendAt`, and defers past a recipient's
 * quiet hours by moving `send_at` to the end of the window — and the AI's own
 * `notifications.notify` tool exposes it as "Earliest delivery, ISO 8601". The
 * in-app list (`listUnread`) and the email digest (`deliverNotificationEmails`)
 * both honour it. Push did not: it selected on `pushed_at` alone, so a notice
 * scheduled for 8am tomorrow buzzed the phone on the next two-hourly scan —
 * tonight. `send_at` is `not null default now()` (0002_tables.sql:415), so this
 * withholds nothing that was due.
 */
export async function dispatchPendingPushes(
  supabase: DB,
  opts: { familyId?: string; limit?: number; now?: Date } = {},
): Promise<{ notifications: number; result: PushResult }> {
  let q = supabase
    .from('notifications')
    .select('id, family_id, user_id, title, body, related_type, related_id')
    .is('pushed_at', null)
    .lte('send_at', (opts.now ?? new Date()).toISOString())
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 200);
  if (opts.familyId) q = q.eq('family_id', opts.familyId);
  const { data: rows, error: rowsError } = await q;
  // Fail closed on the pending-push read: a swallowed error would return "0
  // notifications" indistinguishable from a genuinely empty queue, silently
  // dropping every push. The caller (cron / on-demand) counts a thrown dispatch
  // failure, so this surfaces instead of hiding.
  if (rowsError) {
    console.error('[push] pending-push read failed', { familyId: opts.familyId ?? null, error: rowsError });
    throw new Error('Pending-push read failed.');
  }
  if (!rows || rows.length === 0) return { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0 } };

  // Cache family member user ids for whole-family notifications.
  const familyMembers = new Map<string, string[]>();
  async function membersOf(familyId: string): Promise<string[]> {
    if (familyMembers.has(familyId)) return familyMembers.get(familyId)!;
    const { data, error } = await supabase
      .from('family_members')
      .select('user_id')
      .eq('family_id', familyId)
      .eq('is_active', true);
    // Degrade (skip this family's fan-out) but log — a broken member read would
    // otherwise silently drop whole-family pushes with no signal.
    if (error) console.error('[push] family_members read failed for fan-out', { familyId, error });
    const ids = (data ?? []).map((m) => m.user_id).filter((id): id is string => Boolean(id));
    familyMembers.set(familyId, ids);
    return ids;
  }

  // "How Bubaly may reach a child directly" (0257's `child_channels`) was stored
  // and consulted by nothing, so a family that switched push off still had its
  // children's phones buzz. Resolved once for the whole batch rather than per
  // notification: a whole-family notice fans out to every active member, so
  // without this a child is reached by the fan-out even when the family said no.
  const candidates = new Set<string>();
  for (const n of rows) {
    if (n.user_id) candidates.add(n.user_id);
    else for (const id of await membersOf(n.family_id)) candidates.add(id);
  }
  const pushBlocked = await childrenBlockedOn(supabase, 'push', [...candidates]);

  const totals: PushResult = { sent: 0, skipped: 0, failed: 0, pruned: 0 };
  for (const n of rows) {
    const addressed = n.user_id ? [n.user_id] : await membersOf(n.family_id);
    const recipients = addressed.filter((id) => !pushBlocked.has(id));
    // Still stamped below even when everyone was filtered out: the notification
    // was handled, and leaving `pushed_at` null would re-consider it every run.
    const url = n.related_type === 'social' ? '/dashboard/social' : '/dashboard/notifications';
    const r = await sendPushToUsers(supabase, recipients, { title: n.title, body: n.body, url });
    totals.sent += r.sent; totals.skipped += r.skipped; totals.failed += r.failed; totals.pruned += r.pruned;
    // Stamp pushed_at so this notification isn't pushed again next run. If the
    // stamp is silently lost the same push re-fires every cron — log it.
    const { error: stampError } = await supabase.from('notifications').update({ pushed_at: new Date().toISOString() }).eq('id', n.id);
    if (stampError) console.error('[push] pushed_at stamp failed', { notificationId: n.id, error: stampError });
  }
  return { notifications: rows.length, result: totals };
}

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

type DB = SupabaseClient<Database>;

export type PushPayload = { title: string; body?: string | null; url?: string | null };
export type PushResult = { sent: number; skipped: number; failed: number; pruned: number };

let vapidReady: boolean | null = null;
function ensureVapid(): boolean {
  if (vapidReady !== null) return vapidReady;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:hello@theagoras.com';
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
  const res = await fetch('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `key=${key}` },
    body: JSON.stringify({
      to: token,
      notification: { title: payload.title, body: payload.body ?? '' },
      data: { url: payload.url ?? '/dashboard' },
    }),
  });
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
 * Deliver pushes for notification rows that haven't been sent yet (sent_at is
 * null), then stamp sent_at so they're never pushed twice. Whole-family
 * notifications (user_id null) fan out to every active member. Call after the
 * notification engine runs (cron + on-demand). Idempotent.
 */
export async function dispatchPendingPushes(
  supabase: DB,
  opts: { familyId?: string; limit?: number } = {},
): Promise<{ notifications: number; result: PushResult }> {
  let q = supabase
    .from('notifications')
    .select('id, family_id, user_id, title, body, related_type, related_id')
    .is('sent_at', null)
    .order('created_at', { ascending: true })
    .limit(opts.limit ?? 200);
  if (opts.familyId) q = q.eq('family_id', opts.familyId);
  const { data: rows } = await q;
  if (!rows || rows.length === 0) return { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0 } };

  // Cache family member user ids for whole-family notifications.
  const familyMembers = new Map<string, string[]>();
  async function membersOf(familyId: string): Promise<string[]> {
    if (familyMembers.has(familyId)) return familyMembers.get(familyId)!;
    const { data } = await supabase
      .from('family_members')
      .select('user_id')
      .eq('family_id', familyId)
      .eq('is_active', true);
    const ids = (data ?? []).map((m) => m.user_id).filter((id): id is string => Boolean(id));
    familyMembers.set(familyId, ids);
    return ids;
  }

  const totals: PushResult = { sent: 0, skipped: 0, failed: 0, pruned: 0 };
  for (const n of rows) {
    const recipients = n.user_id ? [n.user_id] : await membersOf(n.family_id);
    const url = n.related_type === 'social' ? '/dashboard/social' : '/dashboard/notifications';
    const r = await sendPushToUsers(supabase, recipients, { title: n.title, body: n.body, url });
    totals.sent += r.sent; totals.skipped += r.skipped; totals.failed += r.failed; totals.pruned += r.pruned;
    await supabase.from('notifications').update({ sent_at: new Date().toISOString() }).eq('id', n.id);
  }
  return { notifications: rows.length, result: totals };
}

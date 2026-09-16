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
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';
import { childrenBlockedOn } from '@/lib/notifications/child-channels';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { isDeliverablePushEndpoint } from '@/lib/server/push-endpoint';

type DB = SupabaseClient<Database>;

export type PushPayload = { title: string; body?: string | null; url?: string | null };
export type PushResult = { sent: number; skipped: number; failed: number; pruned: number };

/** How long a totally-failed push keeps being retried before it is given up on. */
export const PUSH_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

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

/**
 * The outcome of one FCM send.
 *
 * `res.ok` is NOT the answer. FCM's legacy endpoint reports a dead token in the
 * response BODY with HTTP 200:
 *
 *     { "failure": 1, "results": [{ "error": "NotRegistered" }] }
 *
 * so reading the status alone counted an uninstalled app's token as **sent**,
 * forever, on every notification. `unregistered` is the half that lets the
 * caller prune, exactly as the web branch already does for a 404/410.
 * Audit C1-S6-04.
 */
type FcmOutcome = { ok: true } | { ok: false; unregistered: boolean; reason: string };

/** FCM's names for "this token will never work again". */
const FCM_DEAD_TOKEN = new Set(['NotRegistered', 'InvalidRegistration', 'MismatchSenderId']);

async function sendFcm(token: string, payload: PushPayload): Promise<FcmOutcome> {
  const key = process.env.FCM_SERVER_KEY;
  if (!key) return { ok: false, unregistered: false, reason: 'not_configured' };
  // FCM legacy HTTP send. Swap for HTTP v1 (service-account OAuth) in production.
  const res = await fetchWithDeadline('https://fcm.googleapis.com/fcm/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `key=${key}` },
    body: JSON.stringify({
      to: token,
      notification: { title: payload.title, body: payload.body ?? '' },
      data: { url: payload.url ?? '/dashboard' },
    }),
  }, 15_000);
  // A 401 here is the server key, not the token: never prune a device because
  // our own credential is wrong.
  if (!res.ok) return { ok: false, unregistered: false, reason: `http_${res.status}` };

  const bounded = await readBoundedResponseText(res, 64 * 1024);
  if (!bounded.ok) return { ok: false, unregistered: false, reason: 'oversized_response' };
  let parsed: { failure?: number; results?: { error?: string }[] };
  try {
    parsed = JSON.parse(bounded.text) as typeof parsed;
  } catch {
    // A 200 we cannot read is not evidence of a dead token either way.
    return { ok: false, unregistered: false, reason: 'unparsable_response' };
  }
  const error = parsed.results?.[0]?.error;
  if (!parsed.failure && !error) return { ok: true };
  return { ok: false, unregistered: !!error && FCM_DEAD_TOKEN.has(error), reason: error ?? 'unknown' };
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
        // Re-checked HERE and not only at registration: the endpoint is read
        // back out of a table, so the row outlives the check that admitted it,
        // and the DNS answer that made it safe can change underneath it. The
        // result is cached per hostname, so a family's real push host costs one
        // lookup every five minutes, not one per notification. Audit C3-S5-03.
        if (!(await isDeliverablePushEndpoint(d.endpoint))) {
          console.error('[push] endpoint no longer resolves somewhere we will POST to', { deviceId: d.id });
          result.skipped++;
          continue;
        }
        try {
          await webpush.sendNotification(
            { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } },
            body,
          );
          result.sent++;
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // `pruned` is returned to the caller and reported, so it has to mean
            // the row is gone. The delete's result was discarded and the counter
            // incremented regardless, so a refused delete was reported as a
            // pruned device while the row stayed — and a permanently dead
            // endpoint that never gets pruned is retried on every notification
            // from here on, spending a send each time and reporting itself
            // cleaned up each time.
            const { error: pruneError } = await supabase.from('push_devices').delete().eq('id', d.id);
            if (pruneError) {
              console.error('[push] dead device could not be pruned', { deviceId: d.id, status }, pruneError);
              result.failed++;
            } else {
              result.pruned++;
            }
          } else {
            result.failed++;
          }
        }
      } else {
        // Native FCM/APNs. Held to the same standard as the web branch above:
        // a token FCM calls dead is pruned, and `pruned` still only counts a
        // delete that landed. Without this, an uninstalled app was retried on
        // every notification forever — and, because FCM reports a dead token
        // with HTTP 200, counted as SENT each time. Audit C1-S6-04.
        if (!fcmConfigured() || !d.token) { result.skipped++; continue; }
        const outcome = await sendFcm(d.token, payload);
        if (outcome.ok) {
          result.sent++;
        } else if (outcome.unregistered) {
          const { error: pruneError } = await supabase.from('push_devices').delete().eq('id', d.id);
          if (pruneError) {
            console.error('[push] dead native device could not be pruned', { deviceId: d.id, reason: outcome.reason }, pruneError);
            result.failed++;
          } else {
            result.pruned++;
          }
        } else {
          console.error('[push] native send failed', { deviceId: d.id, reason: outcome.reason });
          result.failed++;
        }
      }
    } catch (err) {
      // A counted failure with no cause is an operator staring at a number.
      // Audit C1-S6-05.
      console.error('[push] device send threw', { deviceId: d.id, provider: d.provider }, err);
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
    .select('id, family_id, user_id, title, body, related_type, related_id, created_at')
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

    // A failed send is not a delivery. `pushed_at` is the ONLY thing the pending
    // query filters on, nothing ever clears it, and there is no retry — so
    // stamping after a failure dropped the notification permanently. The cron
    // route already answers 502 on `failed > 0`, which made the failure visible
    // and still left it unrecoverable: the run went red and the row said
    // delivered, and the row is what the next run reads.
    //
    // Retry ONLY when nothing got through at all (`sent` and `pruned` both 0 and
    // something failed). A partial success must still stamp: those devices have
    // the notification, and re-sending would buzz them a second time. Telling
    // partial from total is the most this can do without per-device delivery
    // state, which is a schema change — see F-001 in finalaudit.md for why a new
    // migration cannot reach production today.
    //
    // Bounded by age so a permanently broken endpoint cannot retry forever: the
    // scan is two-hourly, so this is roughly a dozen attempts before giving up.
    const nothingGotThrough = r.failed > 0 && r.sent === 0 && r.pruned === 0;
    // A row we cannot date is treated as brand new rather than as expired: the
    // failure mode of the first is one extra attempt, of the second a silently
    // dropped notification.
    const createdMs = new Date(n.created_at ?? '').getTime();
    const ageMs = Number.isNaN(createdMs) ? 0 : (opts.now ?? new Date()).getTime() - createdMs;
    const retryable = nothingGotThrough && ageMs < PUSH_RETRY_WINDOW_MS;
    if (retryable) {
      console.warn('[push] every send failed; leaving pushed_at null to retry', {
        notificationId: n.id, failed: r.failed, ageMs,
      });
      continue;
    }
    if (nothingGotThrough) {
      console.error('[push] giving up after the retry window; notification never delivered', {
        notificationId: n.id, failed: r.failed, ageMs,
      });
    }
    // Stamp pushed_at so this notification isn't pushed again next run. If the
    // stamp is silently lost the same push re-fires every cron — log it.
    const { error: stampError } = await supabase.from('notifications').update({ pushed_at: new Date().toISOString() }).eq('id', n.id);
    if (stampError) console.error('[push] pushed_at stamp failed', { notificationId: n.id, error: stampError });
  }
  return { notifications: rows.length, result: totals };
}

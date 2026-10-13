// lib/server/push.ts
// Server-side push dispatch. Delivers a notification payload to all of a user's
// registered devices:
//   - Web Push (installed PWA): real delivery via the `web-push` library + VAPID.
//   - Android (Capacitor): FCM HTTP v1 with service-account authorization.
//   - iOS (Capacitor): APNs HTTP/2 with token-based authorization.
//     Unconfigured native sends remain pending and are reported as skipped.
//
// Stale Web Push subscriptions (404/410) are pruned automatically.
import 'server-only';
import { randomUUID } from 'node:crypto';
import { Agent as HttpsAgent } from 'node:https';
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { nativePushConfigured, sendNativePush } from '@/lib/server/native-push';
import { childrenBlockedOn } from '@/lib/notifications/child-channels';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { readAll } from '@/lib/supabase/read-all';
import { readAllInChunks } from '@/lib/supabase/chunked-in';

type DB = SupabaseClient<Database>;

/**
 * How long a notification that reached NOBODY keeps being retried before it is
 * given up on and stamped.
 *
 * Restored after a merge that took main's `push.ts` wholesale. main's rule —
 * `if (r.failed > 0 || r.skipped > 0) continue;` — is kept exactly as its
 * retry CONDITION (it is the more generous one: a partial delivery is retried
 * rather than written off), but it had no age bound at all, so one permanently
 * dead endpoint kept the row pending and re-buzzed the healthy devices on every
 * scan, for ever, with nothing in the logs ever saying the notification had not
 * been delivered. The scan is two-hourly, so this window is roughly a dozen
 * attempts before the row is stamped and the failure is logged at error level.
 */
export const PUSH_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

import { isDeliverablePushEndpoint } from '@/lib/server/push-endpoint';
import { MAX_PUSH_DEVICES_PER_USER } from '@/lib/push/device-cap';

/**
 * The bounds on one web push, and on a dispatch run.
 *
 * `web-push`'s own `timeout` is https.request's SOCKET IDLE timeout, and it
 * collects the reply with `responseText += chunk` and no limit. An endpoint is
 * any HTTPS host a member registers (or inserts directly: push_devices_insert
 * is `user_id = auth.uid()`), so a server that answered 201 and then trickled
 * a byte every few seconds kept one send pending for as long as it liked —
 * and dispatch is serial, so every family's pushes behind it waited, on every
 * run, since its rows are never stamped and come back first on each wrap. It
 * could also stream an unbounded body into memory. The native path has had an
 * absolute deadline and a 64 KiB cap all along (lib/server/native-push.ts).
 */
export const WEB_PUSH_DEADLINE_MS = 15_000;
const WEB_PUSH_MAX_RESPONSE_BYTES = 64 * 1024;
/** How long one dispatch run may spend sending before it leaves the rest for the next. */
export const PUSH_DISPATCH_BUDGET_MS = 45_000;

/** Shared across one dispatch run: when it must stop, and devices already known not to answer. */
type DispatchBudget = { endsAt: number; stalled: Set<string> };

export type PushPayload = { title: string; body?: string | null; url?: string | null };
export type PushResult = {
  sent: number; skipped: number; failed: number; pruned: number;
  /** Recipient opt-outs or revoked family access, distinct from skipped device attempts. */
  withheld: number;
};

/** Raised only while resolving consent, before this batch can contact a provider. */
export class PushPreparationError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : 'Push preference read failed.');
    this.name = 'PushPreparationError';
  }
}

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

/** Private transport: callers must first resolve the recipient's push consent. */
/**
 * Which devices one notification has already reached (migration 0440).
 *
 * `pushed_at` stamps a notification only when EVERY device succeeded, so a
 * partial failure used to re-send to all of them on the next run. With a
 * receipt per device, a retry reaches only the devices that missed it. Nothing
 * is claimed ahead of a send, so a worker dying mid-batch loses nothing; the
 * worst case is a receipt write failing after a real send, which reaches that
 * ONE device once more.
 *
 * `enabled` is shared across the batch and turns off when the table does not
 * exist yet — a database the operator has not migrated keeps today's
 * behaviour rather than failing every push.
 */
type DeliveryReceipts = { notificationId: string; delivered: Set<string>; store: { enabled: boolean } };

async function recordDelivery(supabase: DB, receipts: DeliveryReceipts | undefined, deviceId: string): Promise<void> {
  if (!receipts) return;
  receipts.delivered.add(deviceId);
  if (!receipts.store.enabled) return;
  const { error } = await supabase.from('push_deliveries')
    .upsert({ notification_id: receipts.notificationId, device_id: deviceId }, { onConflict: 'notification_id,device_id', ignoreDuplicates: true });
  if (!error) return;
  if (isMissingRelationError(error)) { receipts.store.enabled = false; return; }
  // The send happened; only its record did not. A retry may reach this one
  // device again — the at-least-once side of the trade, never a lost push.
  console.error('[push] delivery receipt write failed', { notificationId: receipts.notificationId, deviceId, error });
}

/** Devices already reached, per notification, for one dispatch batch. */
async function deliveredDevices(supabase: DB, notificationIds: string[]): Promise<{ byNotification: Map<string, Set<string>>; store: { enabled: boolean } }> {
  const byNotification = new Map<string, Set<string>>();
  const store = { enabled: true };
  if (notificationIds.length === 0) return { byNotification, store };
  // Chunked AND paged. The rows still pending are the partly failed ones, each
  // with a receipt per device it reached, so a batch of 200 passes the server's
  // row cap during an outage. One unpaged read came back short with no error,
  // and every device whose receipt fell past the cap was buzzed again.
  const { data, error } = await readAllInChunks<{ notification_id: string; device_id: string }>(
    notificationIds,
    (chunk, from, to) => supabase.from('push_deliveries')
      .select('notification_id, device_id').in('notification_id', chunk)
      .order('notification_id').order('device_id').range(from, to),
  );
  if (error) {
    if (isMissingRelationError(error)) { store.enabled = false; return { byNotification, store }; }
    // Not knowing who was reached is not "nobody was": sending now would buzz
    // every device that already has it. The rows stay pending for the next run.
    console.error('[push] delivery receipt read failed', { error });
    throw new Error('Push receipt read failed.');
  }
  for (const row of data ?? []) {
    const set = byNotification.get(row.notification_id) ?? new Set<string>();
    set.add(row.device_id);
    byNotification.set(row.notification_id, set);
  }
  return { byNotification, store };
}

// Internal read failure flag keeps unknown family access or user permission pending even beyond
// the provider-failure retry window. It is never part of public outcome counts.
type DeliveryResult = PushResult & { familyReadFailed?: true };

/** Recheck queued family push permission after device/endpoint work. */
async function currentPushPreference(supabase: DB, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('user_preferences')
    .select('user_id, push_enabled').eq('user_id', userId).limit(1);
  if (error || !Array.isArray(data)) throw new Error('Push preference read failed.');
  // A missing preference retains the existing default; an unreadable row does not.
  if (data.length === 0) return true;
  const preference = data[0];
  if (data.length !== 1 || !preference || typeof preference !== 'object' || Array.isArray(preference)
    || preference.user_id !== userId || typeof preference.push_enabled !== 'boolean') {
    throw new Error('Push preference reply is invalid.');
  }
  return preference.push_enabled;
}

async function activeFamilyRecipient(supabase: DB, familyId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase.from('family_members')
    .select('user_id, family_id, is_active, family:families!inner(id, closed_at)')
    .eq('family_id', familyId).eq('user_id', userId).eq('is_active', true)
    .is('family.closed_at', null).limit(1);
  if (error || !Array.isArray(data)) throw new Error('Push family membership read failed.');
  if (data.length === 0) return false;
  const member = data[0];
  if (data.length !== 1 || !member || typeof member !== 'object' || Array.isArray(member)
    || member.user_id !== userId || member.family_id !== familyId || member.is_active !== true) {
    throw new Error('Push family membership reply is invalid.');
  }
  const family: unknown = member.family;
  if (!family || typeof family !== 'object' || Array.isArray(family)
    || (family as Record<string, unknown>).id !== familyId
    || (family as Record<string, unknown>).closed_at !== null) {
    throw new Error('Push family reply is invalid.');
  }
  return true;
}

async function sendPushDevicesToUser(
  supabase: DB, userId: string, payload: PushPayload, receipts?: DeliveryReceipts, familyId?: string, budget?: DispatchBudget,
): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 };
  async function stillPermitted(): Promise<boolean> {
    if (familyId === undefined) return true;
    try {
      // Initial batch consent can expire while looking up a device or endpoint.
      // Keep the existing final family read after this permission check.
      if (await currentPushPreference(supabase, userId)
        && await activeFamilyRecipient(supabase, familyId, userId)) return true;
      result.withheld = 1;
    } catch (error) {
      result.failed++; result.familyReadFailed = true;
      console.error('[push] final family permission read failed', { familyId, userId, error });
    }
    return false;
  }
  // The newest MAX_PUSH_DEVICES_PER_USER only: nothing capped how many rows an
  // account could add, and each one is a send this serial loop waits on.
  const { data: devices, error: devicesError } = await supabase
    .from('push_devices')
    .select('id, platform, provider, endpoint, p256dh, auth, token')
    .eq('user_id', userId)
    .eq('enabled', true)
    .order('last_seen_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(MAX_PUSH_DEVICES_PER_USER);

  if (devicesError) {
    console.error('[push] device read failed', { userId, error: devicesError });
    return { ...result, failed: 1 };
  }

  if (!devices || devices.length === 0) return result;
  const vapid = ensureVapid();
  const body = JSON.stringify({ title: payload.title, body: payload.body ?? '', url: payload.url ?? '/dashboard' });

  for (const d of devices) {
    // Already reached on an earlier, partially failed run: not a second buzz.
    if (receipts?.delivered.has(d.id)) continue;
    // A device that already ran out its deadline in this run is not waited on
    // again for the next notification; it is a failure, retried next run.
    if (budget?.stalled.has(d.id)) { result.failed++; continue; }
    // The run's time is spent: leave this device for the next one. Skipped,
    // not failed, so the notification stays pending without being expired.
    if (budget && Date.now() >= budget.endsAt) { result.skipped++; continue; }
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
        // Recheck after asynchronous endpoint validation, immediately before send.
        if (!(await stillPermitted())) return result;
        try {
          await sendWebPushBounded({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, body);
          result.sent++;
          await recordDelivery(supabase, receipts, d.id);
        } catch (err: unknown) {
          if (err instanceof WebPushAborted) {
            budget?.stalled.add(d.id);
            console.error('[push] web push abandoned', { deviceId: d.id, reason: err.message });
          }
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // `pruned` is returned to the caller and reported, so it has to mean
            // the row is gone. The delete's result was discarded and the counter
            // incremented regardless, so a refused delete was reported as a
            // pruned device while the row stayed — and a permanently dead
            // endpoint that never gets pruned is retried on every notification
            // from here on, spending a send each time and reporting itself
            // cleaned up each time.
            // Rows deliberately not checked — and this rests on an invariant
            // worth stating: every caller passes the SERVICE ROLE (checked under
            // C1-S9-68: the push test route, the marketing admin, both crons and
            // notification generation). There, zero rows means the device row is
            // already gone, which is what `pruned` promises. A caller passing a
            // user's client would break that — `push_devices_delete` is
            // owner-only — and the dead endpoint would be "pruned" forever.
            // Audit C1-S9-68.
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
      } else if (d.provider === 'fcm' || d.provider === 'apns') {
        if (!d.token) { result.skipped++; continue; }
        if (!(await stillPermitted())) return result;
        const outcome = await sendNativePush(d.provider, d.token, payload);
        if (outcome === 'sent') { result.sent++; await recordDelivery(supabase, receipts, d.id); }
        else if (outcome === 'unconfigured') result.skipped++;
        else if (outcome === 'unregistered') {
          // As above: service role, so zero rows means already gone.
          // Audit C1-S9-68.
          const { error: pruneError } = await supabase.from('push_devices').delete().eq('id', d.id);
          if (pruneError) result.failed++;
          else result.pruned++;
        } else result.failed++;
      } else result.failed++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

class WebPushAborted extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WebPushAborted';
  }
}

/**
 * One web push with an ABSOLUTE deadline and a bounded reply (see
 * WEB_PUSH_DEADLINE_MS). Still sent by `web-push`, which builds the encrypted
 * request and its VAPID header, but through an agent of our own: every socket
 * it opens is tracked and its bytes counted, and all of them are destroyed at
 * the deadline or past the size cap, whatever state the response is in.
 */
async function sendWebPushBounded(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  body: string,
): Promise<void> {
  const sockets = new Set<{ destroy: () => void }>();
  let abort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { abort = reject; });
  aborted.catch(() => {});
  const stop = (reason: string) => {
    abort(new WebPushAborted(reason));
    for (const socket of sockets) socket.destroy();
  };
  let received = 0;
  class BoundedAgent extends HttpsAgent {
    override createConnection(...args: Parameters<HttpsAgent['createConnection']>): ReturnType<HttpsAgent['createConnection']> {
      const socket = super.createConnection(...args);
      if (socket) {
        sockets.add(socket);
        socket.on('data', (chunk: Buffer | string) => {
          received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
          if (received > WEB_PUSH_MAX_RESPONSE_BYTES) stop('web push reply exceeded 64 KiB');
        });
      }
      return socket;
    }
  }
  const agent = new BoundedAgent({ keepAlive: false });
  const timer = setTimeout(() => stop('web push deadline exceeded'), WEB_PUSH_DEADLINE_MS);
  try {
    await Promise.race([
      webpush.sendNotification(subscription, body, { timeout: WEB_PUSH_DEADLINE_MS, agent }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    agent.destroy();
  }
}

/** Recipients per consent read; one preference row each, so a chunk cannot reach the row cap. */
const PREFERENCE_CHUNK = 100;

/** Batch consent is mandatory for every public sender, including marketing/test pushes. */
async function blockedPushRecipients(supabase: DB, userIds: string[]): Promise<Set<string>> {
  const candidates = [...new Set(userIds.filter(Boolean))];
  const blocked = new Set<string>();
  // Bound generated IN URLs to the repo's 100 ids (lib/supabase/chunked-in.ts):
  // 200 UUIDs is the ~8 KB request line itself. Resolve every chunk before any
  // provider send, so a failed later permission read cannot partially deliver
  // an unchecked batch.
  for (let offset = 0; offset < candidates.length; offset += PREFERENCE_CHUNK) {
    const batch = candidates.slice(offset, offset + PREFERENCE_CHUNK);
    for (const id of await childrenBlockedOn(supabase, 'push', batch)) blocked.add(id);
    const { data: preferences, error } = await supabase.from('user_preferences')
      .select('user_id, push_enabled').in('user_id', batch);
    if (error) {
      console.error('[push] preference read failed', { error });
      throw new Error('Push preference read failed.');
    }
    for (const preference of preferences ?? []) {
      if (preference.push_enabled === false) blocked.add(preference.user_id);
    }
  }
  return blocked;
}

/** Private fanout for a batch whose permission reads have already succeeded. */
async function sendPermittedPushes(
  supabase: DB, userIds: string[], payload: PushPayload, receipts?: DeliveryReceipts, familyId?: string, budget?: DispatchBudget,
): Promise<DeliveryResult> {
  const totals: DeliveryResult = { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 };
  for (const uid of [...new Set(userIds)]) {
    const r = await sendPushDevicesToUser(supabase, uid, payload, receipts, familyId, budget);
    totals.sent += r.sent; totals.skipped += r.skipped; totals.failed += r.failed; totals.pruned += r.pruned;
    totals.withheld += r.withheld;
    if (r.familyReadFailed) totals.familyReadFailed = true;
  }
  return totals;
}

/** Send only after recipient and parental push settings can be read and permit delivery. */
export async function sendPushToUser(supabase: DB, userId: string, payload: PushPayload): Promise<PushResult> {
  return sendPushToUsers(supabase, [userId], payload);
}

/** Fan out with one consent resolution for the complete batch. Read failures throw before any send. */
export async function sendPushToUsers(supabase: DB, userIds: string[], payload: PushPayload): Promise<PushResult> {
  const candidates = [...new Set(userIds.filter(Boolean))];
  let blocked: Set<string>;
  try { blocked = await blockedPushRecipients(supabase, candidates); }
  catch (error) { throw new PushPreparationError(error); }
  const allowed = candidates.filter(id => !blocked.has(id));
  const result = await sendPermittedPushes(supabase, allowed, payload);
  result.withheld = candidates.length - allowed.length;
  return result;
}

export function pushConfigured(): { web: boolean; native: boolean } {
  const native = nativePushConfigured();
  return { web: ensureVapid(), native: native.fcm || native.apns };
}

type PushCursor = { version: 1; createdAt: string; id: string };

function parsePushCursor(value: unknown): PushCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cursor = value as Record<string, unknown>;
  // Keep PostgreSQL's fractional-second precision: Date.toISOString() would
  // truncate microseconds and revisit/skip rows at the page boundary.
  if (cursor.version !== 1 || typeof cursor.createdAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.createdAt)
    || !Number.isFinite(Date.parse(cursor.createdAt)) || typeof cursor.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)) return null;
  return { version: 1, createdAt: cursor.createdAt, id: cursor.id };
}

/**
 * Deliver pushes for notification rows that are DUE (`send_at` has passed) and
 * haven't been resolved yet (pushed_at is null), then stamp successful or
 * deliberately withheld notifications. Whole-family notifications fan out to every
 * active member. Call after the notification engine runs (cron + on-demand).
 * Failed or unconfigured delivery stays pending for retry. A retry reaches only
 * the devices with no receipt in push_deliveries (0440), so a partial failure no
 * longer re-sends to the devices that succeeded; an acknowledgement failure after
 * a real send can still reach that one device again.
 * A service-only app_settings cursor advances through stable created_at/id
 * pages, then wraps, so permanently failing devices cannot monopolize the
 * oldest batch. Global and family-scoped scans keep separate progress. The
 * cursor records traversal, never successful delivery or an exclusive claim.
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
  opts: { familyId?: string; limit?: number; now?: Date; budgetMs?: number } = {},
): Promise<{ notifications: number; result: PushResult }> {
  // The whole run's sending time, so one recipient's devices cannot spend all
  // of it (PUSH_DISPATCH_BUDGET_MS). Wall-clock, not `opts.now`, which only
  // decides what is due.
  const budget: DispatchBudget = { endsAt: Date.now() + (opts.budgetMs ?? PUSH_DISPATCH_BUDGET_MS), stalled: new Set() };
  const limit = opts.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Push batch limit must be an integer from 1 to 200.');
  const cursorKey = `push_dispatch_cursor:v1:${opts.familyId ? `family:${opts.familyId}` : 'global'}`;
  const { data: stored, error: cursorReadError } = await supabase.from('app_settings')
    .select('value').eq('key', cursorKey).maybeSingle();
  if (cursorReadError) throw new Error('Push cursor read failed.');
  const cursor = stored ? parsePushCursor(stored.value) : null;
  if (stored && !cursor) throw new Error('Push cursor is invalid.');
  const dueAt = (opts.now ?? new Date()).toISOString();
  async function page(size: number, wrap = false) {
    let q = supabase.from('notifications')
      // Rows of OPEN families only (families.closed_at): a closed account's
      // devices are not buzzed. In the query, before the page limit, so queued
      // rows of a closed family cannot fill the page ahead of everyone else's.
      .select('id, family_id, user_id, title, body, related_type, related_id, created_at, family:families!inner(closed_at)')
      .is('family.closed_at', null)
      .is('pushed_at', null).lte('send_at', dueAt)
      // Chat notices have not opted into external delivery. Filter before the
      // page limit so a busy conversation cannot starve other notifications.
      .or('related_type.is.null,related_type.neq.family_message')
      .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(size);
    if (opts.familyId) q = q.eq('family_id', opts.familyId);
    if (cursor) {
      // Strictly validated timestamp/UUID values cannot inject filter syntax.
      q = q.or(`created_at.${wrap ? 'lt' : 'gt'}.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.${wrap ? 'lte' : 'gt'}.${cursor.id})`);
    }
    const { data, error } = await q;
    if (error) {
      console.error('[push] pending-push read failed', { familyId: opts.familyId ?? null, error });
      throw new Error('Pending-push read failed.');
    }
    return data ?? [];
  }
  const rows = await page(limit);
  if (cursor && rows.length < limit) rows.push(...await page(limit - rows.length, true));
  if (rows.length === 0) return { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } };
  const last = rows[rows.length - 1];
  const nextPosition = parsePushCursor({ version: 1, createdAt: last.created_at, id: last.id });
  if (!nextPosition) throw new Error('Push notification cursor fields are invalid.');
  // A wrap can return to the same position. Change the stored identity even
  // then, so only one competing snapshot can match the original JSON value.
  const nextCursor = { ...nextPosition, generation: randomUUID() };
  // Save progress before any external send. A write failure sends nothing;
  // a later delivery failure stays pending and is revisited on wrap-around.
  //
  // Compare the complete stored value, including any generation, while accepting
  // legacy position-only cursors. Fresh generations fence competing snapshots
  // of that value even if traversal returns to the same position. They do not
  // fence another scope, or a later worker reading the new generation before
  // this worker records delivery; this is not a per-notification send lease.
  //
  // The very first run for a scope has no cursor to compare against and still
  // upserts. Two workers racing that one batch remains possible exactly once per
  // scope, before any cursor exists.
  const stamp = new Date().toISOString();
  if (stored) {
    const { data: claimed, error: claimError } = await supabase.from('app_settings')
      .update({ value: nextCursor, updated_at: stamp })
      // The stored cursor as JSON TEXT: postgrest-js writes `eq.${value}` into
      // the URL, so the object itself arrived as "[object Object]" and PostgREST
      // refused it (22P02). Every run after the first threw here and no push was
      // ever sent again (PUSH-007). PostgREST compares the text as jsonb.
      .eq('key', cursorKey).eq('value', JSON.stringify(stored.value))
      .select('key').maybeSingle();
    if (claimError) throw new Error('Push cursor write failed.');
    if (claimed?.key !== cursorKey) {
      // Lost the claim: another worker advanced the cursor after this run read
      // it, so it owns these rows. Send nothing rather than deliver them twice.
      // Distinct from an unconfirmed write below — here a missing row is the
      // expected answer for the loser, not an unverified write to assume away.
      return { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } };
    }
  } else {
    const { data: saved, error: cursorWriteError } = await supabase.from('app_settings')
      .upsert({ key: cursorKey, value: nextCursor, updated_at: stamp }, { onConflict: 'key' })
      .select('key').maybeSingle();
    // No prior value to compare against, so a missing row here is an unconfirmed
    // write. Nothing may be sent on the strength of one.
    if (cursorWriteError || saved?.key !== cursorKey) throw new Error('Push cursor write failed.');
  }

  // The roster prepares recipients; queued family sends also recheck each
  // recipient and open family before contacting a device provider. A change after
  // that final read is still not atomically fenced against the external send.
  const familyMembers = new Map<string, Set<string>>();
  async function membersOf(familyId: string): Promise<Set<string>> {
    if (familyMembers.has(familyId)) return familyMembers.get(familyId)!;
    const { rows: members, error } = await readAll<{ user_id: string | null }>((from, to) => supabase
      .from('family_members')
      .select('user_id')
      .eq('family_id', familyId)
      .eq('is_active', true)
      .order('id')
      .range(from, to));
    if (error) {
      console.error('[push] family_members read failed for delivery', { familyId, error });
      throw new Error('Push recipient read failed.');
    }
    const ids = new Set(members.map((m) => m.user_id).filter((id): id is string => Boolean(id)));
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
    const members = await membersOf(n.family_id);
    if (n.user_id) {
      if (members.has(n.user_id)) candidates.add(n.user_id);
    } else for (const id of members) candidates.add(id);
  }
  const pushBlocked = await blockedPushRecipients(supabase, [...candidates]);
  // Read before any send, like the consent reads above: a failure here sends
  // nothing rather than re-sending to devices that already have it.
  const receipts = await deliveredDevices(supabase, rows.map((n) => n.id));

  const totals: PushResult = { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 };
  for (const n of rows) {
    const members = await membersOf(n.family_id);
    const addressed = n.user_id ? [n.user_id] : [...members];
    const recipients = addressed.filter((id) => members.has(id) && !pushBlocked.has(id));
    // Still stamped below even when everyone was filtered out: the notification
    // was handled, and leaving `pushed_at` null would re-consider it every run.
    const url = n.related_type === 'social' ? '/dashboard/social' : '/dashboard/notifications';
    const r = await sendPermittedPushes(supabase, recipients, { title: n.title, body: n.body, url }, {
      notificationId: n.id,
      delivered: receipts.byNotification.get(n.id) ?? new Set<string>(),
      store: receipts.store,
    }, n.family_id, budget);
    totals.sent += r.sent; totals.skipped += r.skipped; totals.failed += r.failed; totals.pruned += r.pruned;
    totals.withheld += addressed.length - recipients.length + r.withheld;
    // Missing credentials/invalid registration are not intentional opt-outs.
    // Keep the row pending so a later healthy run can deliver it — but only
    // inside the retry window, so a permanently broken endpoint cannot hold the
    // row pending for ever (and re-buzz the devices that DID receive it on
    // every scan). A row whose date is unreadable is treated as brand new
    // rather than expired: the cost of the first is one extra attempt, of the
    // second a silently dropped notification.
    const incomplete = r.failed > 0 || r.skipped > 0;
    const createdMs = new Date(n.created_at ?? '').getTime();
    const ageMs = Number.isNaN(createdMs) ? 0 : (opts.now ?? new Date()).getTime() - createdMs;
    // The window bounds genuine delivery FAILURES only. A `skipped` row was not
    // refused by a provider — it is missing VAPID/FCM/APNs configuration, or a
    // device with no credentials, and that is an operator problem which gets
    // repaired; a dead endpoint does not. Expiring those too would silently
    // drop every notification raised during a misconfiguration, and nothing is
    // being sent meanwhile, so none of them can be buzzing anyone twice.
    const expired = r.failed > 0 && !r.familyReadFailed && ageMs >= PUSH_RETRY_WINDOW_MS;
    if (incomplete && !expired) {
      console.warn('[push] delivery incomplete; leaving pushed_at null to retry', {
        notificationId: n.id, failed: r.failed, skipped: r.skipped, ageMs,
      });
      continue;
    }
    if (incomplete) {
      console.error('[push] giving up after the retry window; notification never fully delivered', {
        notificationId: n.id, failed: r.failed, skipped: r.skipped, ageMs,
      });
    }
    // Rows deliberately not checked: service role, and a notification deleted
    // since the scan is not pushed again. Audit C1-S9-68.
    const { error: stampError } = await supabase.from('notifications').update({ pushed_at: new Date().toISOString() }).eq('id', n.id);
    if (stampError) {
      totals.failed++;
      console.error('[push] pushed_at stamp failed', { notificationId: n.id, error: stampError });
    }
  }
  return { notifications: rows.length, result: totals };
}

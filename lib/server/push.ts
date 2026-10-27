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
import {
  aheadAndBehind, isMarketplaceNotice, latestCreatedAt, MARKETPLACE_RELATED_TYPE, NOTIFICATION_CLOCK_SKEW_MS, readFairBatch,
  recipientList, type FairExclusion, type FairRow,
} from '@/lib/notifications/fair-batch';

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

/**
 * The most rows of one dispatch batch a single family takes while another
 * family's rows are waiting, and the most one recipient inside a family takes
 * while anyone else's are (lib/notifications/fair-batch.ts). A family's
 * whole-family rows count as one more of its recipients. 0191's price drops
 * are the marketplace's, wherever they land: it takes a family's share, and
 * each seller (the listing's family) a recipient's, as does each listing.
 *
 * A member's session may still insert notifications addressed to themselves,
 * any number of them, dated whenever they like (0388), and a member can cause
 * whole-family rows by the hundred, in every family that saved a listing of
 * theirs, through 0191's price-drop trigger, so a child's flood ahead of the
 * cursor held back every family's pushes for as many ticks as it took to
 * drain at 200 rows a tick. Now their family takes 40 of a batch, the child 10
 * of those, all price drops 40 and one seller's listings 10 of those however
 * many listings it has, whichever families they land in, and the room left
 * goes to everyone else first.
 */
export const PUSH_ROWS_PER_FAMILY = 40;
export const PUSH_ROWS_PER_RECIPIENT = 10;
/** A listing id as 0191 writes it into related_id (marketplace_listings.id is a uuid). */
const LISTING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The part of each read a run keeps for the rows behind its cursor: the
 * retries (a failed delivery inside PUSH_RETRY_WINDOW_MS, a row skipped for
 * configuration or cut by the run's time budget) and any surplus a fair batch
 * left behind. 50 of a 200-row batch. The wrap used to run only when the
 * forward page came back short, so a forward range one member kept full
 * starved every family's retries. The retries keep their own place in the
 * stored cursor (`retry`), so each run's reserve goes on through the rows
 * behind rather than re-reading the oldest of them, and goes round to the
 * oldest once nothing after that place is left for the batch.
 */
export const PUSH_RETRY_SHARE = 0.25;

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

/**
 * The bound on one RECIPIENT in a run, not only on the run.
 *
 * The run's budget alone left one account able to spend all of it: its devices
 * were sent to one after another, each waited on for the full deadline, and the
 * per-account cap allows ten — so three devices that never answered used the
 * 45 s, and every family's pushes after them in the batch were skipped, on
 * every run that reached them. Now a recipient's web pushes for one
 * notification go out together, each with its own deadline from the moment it
 * is sent (not from the first one: the native sends and rechecks between them
 * are not theirs to pay for), so any number of stalling devices costs one. And
 * a recipient is waited on in full once per run: after a slow batch its later
 * ones get this much, and a second slow batch ends its web pushes for the run
 * (WEB_PUSH_STALLS_PER_RUN), so devices that take turns to stall — one per
 * notification — cannot spend it either. A member whose old laptop never
 * answers still gets every notification on the phone: the laptop is not sent to
 * again in the run, and a healthy push service answers well inside this.
 */
export const WEB_PUSH_DEADLINE_AFTER_STALL_MS = 3_000;
/** Slow batches after which a recipient's remaining web pushes this run are failed unsent. */
export const WEB_PUSH_STALLS_PER_RUN = 2;

/**
 * The bound on the TIME a recipient, and a family, may keep one run waiting on
 * web pushes: their endpoint lookups and their sends, every notification
 * together.
 *
 * Counting aborted sends was not a bound on time. A device that answered just
 * inside the deadline was never aborted, so it was waited on for 15 s on every
 * notice of the run and everyone after it was skipped; and the count was kept
 * per account, so a parent's household — the child logins they create can each
 * register a device, and one whole-family notice reaches them all — was the
 * same three stalls on three accounts. Now each send is given the least of its
 * own deadline and what its recipient, its family and the run have left; a
 * batch that kept the run waiting WEB_PUSH_DEADLINE_AFTER_STALL_MS or more
 * counts toward the cut-off whether it was answered or not; and once the time
 * is spent, the rest of that recipient's or family's web pushes wait for the
 * next run (skipped, so they stay pending). A family may spend half the run, so
 * the other half is always there for everyone else. Native sends (FCM, APNs)
 * and the permission rechecks are not counted: their hosts are not the
 * member's to choose.
 */
export const WEB_PUSH_RECIPIENT_ALLOWANCE_MS = WEB_PUSH_DEADLINE_MS + WEB_PUSH_DEADLINE_AFTER_STALL_MS;
export const WEB_PUSH_FAMILY_ALLOWANCE_MS = PUSH_DISPATCH_BUDGET_MS / 2;
/**
 * The least a web send is started with. A send given the last few hundred
 * milliseconds of an allowance cut a healthy device off mid-flight: counted
 * failed (so the notice could expire) and, if its push service had already
 * taken it, never receipted, so the next run buzzed the device again. Below
 * this the device is skipped and waits for the next run, as it does once the
 * allowance is spent.
 */
export const WEB_PUSH_MIN_SEND_MS = 1_000;

/**
 * Shared across one dispatch run: when it must stop, devices already known not
 * to answer, how many slow batches each recipient has had, and how long each
 * recipient and each family has kept the run waiting on web pushes.
 */
type DispatchBudget = {
  endsAt: number; stalled: Set<string>; stalls: Map<string, number>;
  waitedByRecipient: Map<string, number>; waitedByFamily: Map<string, number>;
};

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
/** Start `run` now and capture its outcome, so it can be awaited later and never rejects unobserved. */
function settledCall<T>(run: () => T | PromiseLike<T>): Promise<Settled<Awaited<T>>> {
  try {
    return Promise.resolve(run()).then(
      (value) => ({ ok: true as const, value: value as Awaited<T> }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  } catch (error) {
    return Promise.resolve({ ok: false as const, error });
  }
}

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
  // account could add, and each one is a send this loop makes.
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

  // One recipient, many web pushes: each is started in turn without waiting
  // for the one before, and the ones still running are waited on after the loop.
  const stalls = budget?.stalls.get(userId) ?? 0;
  const cutOff = stalls >= WEB_PUSH_STALLS_PER_RUN;
  const deadlineMs = stalls === 0 ? WEB_PUSH_DEADLINE_MS : WEB_PUSH_DEADLINE_AFTER_STALL_MS;
  // How long this call has kept the run waiting on web pushes: their endpoint
  // lookups, and the sends still running once the loop is done. The time spent
  // on native sends and rechecks meanwhile is not counted (see
  // WEB_PUSH_RECIPIENT_ALLOWANCE_MS), though the web sends run through it.
  let waited = 0;
  async function waitFor<T>(pending: Promise<T>): Promise<T> {
    const from = Date.now();
    try { return await pending; } finally { waited += Date.now() - from; }
  }
  /** What the next web send may take: its own deadline, cut to what its recipient, its family and the run have left. */
  function allowance(): number {
    if (!budget) return deadlineMs;
    return Math.min(
      deadlineMs,
      WEB_PUSH_RECIPIENT_ALLOWANCE_MS - (budget.waitedByRecipient.get(userId) ?? 0) - waited,
      familyId === undefined ? Infinity : WEB_PUSH_FAMILY_ALLOWANCE_MS - (budget.waitedByFamily.get(familyId) ?? 0) - waited,
      budget.endsAt - Date.now(),
    );
  }
  type Device = (typeof devices)[number];
  const sendable = (d: Device) => d.provider === 'webpush' && !receipts?.delivered.has(d.id)
    && !budget?.stalled.has(d.id) && !cutOff && allowance() >= WEB_PUSH_MIN_SEND_MS
    && Boolean(vapid && d.endpoint && d.p256dh && d.auth);
  // The endpoint checks too: each is a DNS lookup on a host the member chose,
  // bounded at 3 s apiece, so ten of them in turn were half a minute.
  const endpointChecks = new Map(devices.filter(sendable)
    .map((d) => [d.id, settledCall(() => isDeliverablePushEndpoint(d.endpoint ?? ''))] as const));
  const sends: Promise<Settled<void>>[] = [];
  const settled: Promise<void>[] = [];
  /** Count one finished web push — sent, pruned or failed — as soon as it finishes. */
  async function settleWebPush(d: Device, sent: Settled<void>, givenMs: number): Promise<void> {
    if (sent.ok) {
      result.sent++;
      await recordDelivery(supabase, receipts, d.id);
      return;
    }
    const err = sent.error;
    // Cut short by what was left of an allowance, it says nothing about the
    // device; given a real deadline and not answering inside it, it is not
    // waited on again this run.
    if (err instanceof WebPushAborted) {
      if (givenMs >= WEB_PUSH_DEADLINE_AFTER_STALL_MS) budget?.stalled.add(d.id);
      console.error('[push] web push abandoned', { deviceId: d.id, reason: err.message });
    }
    const status = (err as { statusCode?: number } | null)?.statusCode;
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

  for (const d of devices) {
    // Already reached on an earlier, partially failed run: not a second buzz.
    if (receipts?.delivered.has(d.id)) continue;
    // A device that already ran out its deadline in this run is not waited on
    // again for the next notification; it is a failure, retried next run.
    if (budget?.stalled.has(d.id)) { result.failed++; continue; }
    // A recipient already slow twice this run: its web pushes are failures,
    // retried next run, rather than a third wait.
    if (d.provider === 'webpush' && cutOff) { result.failed++; continue; }
    // The run's time is spent: leave this device for the next one. Skipped,
    // not failed, so the notification stays pending without being expired.
    if (budget && Date.now() >= budget.endsAt) { result.skipped++; continue; }
    try {
      if (d.provider === 'webpush') {
        if (!vapid || !d.endpoint || !d.p256dh || !d.auth) { result.skipped++; continue; }
        // The recipient's or the family's time for web pushes is spent: as
        // with the run's, this device waits for the next run.
        if (allowance() < WEB_PUSH_MIN_SEND_MS) { result.skipped++; continue; }
        // Re-checked HERE and not only at registration: the endpoint is read
        // back out of a table, so the row outlives the check that admitted it,
        // and the DNS answer that made it safe can change underneath it. The
        // result is cached per hostname, so a family's real push host costs one
        // lookup every five minutes, not one per notification. Audit C3-S5-03.
        const endpoint = d.endpoint;
        const check = await waitFor(endpointChecks.get(d.id) ?? settledCall(() => isDeliverablePushEndpoint(endpoint)));
        if (!check.ok) throw check.error;
        if (!check.value) {
          console.error('[push] endpoint no longer resolves somewhere we will POST to', { deviceId: d.id });
          result.skipped++;
          continue;
        }
        // Recheck after asynchronous endpoint validation, immediately before send.
        if (!(await stillPermitted())) break;
        // Its own deadline, from now: not one shared with the sends before it.
        const givenMs = allowance();
        if (givenMs < WEB_PUSH_MIN_SEND_MS) { result.skipped++; continue; }
        const keys = { p256dh: d.p256dh, auth: d.auth };
        const sent = settledCall(() => sendWebPushBounded({ endpoint, keys }, body, givenMs));
        sends.push(sent);
        // Counted and receipted as it finishes, not when the slowest one does:
        // a worker killed while a slow send is pending has still recorded the
        // devices that already have it, so the next run does not buzz them again.
        settled.push(sent.then((outcome) => settleWebPush(d, outcome, givenMs)).catch(() => { result.failed++; }));
      } else if (d.provider === 'fcm' || d.provider === 'apns') {
        if (!d.token) { result.skipped++; continue; }
        if (!(await stillPermitted())) break;
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

  // The web pushes still running. Waited on even when a recheck withheld a
  // later device: these were already sent.
  await waitFor(Promise.all(sends));
  await Promise.all(settled);
  if (budget) {
    budget.waitedByRecipient.set(userId, (budget.waitedByRecipient.get(userId) ?? 0) + waited);
    if (familyId !== undefined) budget.waitedByFamily.set(familyId, (budget.waitedByFamily.get(familyId) ?? 0) + waited);
    // Slow is slow whether or not the device answered in the end: one that
    // answers just inside the deadline costs the run as much as one that never does.
    if (waited >= WEB_PUSH_DEADLINE_AFTER_STALL_MS) budget.stalls.set(userId, stalls + 1);
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
  /** How long this send may take, counted from now: its own, never shared with another send. */
  deadlineMs: number,
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
  const remaining = Math.min(WEB_PUSH_DEADLINE_MS, Math.max(0, deadlineMs));
  const timer = setTimeout(() => stop('web push deadline exceeded'), remaining);
  try {
    await Promise.race([
      webpush.sendNotification(subscription, body, { timeout: Math.max(1, remaining), agent }),
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

type PushPosition = { createdAt: string; id: string };
/**
 * Where the forward traversal is, and where the retries behind it go on from
 * (`retry`, absent when they start again from the oldest row behind; after it
 * they go round to the oldest row, up to it). A cursor an earlier deploy wrote
 * has no `retry`, and an earlier deploy's reader ignores one, so a deploy in
 * either direction keeps reading the cursor it finds.
 */
type PushCursor = { version: 1; createdAt: string; id: string; retry?: PushPosition };

/**
 * created_at then id, as the pending-push query orders them, to the
 * microsecond PostgreSQL keeps (Date.parse stops at the millisecond). A fair
 * batch is gathered over several reads, so it is put back in traversal order
 * before it is sent and before the cursor is taken from its last row.
 */
function traversalOrder(a: { created_at: string; id: string }, b: { created_at: string; id: string }): number {
  const instant = (value: string): [number, number] => {
    const ms = Date.parse(value);
    return [Number.isFinite(ms) ? ms : Infinity, Number((/\.\d{3}(\d{1,3})/.exec(value)?.[1] ?? '').padEnd(3, '0'))];
  };
  const [aMs, aMicro] = instant(a.created_at);
  const [bMs, bMicro] = instant(b.created_at);
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  if (aMicro !== bMicro) return aMicro - bMicro;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function parsePushPosition(value: unknown): PushPosition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const position = value as Record<string, unknown>;
  // Keep PostgreSQL's fractional-second precision: Date.toISOString() would
  // truncate microseconds and revisit/skip rows at the page boundary.
  if (typeof position.createdAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(position.createdAt)
    || !Number.isFinite(Date.parse(position.createdAt)) || typeof position.id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(position.id)) return null;
  return { createdAt: position.createdAt, id: position.id };
}

function parsePushCursor(value: unknown): PushCursor | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cursor = value as Record<string, unknown>;
  const position = cursor.version === 1 ? parsePushPosition(cursor) : null;
  if (!position) return null;
  if (cursor.retry === undefined || cursor.retry === null) return { version: 1, ...position };
  const retry = parsePushPosition(cursor.retry);
  return retry ? { version: 1, ...position, retry } : null;
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
 *
 * A batch is shared fairly by family and, inside a family, by recipient
 * (PUSH_ROWS_PER_FAMILY, PUSH_ROWS_PER_RECIPIENT); the retries behind the
 * cursor keep their own part of every read (PUSH_RETRY_SHARE); and a row
 * dated after now is not read. A member may plant rows addressed to
 * themselves with any created_at, and cause whole-family rows through 0191's
 * price-drop trigger in every family that saved their listing, which count
 * against the marketplace, the listing and its seller, not the families they
 * land in (lib/notifications/fair-batch.ts). No writer sets
 * created_at, so the date bound leaves out only planted rows, and the shares
 * hold back only a family's or a recipient's own surplus, only while someone
 * else's rows are waiting.
 */
export async function dispatchPendingPushes(
  supabase: DB,
  opts: { familyId?: string; limit?: number; now?: Date; budgetMs?: number } = {},
): Promise<{ notifications: number; result: PushResult }> {
  // The whole run's sending time (PUSH_DISPATCH_BUDGET_MS). What one recipient
  // or one family may spend of it is bounded separately
  // (WEB_PUSH_RECIPIENT_ALLOWANCE_MS, WEB_PUSH_FAMILY_ALLOWANCE_MS).
  // Wall-clock, not `opts.now`, which only decides what is due.
  const budget: DispatchBudget = {
    endsAt: Date.now() + (opts.budgetMs ?? PUSH_DISPATCH_BUDGET_MS), stalled: new Set(), stalls: new Map(),
    waitedByRecipient: new Map(), waitedByFamily: new Map(),
  };
  const limit = opts.limit ?? 200;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('Push batch limit must be an integer from 1 to 200.');
  const cursorKey = `push_dispatch_cursor:v1:${opts.familyId ? `family:${opts.familyId}` : 'global'}`;
  const { data: stored, error: cursorReadError } = await supabase.from('app_settings')
    .select('value').eq('key', cursorKey).maybeSingle();
  if (cursorReadError) throw new Error('Push cursor read failed.');
  const cursor = stored ? parsePushCursor(stored.value) : null;
  if (stored && !cursor) throw new Error('Push cursor is invalid.');
  const dueAt = (opts.now ?? new Date()).toISOString();
  // Nothing dated after now: only a member's own planted row can be, and one
  // dated in the future never aged out of the retry window below. Wall-clock,
  // like the budget: `opts.now` decides what is due, and no row is created
  // after the real now.
  const createdBy = latestCreatedAt(new Date());
  /**
   * One page of a range: 'ahead' of the cursor, or behind it, where the
   * retries go on after their own place ('behind') and then, once that is
   * spent, start again from the oldest row up to it ('lapped').
   */
  async function page(size: number, range: 'ahead' | 'behind' | 'lapped', excluded: FairExclusion) {
    const wrap = range !== 'ahead';
    let q = supabase.from('notifications')
      // Rows of OPEN families only (families.closed_at): a closed account's
      // devices are not buzzed. In the query, before the page limit, so queued
      // rows of a closed family cannot fill the page ahead of everyone else's.
      .select('id, family_id, user_id, title, body, related_type, related_id, created_at, family:families!inner(closed_at)')
      .is('family.closed_at', null)
      .is('pushed_at', null).lte('send_at', dueAt).lte('created_at', createdBy)
      // Chat notices have not opted into external delivery. Filter before the
      // page limit so a busy conversation cannot starve other notifications.
      .or('related_type.is.null,related_type.neq.family_message')
      .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(size);
    if (opts.familyId) q = q.eq('family_id', opts.familyId);
    if (cursor) {
      // Strictly validated timestamp/UUID values cannot inject filter syntax.
      q = q.or(`created_at.${wrap ? 'lt' : 'gt'}.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.${wrap ? 'lte' : 'gt'}.${cursor.id})`);
      // Behind it, the retries go on from where the last run's left off, and
      // then go round to the oldest rows, up to and including that place.
      const from = wrap ? cursor.retry : undefined;
      if (from && range === 'behind') q = q.or(`created_at.gt.${from.createdAt},and(created_at.eq.${from.createdAt},id.gt.${from.id})`);
      if (from && range === 'lapped') q = q.or(`created_at.lt.${from.createdAt},and(created_at.eq.${from.createdAt},id.lte.${from.id})`);
    }
    // Families, recipients, families' whole-family rows, the marketplace, its
    // listings and its full sellers' landing families that already hold their
    // share of this batch, exactly as isExcluded leaves them out. 0191's price
    // drops (user_id null, related_type MARKETPLACE_RELATED_TYPE, related_id
    // the listing) count against the marketplace, their listing and their
    // seller, not the family they land in. Each `or` ANDs with the rest; a
    // NULL user_id passes the recipients' and is judged by the others.
    const notMarket = `user_id.not.is.null,related_type.is.null,related_type.neq.${MARKETPLACE_RELATED_TYPE}`;
    if (excluded.families.length) q = q.not('family_id', 'in', recipientList(excluded.families));
    if (excluded.recipients.length) q = q.or(`user_id.is.null,user_id.not.in.${recipientList(excluded.recipients)}`);
    if (excluded.familyWide.length) {
      q = q.or(`user_id.not.is.null,family_id.not.in.${recipientList(excluded.familyWide)},related_type.eq.${MARKETPLACE_RELATED_TYPE}`);
    }
    if (excluded.marketplace) q = q.or(notMarket);
    if (excluded.listings.length) q = q.or(`${notMarket},related_id.is.null,related_id.not.in.${recipientList(excluded.listings)}`);
    if (excluded.landing.length) q = q.or(`${notMarket},family_id.not.in.${recipientList(excluded.landing)}`);
    if (excluded.unlisted) q = q.or(`${notMarket},related_id.not.is.null`);
    const { data, error } = await q;
    if (error) {
      console.error('[push] pending-push read failed', { familyId: opts.familyId ?? null, error });
      throw new Error('Pending-push read failed.');
    }
    return withSellers(data ?? []);
  }
  // The family whose listing each price drop names, so the batch counts the
  // drop against its seller (sellerOf in lib/notifications/fair-batch.ts):
  // one lookup a page, of the listings this run has not looked up yet, each
  // listing once a run. A listing not found (deleted since), an id that is
  // not one, or a lookup that failed leaves the drop with no seller: it counts
  // against the drops not found, not against the family it landed in, which
  // is a watcher's as often as the seller's own (readFairBatch). A failed
  // lookup is logged, not a failed run.
  const sellers = new Map<string, string | null>();
  async function withSellers<R extends FairRow>(rows: R[]): Promise<(R & { seller_family_id?: string | null })[]> {
    const unknown = [...new Set(rows.filter((n) => isMarketplaceNotice(n) && n.related_id && !sellers.has(n.related_id))
      .map((n) => n.related_id!))];
    for (const id of unknown) sellers.set(id, null);
    const listingIds = unknown.filter((id) => LISTING_ID.test(id));
    if (listingIds.length) {
      try {
        const { data: listings, error } = await readAllInChunks<{ id: string; family_id: string }>(listingIds, (chunk, from, to) => supabase
          .from('marketplace_listings').select('id, family_id').in('id', chunk).order('id').range(from, to));
        if (error || !listings) console.error('[push] price-drop seller read failed', { error });
        else for (const listing of listings) sellers.set(listing.id, listing.family_id);
      } catch (error) {
        console.error('[push] price-drop seller read failed', { error });
      }
    }
    return rows.map((n) => (isMarketplaceNotice(n) && n.related_id ? { ...n, seller_family_id: sellers.get(n.related_id) ?? null } : n));
  }
  const forward = (size: number, excluded: FairExclusion) => page(size, 'ahead', excluded);
  // Behind the cursor the retries go round: after their own place first, then
  // from the oldest row up to it, so a row they passed is reached again as soon
  // as nothing after their place is left for this batch. Waiting for the lap to
  // end instead, a retry passed once waited for as long as untaken rows behind
  // the cursor (a flood's surplus, which a full forward page leaves there every
  // tick) kept it from ending, and with nothing after the place and nothing
  // ahead, a run read nothing at all and the lap never ended.
  const readBehind = async (size: number, excluded: FairExclusion) => {
    const after = await page(size, 'behind', excluded);
    return !cursor?.retry || after.length >= size ? after : [...after, ...await page(size - after.length, 'lapped', excluded)];
  };
  // With a cursor, every read keeps part of the batch for the rows behind it,
  // so retries progress whatever lies ahead (PUSH_RETRY_SHARE).
  const ranges = cursor ? aheadAndBehind(forward, readBehind, PUSH_RETRY_SHARE) : null;
  const batch = await readFairBatch(ranges?.read ?? forward, limit, {
    perFamily: PUSH_ROWS_PER_FAMILY, perRecipient: PUSH_ROWS_PER_RECIPIENT,
  });
  const ahead = batch.filter((n) => !ranges?.isBehind(n)).sort(traversalOrder);
  const behind = ranges ? batch.filter((n) => ranges.isBehind(n)).sort(traversalOrder) : [];
  const rows = [...ahead, ...behind];
  if (rows.length === 0) return { notifications: 0, result: { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 } };
  // The cursor follows the forward traversal. Only a batch that took
  // everything ahead of it wraps, to its last row behind; one whose retries
  // rode along on their reserve keeps its place ahead.
  const wraps = !ranges || ahead.length === 0 || behind.length === 0 || ranges.aheadExhausted(batch);
  const last = wraps ? rows[rows.length - 1] : ahead[ahead.length - 1];
  const nextPosition = parsePushPosition({ createdAt: last.created_at, id: last.id });
  // The retries keep a place of their own behind the cursor (R9-RV2): from
  // the oldest row behind, every run re-read the same rows, so under a flood
  // ahead (no wrap) a retry behind a reserve's worth of older ones still
  // failing waited until they aged out, or for good if they were skipped.
  // They go on after the last row they took, in the order they go round (a
  // row they took on going round from the oldest comes after every row after
  // their old place), and start again from the oldest once they have taken
  // everything behind (or the cursor wraps to them).
  const from = cursor?.retry;
  const lapped = from ? behind.filter((n) => traversalOrder(n, { created_at: from.createdAt, id: from.id }) <= 0) : [];
  const restart = !ranges || ranges.behindExhausted(batch) || (wraps && behind.length > 0);
  const retryRow = restart ? null : lapped.at(-1) ?? behind.at(-1) ?? null;
  const retry = restart ? null
    : retryRow ? parsePushPosition({ createdAt: retryRow.created_at, id: retryRow.id }) : cursor?.retry ?? null;
  if (!nextPosition || (retryRow && !retry)) throw new Error('Push notification cursor fields are invalid.');
  // A wrap can return to the same position. Change the stored identity even
  // then, so only one competing snapshot can match the original JSON value.
  const nextCursor = { version: 1, ...nextPosition, ...(retry ? { retry } : {}), generation: randomUUID() };
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
    // A row dated after now is past any window too: no writer sets created_at,
    // so only a member's planted row can be, and its age stayed negative, so it
    // was retried for good. The read above leaves those out; this holds if it
    // ever does not. Against the wall clock, as that read is.
    const datedAhead = !Number.isNaN(createdMs) && createdMs > Date.now() + NOTIFICATION_CLOCK_SKEW_MS;
    const expired = r.failed > 0 && !r.familyReadFailed && (ageMs >= PUSH_RETRY_WINDOW_MS || datedAhead);
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

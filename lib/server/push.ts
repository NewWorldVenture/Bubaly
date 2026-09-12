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
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { nativePushConfigured, sendNativePush } from '@/lib/server/native-push';
import { childrenBlockedOn } from '@/lib/notifications/child-channels';

type DB = SupabaseClient<Database>;

export type PushPayload = { title: string; body?: string | null; url?: string | null };
export type PushResult = {
  sent: number; skipped: number; failed: number; pruned: number;
  /** Recipient opt-outs, distinct from unconfigured/skipped device attempts. */
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
async function sendPushDevicesToUser(supabase: DB, userId: string, payload: PushPayload): Promise<PushResult> {
  const result: PushResult = { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 };
  const { data: devices, error: devicesError } = await supabase
    .from('push_devices')
    .select('id, platform, provider, endpoint, p256dh, auth, token')
    .eq('user_id', userId)
    .eq('enabled', true);

  if (devicesError) {
    console.error('[push] device read failed', { userId, error: devicesError });
    return { ...result, failed: 1 };
  }

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
            { timeout: 15_000 },
          );
          result.sent++;
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            const { error: pruneError } = await supabase.from('push_devices').delete().eq('id', d.id);
            if (pruneError) result.failed++;
            else result.pruned++;
          } else {
            result.failed++;
          }
        }
      } else if (d.provider === 'fcm' || d.provider === 'apns') {
        if (!d.token) { result.skipped++; continue; }
        const outcome = await sendNativePush(d.provider, d.token, payload);
        if (outcome === 'sent') result.sent++;
        else if (outcome === 'unconfigured') result.skipped++;
        else if (outcome === 'unregistered') {
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

/** Batch consent is mandatory for every public sender, including marketing/test pushes. */
async function blockedPushRecipients(supabase: DB, userIds: string[]): Promise<Set<string>> {
  const candidates = [...new Set(userIds.filter(Boolean))];
  const blocked = new Set<string>();
  // Bound generated IN URLs. Resolve every chunk before any provider send, so
  // a failed later permission read cannot partially deliver an unchecked batch.
  for (let offset = 0; offset < candidates.length; offset += 200) {
    const batch = candidates.slice(offset, offset + 200);
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
async function sendPermittedPushes(supabase: DB, userIds: string[], payload: PushPayload): Promise<PushResult> {
  const totals: PushResult = { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 };
  for (const uid of [...new Set(userIds)]) {
    const r = await sendPushDevicesToUser(supabase, uid, payload);
    totals.sent += r.sent; totals.skipped += r.skipped; totals.failed += r.failed; totals.pruned += r.pruned;
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
 * Failed or unconfigured delivery stays pending for retry. Partial delivery or
 * an acknowledgement failure can repeat a successful send; this column alone
 * does not provide a per-device delivery receipt or a distributed worker claim.
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
  opts: { familyId?: string; limit?: number; now?: Date } = {},
): Promise<{ notifications: number; result: PushResult }> {
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
      .select('id, family_id, user_id, title, body, related_type, related_id, created_at')
      .is('pushed_at', null).lte('send_at', dueAt)
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
  const nextCursor = parsePushCursor({ version: 1, createdAt: last.created_at, id: last.id });
  if (!nextCursor) throw new Error('Push notification cursor fields are invalid.');
  // Save progress before any external send. A write failure sends nothing;
  // a later delivery failure stays pending and is revisited on wrap-around.
  // Concurrent workers may still read the same cursor and repeat delivery.
  const { data: saved, error: cursorWriteError } = await supabase.from('app_settings')
    .upsert({ key: cursorKey, value: nextCursor, updated_at: new Date().toISOString() }, { onConflict: 'key' })
    .select('key').maybeSingle();
  if (cursorWriteError || saved?.key !== cursorKey) throw new Error('Push cursor write failed.');

  // Cache family member user ids for whole-family notifications.
  const familyMembers = new Map<string, string[]>();
  async function membersOf(familyId: string): Promise<string[]> {
    if (familyMembers.has(familyId)) return familyMembers.get(familyId)!;
    const { data, error } = await supabase
      .from('family_members')
      .select('user_id')
      .eq('family_id', familyId)
      .eq('is_active', true);
    if (error) {
      console.error('[push] family_members read failed for fan-out', { familyId, error });
      throw new Error('Push recipient read failed.');
    }
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
  const pushBlocked = await blockedPushRecipients(supabase, [...candidates]);

  const totals: PushResult = { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 };
  for (const n of rows) {
    const addressed = n.user_id ? [n.user_id] : [...new Set(await membersOf(n.family_id))];
    const recipients = addressed.filter((id) => !pushBlocked.has(id));
    // Still stamped below even when everyone was filtered out: the notification
    // was handled, and leaving `pushed_at` null would re-consider it every run.
    const url = n.related_type === 'social' ? '/dashboard/social' : '/dashboard/notifications';
    const r = await sendPermittedPushes(supabase, recipients, { title: n.title, body: n.body, url });
    totals.sent += r.sent; totals.skipped += r.skipped; totals.failed += r.failed; totals.pruned += r.pruned;
    totals.withheld += addressed.length - recipients.length;
    // Missing credentials/invalid registration are not intentional opt-outs.
    // Keep the row pending so a later healthy run can deliver it.
    if (r.failed > 0 || r.skipped > 0) continue;
    const { error: stampError } = await supabase.from('notifications').update({ pushed_at: new Date().toISOString() }).eq('id', n.id);
    if (stampError) {
      totals.failed++;
      console.error('[push] pushed_at stamp failed', { notificationId: n.id, error: stampError });
    }
  }
  return { notifications: rows.length, result: totals };
}

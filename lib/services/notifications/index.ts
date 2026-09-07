// One way to tell the family something.
//
// There are fifteen direct inserts into `public.notifications` across the repo
// and each one re-decides who the recipients are, whether it is a duplicate,
// and when it should land. `notify` is the single entry point: it resolves
// 'family' | 'managers' | member ids to the recipient rows the table actually
// stores, drops duplicates, and defers delivery past quiet hours.
//
// Real columns, read from 0002 + 0038 rather than assumed: `user_id`
// (references `auth.users`, NULL = the whole family), `type`
// (`public.notification_type` enum), `title`, `body`, `related_type`,
// `related_id`, `is_read`, `send_at`, `sent_at`, `pushed_at`. There is no
// `member_id`, no `dedupe_key`, no `priority` and no `channel` column — so
// recipients are resolved to auth user ids here, and deduplication is on the
// natural key rather than a stored key.
//
// QUIET HOURS — DOCUMENTED SEAM. The repo has no notification-quiet-hours
// storage. The only `quiet_hours_*` columns anywhere are on
// `front_desk_settings` (0092), which govern phone-call screening, not
// notifications. Rather than invent a table, this reads
// `user_preferences.notification_prefs.quietHours` — the existing per-user
// jsonb bag that `lib/navigation/customize.ts`, `lib/capture/shortcuts.ts` and
// the app-lock settings already extend the same way. The shape is
// `{ start: number, end: number }` in family-local hours. Nothing writes that
// key today, so no notification is currently deferred; the day a settings
// surface writes it, delivery honours it with no change here.
import 'server-only';
import type { Json, NotificationType, Tables } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { DIGEST_NOTIFICATION_TYPES, type NotificationPriority } from '@/lib/notifications/priority';
import { describeDbError } from '@/lib/supabase/errors';
import { getAISettings } from '../ai-settings';
import { dayKeyInTz, hourInTz, scopeNow, zonedTimeMs } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type Notification = Tables<'notifications'>;

/** 'family' = one row visible to everyone; 'managers' = parents and adults; otherwise explicit `family_members.id`s. */
export type NotifyRecipients = 'family' | 'managers' | string[];

export type NotifyInput = {
  recipients: NotifyRecipients;
  type: NotificationType;
  title: string;
  body?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
  /** Earliest delivery. Quiet hours can push it later, never earlier. */
  sendAt?: string | null;
  /** Skip the quiet-hours deferral — for things that are urgent by definition. */
  urgent?: boolean;
  /**
   * Say this at most ONCE per `relatedId`, read or not. The default guard
   * only drops a duplicate while the first copy is still unread, which is
   * right for "the renewal is still expiring" and wrong for a day's morning
   * brief: a parent who read it at 7:05 must not get it again when the cron
   * re-runs at 8. Pair it with a `relatedId` that names the occasion
   * (`brief:2026-09-07`), because without one the title is the identity.
   */
  once?: boolean;
};

export type NotifyResult = {
  created: number;
  ids: string[];
  /** Recipients skipped because an identical unread notification was already waiting. */
  duplicates: number;
  /** Members with no login (managed profiles) — there is no account to notify. */
  skippedMemberIds: string[];
  /** Recipients whose delivery was pushed past their quiet hours. */
  deferred: number;
};

type QuietHours = { start: number; end: number };

/** True when `hour` falls inside a window that may wrap midnight (22 → 7). */
function inQuietHours(hour: number, quiet: QuietHours): boolean {
  return quiet.start < quiet.end
    ? hour >= quiet.start && hour < quiet.end
    : hour >= quiet.start || hour < quiet.end;
}

/** The next instant at which the quiet window ends, in the family's zone. */
function quietHoursEnd(at: Date, quiet: QuietHours, tz: string): string {
  const todayKey = dayKeyInTz(at, tz);
  const todayEnd = zonedTimeMs(todayKey, quiet.end, 0, tz);
  if (Number.isFinite(todayEnd) && todayEnd > at.getTime()) return new Date(todayEnd).toISOString();
  const tomorrowKey = dayKeyInTz(new Date(at.getTime() + 24 * 3600_000), tz);
  const tomorrowEnd = zonedTimeMs(tomorrowKey, quiet.end, 0, tz);
  return new Date(Number.isFinite(tomorrowEnd) ? tomorrowEnd : at.getTime()).toISOString();
}

/**
 * Create notification rows for the resolved recipients.
 *
 * Deduplication is against *unread* notifications with the same type, related
 * item and recipient. Once someone has read a notice, saying it again is
 * legitimate (the renewal is still expiring); saying it twice before they have
 * looked is spam. When there is no related item, the title stands in as the
 * identity — that is what makes "Dinner is at 6" idempotent across a retried
 * cron run.
 */
/**
 * When a notification should actually land, after the family's quiet hours.
 *
 * Exported because `notify()` is not the only writer: `generateFamilyNotifications`
 * builds up to 150 rows and inserts them in ONE batch, with its own per-type
 * dedupe. Routing that through `notify()` would mean 150 separate dedupe reads on
 * a cron — it already solves duplicates; the only thing it lacked was this
 * window. Two implementations of "when does this land" would eventually disagree,
 * and the one that drifts is the one nobody is testing.
 *
 * The window comes from `family_ai_settings` (0257), which is family-scoped and
 * therefore readable for EVERY recipient on every path — including the
 * service-role cron that sends most notifications. It used to come from
 * `user_preferences.notification_prefs.quietHours`, and that could never have
 * worked: `0004` makes `user_preferences` own-row-only, so a lookup of the
 * RECIPIENTS' rows returns at most the SENDER's.
 */
export async function deliveryTimeFor(
  scope: ServiceScope,
  opts: { sendAt?: string | null; urgent?: boolean } = {},
): Promise<{ sendAt: string; deferred: boolean }> {
  const now = scopeNow(scope);
  const explicit = opts.sendAt && Number.isFinite(Date.parse(opts.sendAt));
  const base = explicit ? new Date(Date.parse(opts.sendAt as string)) : now;
  // A caller who NAMED a time has already decided when this should land —
  // "remind me at 10:30pm to put the bins out" is not a courtesy notice to hold
  // until morning, it is the whole point. Quiet hours move the default, never a
  // deliberate instant.
  const quiet = opts.urgent || explicit ? null : await familyQuietHours(scope);
  // An hour we cannot compute is not an hour inside the window: a failed or
  // unset timezone must not silently hold a notification for eight hours. When
  // the local hour is unknown, send now and let the family see it.
  const localHour = quiet ? hourInTz(base, scope.tz) : null;
  const holdable = quiet !== null && Number.isInteger(localHour) && inQuietHours(localHour as number, quiet);
  return holdable && quiet
    ? { sendAt: quietHoursEnd(base, quiet, scope.tz), deferred: true }
    : { sendAt: base.toISOString(), deferred: false };
}

export async function notify(scope: ServiceScope, input: NotifyInput): Promise<ServiceResult<NotifyResult>> {
  const title = input.title?.trim() ?? '';
  if (!title) return fail('A notification needs a title.', { code: SERVICE_CODES.invalidInput });

  const recipients = await resolveRecipients(scope, input.recipients);
  if (!recipients.ok) return recipients;
  const { userIds, skippedMemberIds } = recipients.data;
  if (userIds.length === 0) return ok({ created: 0, ids: [], duplicates: 0, skippedMemberIds, deferred: 0 });

  // ── Duplicate guard ───────────────────────────────────────────────────────
  let dupeQuery = scope.db
    .from('notifications')
    .select('user_id')
    .eq('family_id', scope.familyId)
    .eq('type', input.type);
  // `once` widens the guard to every prior copy; the default is unread only.
  if (!input.once) dupeQuery = dupeQuery.eq('is_read', false);
  dupeQuery = input.relatedId ? dupeQuery.eq('related_id', input.relatedId) : dupeQuery.eq('title', title);

  const { data: existing, error: dupeError } = await dupeQuery;
  if (dupeError) {
    // A failed dedupe read would let every recipient through and re-notify the
    // whole family. Fail the call instead of shipping the duplicate storm.
    console.error('[service:notifications] duplicate read failed', dupeError);
    return fail(describeDbError(dupeError, 'Could not send that notification.'), { code: SERVICE_CODES.db });
  }
  const alreadyNotified = new Set((existing ?? []).map((row) => row.user_id ?? 'family'));

  const targets = userIds.filter((id) => !alreadyNotified.has(id ?? 'family'));
  const duplicates = userIds.length - targets.length;
  if (targets.length === 0) return ok({ created: 0, ids: [], duplicates, skippedMemberIds, deferred: 0 });

  // ── Quiet hours ───────────────────────────────────────────────────────────
  //
  // The window comes from `family_ai_settings` (0257), which is family-scoped
  // and therefore readable for EVERY recipient on every path — including the
  // service-role cron that sends most notifications.
  //
  // It used to come from `user_preferences.notification_prefs.quietHours`, and
  // that could never have worked: `0004` makes `user_preferences` own-row-only,
  // so a lookup of the RECIPIENTS' rows returns at most the SENDER's. A parent
  // notifying a teen read the parent's preference and applied it to the teen,
  // or more often read nothing at all. One family window is a weaker promise
  // than a per-person one, and it is a promise the database can actually keep.
  const { sendAt: resolvedSendAt, deferred: wasDeferred } =
    await deliveryTimeFor(scope, { sendAt: input.sendAt, urgent: input.urgent });

  let deferred = 0;
  const rows = targets.map((userId) => {
    if (wasDeferred) deferred += 1;
    return {
      family_id: scope.familyId,
      user_id: userId,
      type: input.type,
      title,
      body: input.body?.trim() || null,
      related_type: input.relatedType ?? null,
      related_id: input.relatedId ?? null,
      send_at: resolvedSendAt,
    };
  });

  const { data, error } = await scope.db.from('notifications').insert(rows).select('id');
  if (error) {
    console.error('[service:notifications] insert failed', error);
    return fail(describeDbError(error, 'Could not send that notification.'), { code: SERVICE_CODES.db });
  }
  return ok({ created: (data ?? []).length, ids: (data ?? []).map((r) => r.id), duplicates, skippedMemberIds, deferred });
}

/**
 * Resolve recipients to `notifications.user_id` values. A `null` entry is the
 * family-wide row the table models with a NULL user_id; member ids without a
 * login are reported back rather than dropped silently, because "we told
 * everyone" and "we told everyone who has an account" are different claims.
 */
async function resolveRecipients(
  scope: ServiceScope,
  recipients: NotifyRecipients,
): Promise<ServiceResult<{ userIds: (string | null)[]; skippedMemberIds: string[] }>> {
  if (recipients === 'family') return ok({ userIds: [null], skippedMemberIds: [] });

  const { data, error } = await scope.db
    .from('family_members')
    .select('id, user_id, role')
    .eq('family_id', scope.familyId)
    .eq('is_active', true);
  if (error) {
    console.error('[service:notifications] member read failed', error);
    return fail(describeDbError(error, 'Could not work out who to notify.'), { code: SERVICE_CODES.db });
  }

  const members = data ?? [];
  const wanted = recipients === 'managers'
    ? members.filter((m) => isManager(m.role))
    : members.filter((m) => recipients.includes(m.id));

  const userIds: (string | null)[] = [];
  const skippedMemberIds: string[] = [];
  for (const member of wanted) {
    if (member.user_id) userIds.push(member.user_id);
    else skippedMemberIds.push(member.id);
  }
  return ok({ userIds: [...new Set(userIds)], skippedMemberIds });
}

/**
 * Quiet-hour preferences for the recipients, keyed by auth user id.
 *
 * `user_preferences` is own-row-only under RLS (0004), so a caller's client
 * can only see its own row while the service client used by crons sees them
 * all. Since scheduled delivery is exactly where quiet hours matter, that is
 * the right side of the trade. A read failure logs and returns nothing:
 * delivering a notification at a slightly wrong time is better than not
 * delivering it, so this degrades rather than fails.
 */
async function familyQuietHours(scope: ServiceScope): Promise<QuietHours | null> {
  try {
    const settings = await getAISettings(scope);
    const quiet = settings.quietHours;
    if (!quiet) return null;
    // Same shape check the old per-user parser applied, because the value comes
    // from two integer columns rather than a validated object.
    if (!Number.isInteger(quiet.start) || !Number.isInteger(quiet.end)) return null;
    if (quiet.start < 0 || quiet.start > 23 || quiet.end < 0 || quiet.end > 23) return null;
    if (quiet.start === quiet.end) return null;
    return quiet;
  } catch (error) {
    // Fail OPEN. A settings read that failed is not a reason to hold someone's
    // notification until morning; it is a reason to send it and move on.
    console.error('[service:notifications] quiet-hours read failed', error);
    return null;
  }
}

/** Mark one notification read for the acting user. */
export async function markRead(scope: ServiceScope, notificationId: string): Promise<ServiceResult<{ id: string }>> {
  const { data, error } = await scope.db
    .from('notifications')
    .update({ is_read: true })
    .eq('id', notificationId)
    .eq('family_id', scope.familyId)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[service:notifications] mark read failed', error);
    return fail(describeDbError(error, 'Could not update that notification.'), { code: SERVICE_CODES.db });
  }
  if (!data) return fail('That notification could not be found.', { code: SERVICE_CODES.notFound });
  return ok({ id: data.id });
}

/**
 * Unread notifications for the acting user, plus the family-wide ones.
 * Rows whose `send_at` is still in the future are withheld — that is what a
 * quiet-hours deferral has to mean at read time as well as at push time.
 *
 * `priority` narrows the read to one half of the queue. There is no priority
 * COLUMN (see lib/notifications/priority.ts for the migration this is standing
 * in for), so the filter is on `type` — which is exactly what the classifier
 * uses, so a caller asking for 'digest' gets the same rows the Daily Brief will
 * fold and the bell will not count. 'now' is expressed as NOT-in rather than
 * in, so a notification type added later still reaches the surfaces that
 * interrupt.
 */
export async function listUnread(
  scope: ServiceScope,
  opts?: { limit?: number; priority?: NotificationPriority },
): Promise<ServiceResult<Notification[]>> {
  const nowIso = scopeNow(scope).toISOString();
  let query = scope.db
    .from('notifications')
    .select('*')
    .eq('family_id', scope.familyId)
    .eq('is_read', false)
    .lte('send_at', nowIso)
    .order('send_at', { ascending: false })
    .limit(Math.min(Math.max(opts?.limit ?? 50, 1), 200));
  if (opts?.priority === 'digest') query = query.in('type', [...DIGEST_NOTIFICATION_TYPES]);
  else if (opts?.priority === 'now') query = query.not('type', 'in', `(${DIGEST_NOTIFICATION_TYPES.join(',')})`);
  // A cron scope has no user of its own; it reads the whole family's queue.
  if (scope.userId) query = query.or(`user_id.eq.${scope.userId},user_id.is.null`);

  const { data, error } = await query;
  if (error) {
    console.error('[service:notifications] unread read failed', error);
    return fail(describeDbError(error, 'Could not load your notifications.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

// The morning brief, delivered.
//
// `buildBrief` composes; the page shows; nothing, until now, SENT. A brief
// nobody is told about is a page a parent has to remember to open, which is
// the opposite of work removed. This module runs from the notifications cron:
// for every family it reads the same rows the API route reads, composes the
// same brief, and files ONE notification for the managers with the headline
// and what needs deciding.
//
// ONCE PER FAMILY PER DAY. The notification's `related_id` is
// `brief:<family-local day>`, and it is sent with `notify()`'s `once` guard,
// which drops a second copy whether or not the first was read. A cron that
// re-runs, a retry, a manual dispatch: none of them can say the morning brief
// twice. A cheap read of that key for each manager comes first, so a re-run
// costs a query or three per family rather than the ten the brief needs.
//
// WHEN IT LANDS. The cron is daily at 11:00 UTC (vercel.json — the Hobby plan
// allows nothing more frequent), which is 7am in New York, 4am in Los
// Angeles and 11pm in Auckland. So the delivery instant is the family's:
// before 7am local it is filed for 7am today; between 7am and 6pm it goes
// now; after 6pm the brief is composed for TOMORROW and filed for 7am then.
// The scope's clock is set to that instant, so quiet hours still apply to it
// (`deliveryTimeFor` reads `scope.now`), and push and email both wait for
// `send_at` — a brief filed for 7am is not pushed at 4am.
//
// FAIL CLOSED. A read that errors means no brief for that family this tick,
// logged under `[briefing]`. A brief built on a failed read would say "a quiet
// day" about a day that was not, and that is the one thing the brief may
// never do.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConciergeSnapshot } from '@/lib/concierge/digest';
import type { Database } from '@/lib/database.types';
import type { AiActivityRow, CompletedRunRow } from '@/lib/home/today';
import type { NeedsReader } from '@/lib/home/needs-sources';
import { isManager } from '@/lib/constants/roles';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import { notify } from '@/lib/services/notifications';
import { claimLease, releaseLease } from '@/lib/server/app-settings-lease';
import { sweepFamilies } from '@/lib/server/cron-family-sweep';
import { readAll } from '@/lib/supabase/read-all';
import { dayKeyInTz, hourInTz, scopeForSystem, zonedDayBoundsMs, zonedTimeMs } from '@/lib/services/scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { buildBrief, type Brief } from './build';
import { readBriefDecisions } from './decisions';
import { medicationsDueOn, weekdayOf, type MedicationScheduleRow } from './sources';
import { briefingCalendarBounds } from './calendar-window';
import { projectCalendarWindow } from '@/lib/calendar/consumer-spans';
import { readDisplayCalendarOccurrences } from '@/lib/calendar/display-occurrences';
import { settleAll } from '@/lib/supabase/settle';

type DB = SupabaseClient<Database>;

/** The family-local hour a morning brief is for. */
export const MORNING_HOUR = 7;
/** Past this local hour a tick composes tomorrow's brief instead of a stale one for today. */
export const LAST_MORNING_HOUR = 18;

/** `notifications.related_type` for a brief; `related_id` is `briefRelatedId(day)`. */
export const BRIEF_RELATED_TYPE = 'brief';

export function briefRelatedId(dayKey: string): string {
  return `brief:${dayKey}`;
}

export type MorningTarget = {
  /** The instant the brief is composed for and filed at. */
  at: Date;
  /** The family-local day the brief is for, `YYYY-MM-DD`. */
  dayKey: string;
};

/**
 * When a family's morning brief lands, given the instant the cron ticked.
 * Pure, so the three cases above can be pinned without a database.
 */
export function morningTarget(now: Date, tz: string): MorningTarget {
  const hour = hourInTz(now, tz);
  const todayKey = dayKeyInTz(now, tz);
  const at = (dayKey: string) => {
    const ms = zonedTimeMs(dayKey, MORNING_HOUR, 0, tz);
    return new Date(Number.isFinite(ms) ? ms : now.getTime());
  };
  if (hour < MORNING_HOUR) return { at: at(todayKey), dayKey: todayKey };
  if (hour < LAST_MORNING_HOUR) return { at: now, dayKey: todayKey };
  const tomorrowKey = dayKeyInTz(new Date(zonedDayBoundsMs(todayKey, tz).end + 3600_000), tz);
  return { at: at(tomorrowKey), dayKey: tomorrowKey };
}

/** The notification's title: the headline the page would show, named as the brief. */
export function morningBriefTitle(brief: Brief): string {
  return `Morning brief: ${brief.headline}`;
}

/** The body: the decisions, by name, because they are why the brief is worth opening. */
export function morningBriefBody(brief: Brief): string | null {
  if (brief.decisions.length === 0) return null;
  const shown = brief.decisions.slice(0, 3).map((d) => `• ${d.title}`);
  const more = brief.decisions.length - shown.length;
  if (more > 0) shown.push(`+${more} more waiting on you`);
  return shown.join('\n');
}

/**
 * Who the morning brief's decision titles are worded for — and the honest answer
 * is "nobody in particular", which is why this is spelled out rather than
 * defaulted.
 *
 * A money approval's title carries its amount, so it needs a reader's locale.
 * This runs from a cron: there is no request, so no cookie and no
 * Accept-Language, and no member or family table stores a language choice yet —
 * it lives only in the LOCALE_COOKIE (lib/i18n/locales.ts), which a cron never
 * sees. So the brief a manager is notified with is written in the SOURCE locale,
 * explicitly: 'en-US' for the amount, the English catalogue for the words. When a
 * per-member or per-family locale column lands (finalaudit I18N-001), this is the
 * line that reads it — per recipient, since `notify` fans out to every manager.
 */
const MORNING_BRIEF_READER: NeedsReader = {
  locale: 'en-US',
  t: (key, params) => translate(SOURCE_MESSAGES, key, params),
};

/**
 * Compose the brief the cron sends, from the family's rows. Manager view —
 * the recipients are the managers — under a system scope whose clock is the
 * delivery instant.
 */
export async function readMorningBrief(scope: ServiceScope, target: MorningTarget): Promise<ServiceResult<Brief>> {
  const { db, familyId, tz } = scope;
  const dayKey = target.dayKey;
  const bounds = zonedDayBoundsMs(dayKey, tz);
  const horizon = dayKeyInTz(new Date(target.at.getTime() + 30 * 86_400_000), tz);
  // "Already handled" is what finished since yesterday's local midnight — a
  // run from last week is not part of this morning's story.
  const sinceIso = new Date(bounds.start - 24 * 3600_000).toISOString();
  const todayDow = weekdayOf(dayKey);

  const [events, members, bills, meds, maintenance, warranties, trips, pantry, runs, activity] = await settleAll([
    // Series included: the pushed brief lists every week of a weekly event (lib/calendar/occurrences.ts).
    readDisplayCalendarOccurrences(db, familyId, briefingCalendarBounds(dayKey, tz, 0, 7), tz, { overlap:true }),
    db.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    db.from('bills').select('name, amount, due_date, status')
      .eq('family_id', familyId).neq('status', 'paid').lte('due_date', horizon).order('due_date').limit(20),
    db.from('medication_schedules').select('time_of_day, days_of_week, starts_on, ends_on, medications(name, member_id, is_active)')
      .eq('family_id', familyId).lte('starts_on', dayKey).limit(40),
    // On an open repeating task, completed_at records the last completion.
    db.from('maintenance_tasks').select('title, due_at, status, completed_at')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress'])
      .not('due_at', 'is', null).lte('due_at', `${horizon}T23:59:59.999Z`).order('due_at').limit(20),
    // A deleted warranty is soft-deleted (`deleted_at`), like on every other reader of this table.
    db.from('home_warranties').select('name, expires_on')
      .eq('family_id', familyId).is('deleted_at', null).not('expires_on', 'is', null).lte('expires_on', horizon).order('expires_on').limit(20),
    db.from('vacations').select('title, destination, start_date, end_date, status')
      .eq('family_id', familyId).not('status', 'in', '("completed","cancelled")').not('start_date', 'is', null).limit(20),
    db.from('pantry_items').select('name, expires_at')
      .eq('family_id', familyId).not('expires_at', 'is', null).lte('expires_at', horizon).order('expires_at').limit(25),
    db.from('family_automation_runs').select('id, summary, state, progress, completed_at, updated_at')
      .eq('family_id', familyId).in('state', ['completed', 'partially_completed']).gte('completed_at', sinceIso)
      .order('completed_at', { ascending: false, nullsFirst: false }).limit(6),
    db.from('agent_activity').select('id, title, detail, href, created_at')
      .eq('family_id', familyId).eq('kind', 'action').eq('status', 'done').gte('created_at', sinceIso)
      .order('created_at', { ascending: false }).limit(5),
  ]);

  for (const [label, res] of [
    ['calendar', events], ['members', members], ['bills', bills], ['medications', meds], ['maintenance', maintenance],
    ['warranties', warranties], ['trips', trips], ['pantry', pantry], ['completed runs', runs], ['agent activity', activity],
  ] as const) {
    if (res.error) {
      console.error(`[briefing] morning brief ${label} read failed`, { familyId, error: res.error });
      return fail(`Bubaly could not read the family's ${label}.`, { code: SERVICE_CODES.db, retryable: true });
    }
  }

  const decisions = await readBriefDecisions(scope, MORNING_BRIEF_READER);
  if (!decisions.ok) return decisions;

  const names = new Map((members.data ?? []).map((m) => [m.id, m.display_name]));
  const snapshot: Omit<ConciergeSnapshot, 'now'> = {
    bills: (bills.data ?? []).map((b) => ({ name: b.name, amount: b.amount, dueDate: b.due_date, status: b.status })),
    medications: medicationsDueOn((meds.data ?? []) as unknown as MedicationScheduleRow[], {
      today: dayKey, todayDow, memberName: (id) => names.get(id),
    }),
    maintenance: (maintenance.data ?? []).map((m) => ({ title: m.title, dueAt: m.due_at })),
    warranties: (warranties.data ?? []).map((w) => ({ name: w.name, expiresOn: w.expires_on })),
    trips: (trips.data ?? []).map((t) => ({ title: t.title, startDate: t.start_date, endDate: t.end_date, destination: t.destination })),
    pantry: (pantry.data ?? []).map((p) => ({ name: p.name, expiresAt: p.expires_at })),
  };

  try {
    const eventWindow=briefingCalendarBounds(dayKey,tz,0,7);
    projectCalendarWindow(events.data??[],eventWindow.allDayFromDay,eventWindow.allDayToDay,tz);
    return ok(buildBrief({
    kind: 'daily',
    now: target.at,
    events: (events.data ?? []).map((e) => ({ title: e.title??'', start: e.starts_at, end: e.ends_at, allDay: e.all_day, location: e.location,reference:e.reference,occurrenceKey:e.occurrenceKey,kind:e.kind,transparency:e.transparency,actualStartsAt:e.actualStartsAt,actualEndsAt:e.actualEndsAt,startDate:e.startDate,endDate:e.endDate })),
    snapshot,
    completedRuns: (runs.data ?? []) as CompletedRunRow[],
    activity: (activity.data ?? []) as AiActivityRow[],
    decisions: decisions.data.items,
  }, tz)); } catch { return fail("Bubaly could not read the family's calendar.", {code:SERVICE_CODES.db,retryable:true}); }
}

export type MorningDeliveryResult = {
  /** Families for which a brief notification was created this tick. */
  delivered: number;
  /** Families considered. */
  families: number;
  /** Families whose brief for the day was already filed, or that have no manager account to tell. */
  skipped: number;
  /** Families a read or the write failed for; each is logged. */
  failed: number;
};

type Outcome = 'delivered' | 'skipped' | 'failed';

/**
 * How long one tick's claim on a family's brief stands without a release:
 * longer than composing and filing one takes, short enough that a tick killed
 * in between delays the brief by minutes, not a day.
 */
export const MORNING_BRIEF_CLAIM_MS = 10 * 60_000;

async function deliverMorningBrief(db: DB, family: { id: string; timezone: string | null }, now: Date): Promise<Outcome> {
  const tz = family.timezone || 'UTC';
  const target = morningTarget(now, tz);
  const relatedId = briefRelatedId(target.dayKey);

  // Already filed means every manager already has today's: the rule notify()'s
  // `once` guard applies, recipient by recipient, below. It used to be ANY row
  // of the family under this key, and 0388 lets any member file a notification
  // addressed to themselves with any related_type and related_id, so a child's
  // own row under `brief:<day>`, filed for each day ahead, skipped every
  // manager's brief on each of those days. A member's own row now covers that
  // member alone, and a child or a guest is not someone the brief goes to.
  const { data: members, error: membersError } = await db
    .from('family_members')
    .select('user_id, role')
    .eq('family_id', family.id)
    .eq('is_active', true);
  if (membersError) {
    console.error('[briefing] morning brief recipient read failed', { familyId: family.id, error: membersError });
    return 'failed';
  }
  const managers = [...new Set((members ?? []).filter((m) => m.user_id && isManager(m.role)).map((m) => m.user_id as string))];
  const filed = await settleAll(managers.map((userId) => db
    .from('notifications')
    .select('id')
    .eq('family_id', family.id)
    .eq('related_type', BRIEF_RELATED_TYPE)
    .eq('related_id', relatedId)
    .eq('user_id', userId)
    .order('id')
    .limit(1)));
  const priorError = filed.find((read) => read.error)?.error;
  if (priorError) {
    // Without the dedupe read a re-run would tell every manager twice; skip
    // the family this tick rather than ship the duplicate.
    console.error('[briefing] morning brief dedupe read failed', { familyId: family.id, error: priorError });
    return 'failed';
  }
  if (managers.length > 0 && filed.every((read) => (read.data ?? []).length > 0)) return 'skipped';

  // The day is CLAIMED, not merely read. "Once per family per day" was the read
  // above followed by notify()'s own read-then-insert, and `notifications` has
  // no unique key to refuse a second writer — so two ticks in the same minute
  // (both schedulers fire /api/cron/notifications at 11:00) both passed both
  // reads and every manager got two briefs and two pushes. The lease is one
  // row per family in app_settings (lib/server/app-settings-lease.ts): of two
  // concurrent ticks exactly one composes and files; the other finds it held
  // and skips, as it skips a brief already filed. A tick that dies holding it
  // frees it by expiry; a tick that finishes releases it.
  const leaseKey = `morning_brief_claim:v1:family:${family.id}`;
  const lease = await claimLease(db, leaseKey, { ttlMs: MORNING_BRIEF_CLAIM_MS, now });
  if (!lease.claimed) {
    if (lease.reason === 'held') return 'skipped';
    console.error('[briefing] morning brief claim could not be taken', { familyId: family.id });
    return 'failed';
  }
  try {
    const scope = scopeForSystem(db, family, { now: target.at });
    const brief = await readMorningBrief(scope, target);
    if (!brief.ok) return 'failed';

    const sent = await notify(scope, {
      recipients: 'managers',
      type: 'system',
      title: morningBriefTitle(brief.data),
      body: morningBriefBody(brief.data),
      relatedType: BRIEF_RELATED_TYPE,
      relatedId,
      once: true,
    });
    if (!sent.ok) {
      console.error('[briefing] morning brief notify failed', { familyId: family.id, error: sent.error });
      return 'failed';
    }
    return sent.data.created > 0 ? 'delivered' : 'skipped';
  } finally {
    await releaseLease(db, leaseKey, lease.token);
  }
}

/**
 * The brief pass's share of its cron's time (app/api/cron/notifications). Push
 * dispatch and the email digests run AFTER this pass, so a pass that awaited
 * every family in turn, with no clock and no per-family limit, spent the slice
 * the route keeps for delivering what is already queued — one hung read, or
 * enough families, and nothing was pushed or emailed that tick. With a budget
 * the pass stops STARTING families once `budgetMs` has passed since
 * `startedAt` (the route's own start, so a long generation pass shrinks this
 * one rather than pushing delivery out), and a family whose brief outlives
 * `familyTimeoutMs` is that family's failure. Both are counted in `failed`.
 */
export type MorningDeliveryBudget = { startedAt: number; budgetMs: number; familyTimeoutMs: number; concurrency: number };

const DAY_MS = 86_400_000;

/** The cron step: one morning brief per family per family-local day. */
export async function deliverMorningBriefs(db: DB, now: Date = new Date(), budget?: MorningDeliveryBudget): Promise<MorningDeliveryResult> {
  const result: MorningDeliveryResult = { delivered: 0, families: 0, skipped: 0, failed: 0 };
  // Every family, not the first 1,000: an unbounded select is capped by
  // PostgREST's db-max-rows and says nothing about it, so family 1,001 onwards
  // would silently never get a brief while `result.families` reported the job
  // complete. The sibling notification crons page for exactly this reason.
  const { rows: families, error } = await readAll<{ id: string; timezone: string | null }>((from, to) =>
    // OPEN families only: a closed account (families.closed_at) gets no brief.
    db.from('families').select('id, timezone').is('closed_at', null).order('id').range(from, to));
  if (error) {
    console.error('[briefing] morning brief families read failed', error);
    result.failed += 1;
    return result;
  }
  result.families = (families ?? []).length;
  // Rotated by the day (lib/server/cron-family-sweep.ts), so a pass the budget
  // cuts short does not leave the same tail without a brief every morning.
  // Without a budget, one family may take as long as its claim stands: past
  // that the claim has expired and another tick may compose the same brief.
  const swept = await sweepFamilies(families ?? [], {
    budgetMs: budget?.budgetMs ?? Number.POSITIVE_INFINITY,
    itemTimeoutMs: budget?.familyTimeoutMs ?? MORNING_BRIEF_CLAIM_MS,
    concurrency: budget?.concurrency ?? 1,
    startedAt: budget?.startedAt,
    runIndex: Math.floor(now.getTime() / DAY_MS),
  }, async (family, counted) => {
    let outcome: Outcome;
    try {
      outcome = await deliverMorningBrief(db, family, now);
    } catch (e) {
      console.error('[briefing] morning brief delivery failed', { familyId: family.id, error: e });
      outcome = 'failed';
    }
    // A brief that answers after its timeout was already counted as failed.
    if (counted.current) result[outcome] += 1;
  });
  for (const family of swept.timedOut) {
    result.failed += 1;
    console.error('[briefing] morning brief gave up waiting for a family', { familyId: family.id });
  }
  if (swept.unreached.length > 0) {
    result.failed += swept.unreached.length;
    console.error(`[briefing] budget reached with ${swept.unreached.length} families without a brief`, swept.unreached.slice(0, 50).map((f) => f.id));
  }
  return result;
}

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
// twice. A cheap read of that key comes first so a re-run costs one query per
// family rather than the ten the brief needs.
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
import { notify } from '@/lib/services/notifications';
import { dayKeyInTz, hourInTz, scopeForSystem, zonedDayBoundsMs, zonedTimeMs } from '@/lib/services/scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { buildBrief, type Brief } from './build';
import { readBriefDecisions } from './decisions';
import { medicationsDueOn, weekdayOf, type MedicationScheduleRow } from './sources';
import { briefingCalendarWindow } from './calendar-window';

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

  const [events, members, bills, meds, maintenance, warranties, trips, pantry, runs, activity] = await Promise.all([
    db.from('calendar_events').select('title, starts_at, ends_at, all_day, location')
      .eq('family_id', familyId).or(briefingCalendarWindow(dayKey, tz, 0, 7)).order('starts_at').limit(100),
    db.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    db.from('bills').select('name, amount, due_date, status')
      .eq('family_id', familyId).neq('status', 'paid').lte('due_date', horizon).order('due_date').limit(20),
    db.from('medication_schedules').select('time_of_day, days_of_week, starts_on, ends_on, medications(name, member_id, is_active)')
      .eq('family_id', familyId).lte('starts_on', dayKey).limit(40),
    db.from('maintenance_tasks').select('title, due_at, status, completed_at')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress']).is('completed_at', null)
      .not('due_at', 'is', null).lte('due_at', `${horizon}T23:59:59.999Z`).order('due_at').limit(20),
    db.from('home_warranties').select('name, expires_on')
      .eq('family_id', familyId).not('expires_on', 'is', null).lte('expires_on', horizon).order('expires_on').limit(20),
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

  const decisions = await readBriefDecisions(scope);
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

  return ok(buildBrief({
    kind: 'daily',
    now: target.at,
    events: (events.data ?? []).map((e) => ({ title: e.title, start: e.starts_at, end: e.ends_at, allDay: e.all_day, location: e.location })),
    snapshot,
    completedRuns: (runs.data ?? []) as CompletedRunRow[],
    activity: (activity.data ?? []) as AiActivityRow[],
    decisions: decisions.data.items,
  }, tz));
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

async function deliverMorningBrief(db: DB, family: { id: string; timezone: string | null }, now: Date): Promise<Outcome> {
  const tz = family.timezone || 'UTC';
  const target = morningTarget(now, tz);
  const relatedId = briefRelatedId(target.dayKey);

  const { data: prior, error: priorError } = await db
    .from('notifications')
    .select('id')
    .eq('family_id', family.id)
    .eq('related_type', BRIEF_RELATED_TYPE)
    .eq('related_id', relatedId)
    .limit(1);
  if (priorError) {
    // Without the dedupe read a re-run would tell every manager twice; skip
    // the family this tick rather than ship the duplicate.
    console.error('[briefing] morning brief dedupe read failed', { familyId: family.id, error: priorError });
    return 'failed';
  }
  if ((prior ?? []).length > 0) return 'skipped';

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
}

/** The cron step: one morning brief per family per family-local day. */
export async function deliverMorningBriefs(db: DB, now: Date = new Date()): Promise<MorningDeliveryResult> {
  const result: MorningDeliveryResult = { delivered: 0, families: 0, skipped: 0, failed: 0 };
  const { data: families, error } = await db.from('families').select('id, timezone');
  if (error) {
    console.error('[briefing] morning brief families read failed', error);
    result.failed += 1;
    return result;
  }
  for (const family of families ?? []) {
    result.families += 1;
    try {
      result[await deliverMorningBrief(db, family, now)] += 1;
    } catch (e) {
      console.error('[briefing] morning brief delivery failed', { familyId: family.id, error: e });
      result.failed += 1;
    }
  }
  return result;
}

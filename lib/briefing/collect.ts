// lib/briefing/collect.ts — everything `buildBrief` needs, read once.
//
// The Daily Brief had exactly one composer: a POST handler that a page calls
// when somebody opens it. So the brief only existed if a person went looking
// for it — which is the opposite of §49, where the brief is the thing that
// reaches a family before they think to ask.
//
// This is the read half, extracted so the route and the delivery cron compose
// the same brief from the same rows. It is deliberately narrow: the ROWS
// `buildBrief` consumes, and nothing for the model prompt — the route keeps its
// own reads for that, because a prompt and a deterministic brief want different
// things and pretending otherwise is how the two drifted apart before.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ConciergeSnapshot } from '@/lib/concierge/digest';
import type { AiActivityRow, CompletedRunRow } from '@/lib/home/today';
import type { BriefEvent } from '@/lib/onboarding/first-brief';
import { dayKeyInTz, zonedDayBoundsMs } from '@/lib/services/scope';

type DB = SupabaseClient<Database>;

export type BriefSource = {
  /** Today's events, in the family's day. */
  events: BriefEvent[];
  /** The cross-domain sweep's inputs, ready for `buildConciergeDigest`. */
  snapshot: Omit<ConciergeSnapshot, 'now'>;
  completedRuns: CompletedRunRow[];
  activity: AiActivityRow[];
};

/**
 * Read one family's brief inputs. Never throws and never fails the caller: a
 * table that is missing in a partially-migrated environment, or a read that
 * errors, contributes nothing rather than costing the whole brief. A brief with
 * one section missing is worth far more to a family than no brief.
 */
export async function collectBriefSource(
  db: DB,
  args: { familyId: string; tz: string; now: Date },
): Promise<BriefSource> {
  const { familyId, tz, now } = args;
  const today = dayKeyInTz(now, tz);
  const bounds = zonedDayBoundsMs(today, tz);
  const todayStart = new Date(bounds.start).toISOString();
  const todayEnd = new Date(bounds.end - 1).toISOString();
  const weekEndKey = dayKeyInTz(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), tz);
  const horizon = dayKeyInTz(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000), tz);
  // `days_of_week` is a family-day question: at 8pm in Los Angeles `getUTCDay()`
  // has already rolled over, so a family read tomorrow's doses every evening.
  const todayDow = new Date(`${today}T12:00:00Z`).getUTCDay();

  const [members, events, bills, medSchedules, maintenance, warranties, trips, pantry, runs, activity] = await Promise.all([
    db.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    db.from('calendar_events').select('title, starts_at, ends_at, location, all_day')
      .eq('family_id', familyId).gte('starts_at', todayStart).lte('starts_at', todayEnd).order('starts_at').limit(40),
    db.from('bills').select('name, amount, due_date, status')
      .eq('family_id', familyId).neq('status', 'paid').lte('due_date', horizon).order('due_date').limit(20),
    db.from('medication_schedules').select('time_of_day, days_of_week, starts_on, ends_on, medications(name, member_id, is_active)')
      .eq('family_id', familyId).lte('starts_on', today).limit(40),
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
      .eq('family_id', familyId).in('state', ['completed', 'partially_completed'])
      .order('completed_at', { ascending: false, nullsFirst: false }).limit(6),
    db.from('agent_activity').select('id, title, detail, href, created_at')
      .eq('family_id', familyId).eq('kind', 'action').eq('status', 'done').gte('created_at', todayStart)
      .order('created_at', { ascending: false }).limit(5),
  ]);

  const memberNames = new Map((members.data ?? []).map((m) => [m.id, m.display_name]));

  return {
    events: (events.data ?? []).map((e) => ({
      title: e.title,
      start: e.starts_at,
      end: e.ends_at,
      allDay: e.all_day ?? false,
      location: e.location,
    })) as BriefEvent[],
    snapshot: {
      bills: (bills.data ?? []).map((b) => ({ name: b.name, amount: b.amount, dueDate: b.due_date, status: b.status })),
      medications: medicationsDueOn(medSchedules.data ?? [], todayDow, today, memberNames),
      maintenance: (maintenance.data ?? []).map((m) => ({ title: m.title, dueAt: m.due_at })),
      warranties: (warranties.data ?? []).map((w) => ({ name: w.name, expiresOn: w.expires_on })),
      trips: (trips.data ?? []).map((t) => ({ title: t.title, startDate: t.start_date, endDate: t.end_date, destination: t.destination })),
      pantry: (pantry.data ?? []).map((p) => ({ name: p.name, expiresAt: p.expires_at })),
    },
    completedRuns: (runs.data ?? []) as CompletedRunRow[],
    activity: (activity.data ?? []) as AiActivityRow[],
  };
}

type ScheduleRow = {
  time_of_day: string | null;
  days_of_week: number[] | null;
  starts_on: string | null;
  ends_on: string | null;
  medications: { name: string; member_id: string | null; is_active: boolean } | null;
};

/** The doses actually due on the family's day, from their schedule rows. */
export function medicationsDueOn(
  rows: unknown[],
  dayOfWeek: number,
  dayKey: string,
  memberNames: Map<string, string> = new Map(),
): ConciergeSnapshot['medications'] {
  return (rows as ScheduleRow[])
    .filter((s) => s.medications?.is_active !== false)
    .filter((s) => (s.days_of_week ?? [0, 1, 2, 3, 4, 5, 6]).includes(dayOfWeek))
    .filter((s) => !s.ends_on || s.ends_on >= dayKey)
    .map((s) => ({
      name: s.medications?.name ?? 'Medication',
      member: s.medications?.member_id ? memberNames.get(s.medications.member_id) ?? null : null,
      timeOfDay: clockLabel(s.time_of_day),
    }))
    .slice(0, 20);
}

/** "08:00" → "8:00 AM"; the label a person reads, not the column value. */
export function clockLabel(time: string | null): string | null {
  if (!time) return null;
  const [h, m] = time.split(':');
  const hour = Number(h);
  if (!Number.isFinite(hour)) return null;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${m ?? '00'} ${ampm}`;
}

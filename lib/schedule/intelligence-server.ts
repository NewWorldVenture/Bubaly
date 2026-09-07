// lib/schedule/intelligence-server.ts — loads the rows the per-event schedule
// model composes, family-scoped, and hands them to the pure engine.
//
// READ BOUNDARY: this is a fail-closed loader. A failed read of any source
// returns `{ ok: false }` and logs `[schedule] … read failed`; it never answers
// with a partial model, because "no conflicts" computed from half the rows is
// a claim the family would act on. Callers render a retryable error state.
//
// Drive times come from the family's PERSISTED departure plans (Trip
// Intelligence) unless the caller injects a fetcher; nothing is routed over
// the network from here (see lib/trips/routing.ts on why routing is a browser
// call). An event nobody has planned a departure for falls back to the
// category buffer, and the model says which it used.
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { describeDbError } from '@/lib/supabase/errors';
import { departurePlanDriveTime, firstDriveTime, type DriveTimeFetcher } from '@/lib/trips/drive-time';
import { dayKeyInZone } from '@/lib/schedule/zoned';
import {
  buildScheduleIntelligence,
  type CareCoverageWindow, type ScheduleEventRow, type ScheduleIntelligence, type ScheduleMealRow,
  type ScheduleMemberRow, type ScheduleRideRow, type ScheduleVehicleRow,
} from '@/lib/schedule/intelligence';

const DAY = 86_400_000;
const DEFAULT_DURATION_MIN = 60;

export type LoadScheduleOptions = {
  familyId: string;
  /** IANA zone the family lives in. */
  tz: string;
  now?: Date;
  /** Epoch-ms window on `starts_at`; defaults to [now − 6h, now + horizonDays). */
  fromMs?: number;
  toMs?: number;
  horizonDays?: number;
  /** Cap on events read, newest-first is NOT the order — earliest start first. */
  eventLimit?: number;
  /** Tried before the persisted departure plans. */
  driveTime?: DriveTimeFetcher | null;
};

export type LoadScheduleResult =
  | { ok: true; data: ScheduleIntelligence }
  | { ok: false; error: string; retryable: true };

type Db = SupabaseClient<Database>;

export async function loadScheduleIntelligence(db: Db, opts: LoadScheduleOptions): Promise<LoadScheduleResult> {
  const now = opts.now ?? new Date();
  const fromMs = opts.fromMs ?? now.getTime() - 6 * 3600_000;
  const toMs = opts.toMs ?? now.getTime() + (opts.horizonDays ?? 7) * DAY;
  const fromIso = new Date(fromMs).toISOString();
  const toIso = new Date(toMs).toISOString();
  const fromDay = dayKeyInZone(fromMs - DAY, opts.tz) ?? fromIso.slice(0, 10);
  const toDay = dayKeyInZone(toMs + DAY, opts.tz) ?? toIso.slice(0, 10);
  const familyId = opts.familyId;

  const [eventsRes, membersRes, ridesRes, vehiclesRes, mealsRes, sittersRes, plansRes] = await Promise.all([
    db.from('calendar_events')
      .select('id, title, category, location, starts_at, ends_at, all_day, assignee_id, description')
      .eq('family_id', familyId).eq('all_day', false)
      .gte('starts_at', fromIso).lt('starts_at', toIso)
      .order('starts_at', { ascending: true }).limit(opts.eventLimit ?? 200),
    db.from('family_members')
      .select('id, display_name, role, is_active')
      .eq('family_id', familyId).eq('is_active', true).limit(50),
    db.from('rides')
      .select('id, title, ride_date, pickup_time, dropoff_time, driver_id, rider_ids, status, event_id')
      .eq('family_id', familyId).in('status', ['planned', 'confirmed'])
      .gte('ride_date', fromDay).lte('ride_date', toDay).limit(200),
    db.from('vehicles')
      .select('id, nickname, primary_driver')
      .eq('family_id', familyId).is('deleted_at', null).limit(50),
    db.from('meal_plans')
      .select('plan_date, meal_type, meal_id')
      .eq('family_id', familyId).eq('meal_type', 'dinner')
      .gte('plan_date', fromDay).lte('plan_date', toDay).limit(100),
    db.from('babysitter_payments')
      .select('id, babysitter_id, event_id')
      .eq('family_id', familyId).not('event_id', 'is', null)
      .order('created_at', { ascending: false }).limit(200),
    db.from('departure_plans')
      .select('event_id, drive_seconds, traffic_factor, weather_delay_minutes, prep_minutes, park_minutes, buffer_minutes, updated_at')
      .eq('family_id', familyId).not('event_id', 'is', null)
      .order('updated_at', { ascending: false }).limit(200),
  ]);

  for (const [label, res] of [
    ['calendar events', eventsRes], ['family members', membersRes], ['rides', ridesRes], ['vehicles', vehiclesRes],
    ['meal plan', mealsRes], ['sitter bookings', sittersRes], ['departure plans', plansRes],
  ] as const) {
    if (res.error) {
      console.error(`[schedule] ${label} read failed`, res.error);
      return { ok: false, error: describeDbError(res.error), retryable: true };
    }
  }

  const events = (eventsRes.data ?? []) as ScheduleEventRow[];
  const members = (membersRes.data ?? []) as ScheduleMemberRow[];
  const rides = (ridesRes.data ?? []) as ScheduleRideRow[];
  const vehicles = (vehiclesRes.data ?? []) as ScheduleVehicleRow[];
  const meals = (mealsRes.data ?? []) as ScheduleMealRow[];

  // A sitter row linked to an event covers that event's window. Only rows
  // pointing at an event in this window can matter, so the rest are dropped.
  const eventById = new Map(events.map((e) => [e.id, e]));
  const coverage: CareCoverageWindow[] = [];
  for (const row of (sittersRes.data ?? []) as { id: string; babysitter_id: string | null; event_id: string | null }[]) {
    const e = row.event_id ? eventById.get(row.event_id) : undefined;
    if (!e) continue;
    const start = Date.parse(e.starts_at);
    if (!Number.isFinite(start)) continue;
    const parsedEnd = e.ends_at ? Date.parse(e.ends_at) : Number.NaN;
    const end = Number.isFinite(parsedEnd) && parsedEnd > start ? parsedEnd : start + DEFAULT_DURATION_MIN * 60_000;
    coverage.push({
      providerId: row.babysitter_id ?? row.id, label: 'Sitter', kind: 'sitter',
      startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(),
    });
  }

  const driveTime = firstDriveTime(opts.driveTime, departurePlanDriveTime(plansRes.data ?? []));

  const data = await buildScheduleIntelligence(
    { events, members, rides, vehicles, meals, coverage, tz: opts.tz, now, defaultDurationMin: DEFAULT_DURATION_MIN },
    { driveTime },
  );
  return { ok: true, data };
}

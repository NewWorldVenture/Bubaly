// lib/schedule/intelligence.ts — ONE per-event schedule model. PURE + tested.
//
// Five engines already know one thing each about an upcoming event: the moment
// prep bundle (lib/moments/prep.ts) with its static leave-by buffer, the real
// drive-time departure (lib/trips/departure.ts), driver clashes on the ride
// planner (lib/rides/schedule.ts), same-person double-bookings
// (lib/home/conflicts.ts) and the horizon prep plans. Nothing composed them,
// so the family still had to open five modules to learn that Saturday's game
// needs the car at the same time as the recital, that the only free adult is
// the one already down to drive a carpool, and that dinner is planned for the
// exact hour of practice.
//
// This module composes them per event and adds the two constraints no engine
// had: meal timing (the meal plan's dinner against the event window) and care
// coverage (a child's event with every adult busy and no sitter booked).
//
// PURE on purpose: no Supabase, no clock reads, no locale. The caller passes
// the rows, the family timezone, `now`, and — optionally — a drive-time
// fetcher (lib/trips/drive-time.ts). Every insight carries both an English
// `reason` (for lib consumers such as the Today strip) and a catalogue
// `reasonKey` + `params` so a component renders the same fact translated.
// Output order is total (severity → kind → id), so two renders of the same
// rows come out identical.

import { detectConflicts, type ConflictEvent } from '@/lib/home/conflicts';
import { buildMomentPrep, type MomentEvent, type MomentPrep } from '@/lib/moments/prep';
import { driverConflicts, rideWindow, type RideLike } from '@/lib/rides/schedule';
import {
  departureFromEstimate, firstDriveTime,
  type DriveTimeEstimate, type DriveTimeFetcher, type DriveTimeRequest,
} from '@/lib/trips/drive-time';
import { clockInZone, dayKeyInZone, zonedTimeMs } from '@/lib/schedule/zoned';

export type { DriveTimeEstimate, DriveTimeFetcher, DriveTimeRequest };

// ─── Inputs ──────────────────────────────────────────────────────────────────

export type ScheduleEventRow = {
  id: string;
  title: string;
  category: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  assignee_id: string | null;
  description?: string | null;
};

export type ScheduleMemberRow = {
  id: string;
  display_name: string;
  role: string;
  is_active?: boolean;
};

export type ScheduleRideRow = RideLike & { event_id?: string | null };

export type ScheduleVehicleRow = { id: string; nickname?: string | null; primary_driver?: string | null };

/** One `meal_plans` row; only dinners matter here but the mapper filters, not the caller. */
export type ScheduleMealRow = { plan_date: string; meal_type: string; meal_id?: string | null };

/**
 * Someone who can be with a child for a window: a booked sitter (from the
 * sitter rows) or an adult the caller already knows is on duty. Adults in
 * `members` are inferred as available unless busy; this is for the rest.
 */
export type CareCoverageWindow = {
  providerId: string;
  label: string;
  kind: 'sitter' | 'adult' | 'caregiver';
  startsAt: string;
  endsAt: string;
};

export type ScheduleIntelligenceInput = {
  events: ScheduleEventRow[];
  members: ScheduleMemberRow[];
  rides: ScheduleRideRow[];
  vehicles: ScheduleVehicleRow[];
  meals: ScheduleMealRow[];
  coverage: CareCoverageWindow[];
  /** IANA zone the family lives in. Never the server's. */
  tz: string;
  now: Date;
  /** Family-local dinner time; the meal plan carries a date, not an hour. Default 18:00. */
  dinnerHour?: number;
  dinnerMinute?: number;
  /** Minutes an event without an end is assumed to run. Matches `detectConflicts`. */
  defaultDurationMin?: number;
};

// ─── Output ──────────────────────────────────────────────────────────────────

export type ScheduleInsightKind =
  | 'leave_by' | 'driver_conflict' | 'driver_needed' | 'vehicle_conflict' | 'meal_timing' | 'care_gap' | 'double_booking';

export type ScheduleInsightSeverity = 'info' | 'warn' | 'urgent';

export type ScheduleInsight = {
  /** Stable per (kind, event, counterpart): `vehicle_conflict:e1:e2`. */
  id: string;
  eventId: string;
  kind: ScheduleInsightKind;
  severity: ScheduleInsightSeverity;
  /** English, for lib consumers. Components render `t(reasonKey, params)` instead. */
  reason: string;
  reasonKey: string;
  params: Record<string, string | number>;
  /** Where one tap resolves it. */
  href: string;
  /** ISO instant the insight is about (the leave-by, the clash start). */
  at: string | null;
  /** Other rows involved — events, rides, members — for the UI to link. */
  relatedIds: string[];
};

export type EventSchedule = {
  eventId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  prep: MomentPrep;
  leaveBy: { at: string; source: 'drive_time' | 'category_buffer'; travelMinutes: number } | null;
  /** A timed event with a place is a car trip in this product. */
  needsCar: boolean;
  insights: ScheduleInsight[];
};

export type ScheduleIntelligence = {
  events: EventSchedule[];
  /** eventId → its insights (only events that have any). */
  byEvent: Record<string, ScheduleInsight[]>;
  /** eventId → composed departure, for `buildMomentPrep({ departure })`. */
  departures: Record<string, { leaveByISO: string; travelMinutes: number; source: 'drive_time' | 'category_buffer' }>;
};

// ─── Copy ────────────────────────────────────────────────────────────────────

/** English label + catalogue key per reason. `{param}` placeholders match `translate()`. */
const REASONS = {
  leaveBy: { key: 'scheduleInsight.leaveBy', en: 'Leave by {time} — {minutes} min to {location}' },
  leaveByDrive: { key: 'scheduleInsight.leaveByDrive', en: 'Leave by {time} — {minutes} min drive to {location}' },
  leaveNow: { key: 'scheduleInsight.leaveNow', en: 'Time to leave for {location} — {minutes} min door to door' },
  leaveOverdue: { key: 'scheduleInsight.leaveOverdue', en: 'Leave-by for {location} passed at {time}' },
  driverDoubleBooked: { key: 'scheduleInsight.driverDoubleBooked', en: '{driver} is down to drive two rides at once: {ride} and {other}' },
  driverBusy: { key: 'scheduleInsight.driverBusy', en: '{driver} is down to drive for {ride} but has {other} at {time}' },
  driverNeeded: { key: 'scheduleInsight.driverNeeded', en: 'No driver yet for {ride} at {time}' },
  assigneeDriving: { key: 'scheduleInsight.assigneeDriving', en: '{who} is down to drive {ride} at {time}, which overlaps this' },
  vehicleConflictOne: { key: 'scheduleInsight.vehicleConflictOne', en: '{title} and {other} both need a car around {time}, and only one car is on file' },
  vehicleConflictMany: { key: 'scheduleInsight.vehicleConflictMany', en: '{title} and {other} both need a car around {time}, and {count} cars are on file' },
  mealTiming: { key: 'scheduleInsight.mealTiming', en: 'Dinner is planned for {dinner}, but {title} runs {start}–{end}' },
  careGap: { key: 'scheduleInsight.careGap', en: 'No adult is free for {who} during {title} ({start}–{end}) and no sitter is booked' },
  doubleBooked: { key: 'scheduleInsight.doubleBooked', en: '{who} is double-booked: {other} overlaps {title}' },
} as const;

const HREF: Record<ScheduleInsightKind, string> = {
  leave_by: '/dashboard/trip-intel',
  driver_conflict: '/dashboard/rides',
  driver_needed: '/dashboard/rides',
  vehicle_conflict: '/dashboard/rides',
  meal_timing: '/dashboard/meals',
  care_gap: '/wallet/babysitters',
  double_booking: '/dashboard/calendar',
};

const SEVERITY_RANK: Record<ScheduleInsightSeverity, number> = { urgent: 0, warn: 1, info: 2 };
const KIND_RANK: Record<ScheduleInsightKind, number> = {
  care_gap: 0, vehicle_conflict: 1, driver_conflict: 2, double_booking: 3, driver_needed: 4, meal_timing: 5, leave_by: 6,
};

const ADULT_ROLES = new Set(['parent', 'adult', 'caregiver']);
const CHILD_ROLES = new Set(['child']);

function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, token: string) =>
    Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : m);
}

function firstName(name: string): string {
  return (name ?? '').trim().split(/\s+/)[0] || name;
}

type Window = { start: number; end: number };

function overlaps(a: Window, b: Window): boolean {
  return a.start < b.end && b.start < a.end;
}

function eventWindow(e: ScheduleEventRow, defaultDurationMin: number): Window | null {
  const start = Date.parse(e.starts_at);
  if (!Number.isFinite(start)) return null;
  let end = e.ends_at ? Date.parse(e.ends_at) : Number.NaN;
  if (!Number.isFinite(end) || end <= start) end = start + defaultDurationMin * 60_000;
  return { start, end };
}

// ─── Drive-time resolution (the only async step) ─────────────────────────────

/**
 * Resolve a drive-time estimate per located, timed event through the injected
 * fetcher. Fetchers run concurrently; an event the fetcher cannot answer (null
 * or a throw) simply has no entry, which is what makes `compose` fall back to
 * the category buffer for it.
 */
export async function resolveDriveTimes(
  events: ScheduleEventRow[],
  driveTime: DriveTimeFetcher | null | undefined,
): Promise<Record<string, DriveTimeEstimate>> {
  const out: Record<string, DriveTimeEstimate> = {};
  if (!driveTime) return out;
  const fetcher = firstDriveTime(driveTime);
  const located = events.filter((e) => !e.all_day && e.location && e.location.trim() && Number.isFinite(Date.parse(e.starts_at)));
  const results = await Promise.all(located.map((e) =>
    fetcher({ eventId: e.id, title: e.title, location: e.location!.trim(), startsAt: e.starts_at })));
  located.forEach((e, i) => { const est = results[i]; if (est) out[e.id] = est; });
  return out;
}

/** The whole model: resolve drive times, then compose. */
export async function buildScheduleIntelligence(
  input: ScheduleIntelligenceInput,
  opts: { driveTime?: DriveTimeFetcher | null } = {},
): Promise<ScheduleIntelligence> {
  const driveTimes = await resolveDriveTimes(input.events, opts.driveTime);
  return composeScheduleIntelligence(input, driveTimes);
}

// ─── Composition (sync, deterministic) ───────────────────────────────────────

export function composeScheduleIntelligence(
  input: ScheduleIntelligenceInput,
  driveTimes: Record<string, DriveTimeEstimate> = {},
): ScheduleIntelligence {
  const { tz } = input;
  const nowMs = input.now.getTime();
  const defaultDuration = input.defaultDurationMin ?? 60;
  const dinnerHour = input.dinnerHour ?? 18;
  const dinnerMinute = input.dinnerMinute ?? 0;

  const memberById = new Map(input.members.map((m) => [m.id, m]));
  const memberName = (id: string | null | undefined) => {
    const m = id ? memberById.get(id) : undefined;
    return m ? firstName(m.display_name) : 'Someone';
  };

  // Timed events that are still ahead (or running), in start order. All-day
  // rows carry no time to reason about; past rows are history.
  const timed = input.events
    .map((e) => ({ e, w: eventWindow(e, defaultDuration) }))
    .filter((x): x is { e: ScheduleEventRow; w: Window } => x.w !== null && !x.e.all_day && x.w.end >= nowMs)
    .sort((a, b) => a.w.start - b.w.start || a.e.id.localeCompare(b.e.id));

  // Rides with a placeable window, plus the planner's own driver clash set.
  const liveRides = input.rides.filter((r) => r.status !== 'cancelled' && r.status !== 'completed');
  const rideWindows = liveRides
    .map((r) => ({ r, w: rideWindow(r, tz, defaultDuration) }))
    .filter((x): x is { r: ScheduleRideRow; w: NonNullable<ReturnType<typeof rideWindow>> } => x.w !== null);
  const clashingRides = driverConflicts(liveRides);

  // Same-person double-bookings across the whole set (clusters, not pairs).
  const conflictInput: ConflictEvent[] = timed.map(({ e }) => ({
    id: e.id, title: e.title, starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day, assignee_id: e.assignee_id,
  }));
  const clusters = detectConflicts(conflictInput, defaultDuration);

  // Dinners by family-local day.
  const dinnerDays = new Set(input.meals.filter((m) => m.meal_type === 'dinner').map((m) => m.plan_date));

  // Pass 1 — per-event departure + prep, and the car window each event holds.
  type Built = { e: ScheduleEventRow; w: Window; sched: EventSchedule; carWindow: Window | null };
  const built: Built[] = timed.map(({ e, w }) => {
    const hasLocation = Boolean(e.location && e.location.trim());
    const est = hasLocation ? driveTimes[e.id] : undefined;
    let leaveBy: EventSchedule['leaveBy'] = null;
    if (est) {
      const plan = departureFromEstimate(est, e.starts_at, input.now);
      leaveBy = { at: plan.leaveByISO, source: 'drive_time', travelMinutes: plan.totalTravelMinutes };
    }
    const momentEvent: MomentEvent = {
      id: e.id, title: e.title, category: e.category, location: e.location,
      starts_at: e.starts_at, all_day: e.all_day, description: e.description ?? null,
    };
    const prep = buildMomentPrep(momentEvent, {
      now: input.now,
      departure: leaveBy ? { leaveByISO: leaveBy.at, travelMinutes: leaveBy.travelMinutes } : null,
    });
    if (!leaveBy && prep.leaveByISO) {
      leaveBy = { at: prep.leaveByISO, source: 'category_buffer', travelMinutes: prep.travelBufferMins };
    }
    const needsCar = hasLocation;
    const carWindow = needsCar ? { start: leaveBy ? Date.parse(leaveBy.at) : w.start, end: w.end } : null;
    return {
      e, w, carWindow,
      sched: { eventId: e.id, title: e.title, startsAt: new Date(w.start).toISOString(), endsAt: new Date(w.end).toISOString(), prep, leaveBy, needsCar, insights: [] },
    };
  });

  const vehicleCount = input.vehicles.length;
  const adults = input.members.filter((m) => m.is_active !== false && ADULT_ROLES.has(m.role));

  // Pass 2 — the constraints, each written against the composed windows.
  for (const item of built) {
    const { e, w, sched } = item;
    const out = sched.insights;
    const add = (kind: ScheduleInsightKind, severity: ScheduleInsightSeverity, reason: { key: string; en: string }, params: Record<string, string | number>, extra: { id?: string; at?: string | null; relatedIds?: string[]; href?: string } = {}) => {
      out.push({
        id: extra.id ?? `${kind}:${e.id}`, eventId: e.id, kind, severity,
        reason: fill(reason.en, params), reasonKey: reason.key, params,
        href: extra.href ?? HREF[kind], at: extra.at ?? null, relatedIds: extra.relatedIds ?? [],
      });
    };
    const location = (e.location ?? '').trim();

    // (a) Leave-by — composed from the real drive when known, else the buffer.
    if (sched.leaveBy) {
      const leaveMs = Date.parse(sched.leaveBy.at);
      const minutesUntil = Math.round((leaveMs - nowMs) / 60_000);
      const params = { time: clockInZone(leaveMs, tz), minutes: sched.leaveBy.travelMinutes, location, title: e.title };
      if (minutesUntil < 0) add('leave_by', 'urgent', REASONS.leaveOverdue, params, { at: sched.leaveBy.at });
      else if (minutesUntil <= 5) add('leave_by', 'urgent', REASONS.leaveNow, params, { at: sched.leaveBy.at });
      else if (minutesUntil <= 30) add('leave_by', 'warn', sched.leaveBy.source === 'drive_time' ? REASONS.leaveByDrive : REASONS.leaveBy, params, { at: sched.leaveBy.at });
      else add('leave_by', 'info', sched.leaveBy.source === 'drive_time' ? REASONS.leaveByDrive : REASONS.leaveBy, params, { at: sched.leaveBy.at });
    }

    // (b) Drivers — rides booked for this event, and who is already driving elsewhere.
    const carWindow = item.carWindow ?? w;
    const ridesForEvent = rideWindows.filter(({ r }) => r.event_id === e.id);
    for (const { r, w: rw } of ridesForEvent) {
      if (!r.driver_id) {
        add('driver_needed', 'warn', REASONS.driverNeeded, { ride: r.title, time: clockInZone(rw.start, tz), title: e.title }, { id: `driver_needed:${e.id}:${r.id}`, at: new Date(rw.start).toISOString(), relatedIds: [r.id] });
        continue;
      }
      if (clashingRides.has(r.id)) {
        const other = rideWindows.find((x) => x.r.id !== r.id && x.r.driver_id === r.driver_id && x.r.ride_date === r.ride_date && clashingRides.has(x.r.id));
        add('driver_conflict', 'urgent', REASONS.driverDoubleBooked, { driver: memberName(r.driver_id), ride: r.title, other: other?.r.title ?? 'another ride', title: e.title }, { id: `driver_conflict:${e.id}:${r.id}`, at: new Date(rw.start).toISOString(), relatedIds: [r.id, r.driver_id, ...(other ? [other.r.id] : [])] });
        continue;
      }
      // The driver's own calendar: another event of theirs over the ride.
      const busy = timed.find((x) => x.e.id !== e.id && x.e.assignee_id === r.driver_id && overlaps(x.w, rw));
      if (busy) {
        add('driver_conflict', 'warn', REASONS.driverBusy, { driver: memberName(r.driver_id), ride: r.title, other: busy.e.title, time: clockInZone(busy.w.start, tz), title: e.title }, { id: `driver_conflict:${e.id}:${r.id}`, at: new Date(rw.start).toISOString(), relatedIds: [r.id, r.driver_id, busy.e.id] });
      }
    }
    // The person this event is for is already down to drive a ride that overlaps it.
    if (e.assignee_id) {
      for (const { r, w: rw } of rideWindows) {
        if (r.event_id === e.id || r.driver_id !== e.assignee_id) continue;
        if (!overlaps(rw, carWindow)) continue;
        add('driver_conflict', 'warn', REASONS.assigneeDriving, { who: memberName(e.assignee_id), ride: r.title, time: clockInZone(rw.start, tz), title: e.title }, { id: `driver_conflict:${e.id}:${r.id}`, at: new Date(rw.start).toISOString(), relatedIds: [r.id, e.assignee_id] });
      }
    }

    // (c) Shared vehicle — more concurrent car trips than cars on file.
    // Nothing is claimed when the family has recorded no vehicles: an unknown
    // fleet is not "one car". Same-place trips share a ride and do not count.
    if (item.carWindow && vehicleCount > 0) {
      const concurrent = built.filter((o) => o !== item && o.carWindow && overlaps(o.carWindow, item.carWindow!)
        && (o.e.location ?? '').trim().toLowerCase() !== location.toLowerCase());
      if (concurrent.length + 1 > vehicleCount) {
        for (const o of concurrent) {
          const at = Math.max(item.carWindow.start, o.carWindow!.start);
          add('vehicle_conflict', 'urgent', vehicleCount === 1 ? REASONS.vehicleConflictOne : REASONS.vehicleConflictMany, {
            title: e.title, other: o.e.title, time: clockInZone(at, tz), count: vehicleCount,
          }, { id: `vehicle_conflict:${e.id}:${o.e.id}`, at: new Date(at).toISOString(), relatedIds: [o.e.id] });
        }
      }
    }

    // (d) Dinner timing — the plan's dinner sits inside the event's window.
    const dayKey = dayKeyInZone(w.start, tz);
    if (dayKey && dinnerDays.has(dayKey)) {
      const dinnerStart = zonedTimeMs(dayKey, dinnerHour, dinnerMinute, tz);
      if (Number.isFinite(dinnerStart)) {
        const dinner: Window = { start: dinnerStart, end: dinnerStart + 60 * 60_000 };
        const away: Window = { start: item.carWindow ? item.carWindow.start : w.start, end: w.end };
        if (overlaps(dinner, away)) {
          add('meal_timing', 'warn', REASONS.mealTiming, {
            dinner: clockInZone(dinnerStart, tz), title: e.title, start: clockInZone(w.start, tz), end: clockInZone(w.end, tz),
          }, { at: new Date(dinnerStart).toISOString() });
        }
      }
    }

    // (e) Care gap — a child's event with every adult busy and no sitter booked.
    const child = e.assignee_id ? memberById.get(e.assignee_id) : undefined;
    if (child && CHILD_ROLES.has(child.role) && adults.length > 0) {
      const freeAdult = adults.find((a) => {
        if (a.id === child.id) return false;
        // Driving the child TO this event is coverage, not a clash.
        const busyEvent = timed.some((x) => x.e.id !== e.id && x.e.assignee_id === a.id && overlaps(x.w, w));
        const busyRide = rideWindows.some(({ r, w: rw }) => r.driver_id === a.id && r.event_id !== e.id && overlaps(rw, w));
        return !busyEvent && !busyRide;
      });
      const sitter = input.coverage.find((c) => {
        const s = Date.parse(c.startsAt); const en = Date.parse(c.endsAt);
        return Number.isFinite(s) && Number.isFinite(en) && s <= w.start && en >= w.end;
      });
      if (!freeAdult && !sitter) {
        add('care_gap', 'urgent', REASONS.careGap, {
          who: firstName(child.display_name), title: e.title, start: clockInZone(w.start, tz), end: clockInZone(w.end, tz),
        }, { at: new Date(w.start).toISOString(), relatedIds: [child.id] });
      }
    }

    // (f) Double-booking — the same person in two places (clusters from lib/home/conflicts).
    for (const c of clusters) {
      if (!c.eventIds.includes(e.id)) continue;
      const other = c.eventIds.find((id) => id !== e.id);
      const otherRow = other ? timed.find((x) => x.e.id === other)?.e : undefined;
      if (!otherRow) continue;
      add('double_booking', 'warn', REASONS.doubleBooked, { who: memberName(c.assigneeId), other: otherRow.title, title: e.title }, { id: `double_booking:${e.id}:${otherRow.id}`, at: c.startsAt, relatedIds: c.eventIds.filter((id) => id !== e.id) });
    }

    out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id));
  }

  const events = built.map((b) => b.sched);
  const byEvent: ScheduleIntelligence['byEvent'] = {};
  const departures: ScheduleIntelligence['departures'] = {};
  for (const s of events) {
    if (s.insights.length) byEvent[s.eventId] = s.insights;
    if (s.leaveBy) departures[s.eventId] = { leaveByISO: s.leaveBy.at, travelMinutes: s.leaveBy.travelMinutes, source: s.leaveBy.source };
  }
  return { events, byEvent, departures };
}

/** The single most pressing insight for an event, or null. */
export function topInsight(insights: ScheduleInsight[] | undefined): ScheduleInsight | null {
  if (!insights?.length) return null;
  return [...insights].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id))[0];
}

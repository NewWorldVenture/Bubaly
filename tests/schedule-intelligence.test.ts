// M8 Schedule Intelligence — ONE per-event model. The five engines it composes
// (moment prep, drive-time departure, ride driver clashes, calendar
// double-bookings, horizon prep) each have their own tests; this pins the
// composition and the two constraints that only exist here: dinner timing and
// care coverage. Everything is family-local (New York), nothing reads a clock.
import { describe, expect, it, vi } from 'vitest';
import {
  buildScheduleIntelligence, composeScheduleIntelligence, resolveDriveTimes, topInsight,
  type DriveTimeFetcher, type ScheduleEventRow, type ScheduleIntelligenceInput, type ScheduleInsight,
} from '@/lib/schedule/intelligence';

const TZ = 'America/New_York'; // UTC−4 in September
const NOW = new Date('2026-09-05T14:00:00Z'); // 10:00 local, Saturday
const DAY = '2026-09-05';

const members = [
  { id: 'mom', display_name: 'Maria Rivera', role: 'parent' },
  { id: 'dad', display_name: 'Sam Rivera', role: 'parent' },
  { id: 'kid', display_name: 'Emma Rivera', role: 'child' },
];

function event(over: Partial<ScheduleEventRow> & { id: string }): ScheduleEventRow {
  return {
    title: 'Soccer game', category: 'sports', location: 'City Fields',
    starts_at: '2026-09-05T19:00:00Z', ends_at: '2026-09-05T20:30:00Z', all_day: false, assignee_id: 'kid',
    ...over,
  };
}

function input(over: Partial<ScheduleIntelligenceInput> = {}): ScheduleIntelligenceInput {
  return { events: [], members, rides: [], vehicles: [], meals: [], coverage: [], tz: TZ, now: NOW, ...over };
}

const kinds = (list: ScheduleInsight[] | undefined) => (list ?? []).map((i) => i.kind);

describe('shared vehicle', () => {
  const soccer = event({ id: 'A' });
  // "recital" classifies as school → 20-minute buffer → car needed from 14:55 local.
  const recital = event({ id: 'B', title: 'Piano recital', category: 'general', location: 'Town Hall', starts_at: '2026-09-05T19:15:00Z', ends_at: '2026-09-05T20:00:00Z', assignee_id: 'dad' });

  it('flags two events that need the one car at overlapping leave-by windows', () => {
    const out = composeScheduleIntelligence(input({ events: [soccer, recital], vehicles: [{ id: 'v1', nickname: 'Odyssey' }] }));
    const a = out.byEvent.A?.find((i) => i.kind === 'vehicle_conflict');
    const b = out.byEvent.B?.find((i) => i.kind === 'vehicle_conflict');
    expect(a).toMatchObject({ severity: 'urgent', reasonKey: 'scheduleInsight.vehicleConflictOne', href: '/dashboard/rides', relatedIds: ['B'] });
    expect(a!.params).toMatchObject({ title: 'Soccer game', other: 'Piano recital', count: 1 });
    expect(a!.reason).toContain('only one car is on file');
    expect(b).toMatchObject({ severity: 'urgent', relatedIds: ['A'] });
    // The clash instant is when the second car would be needed: the later leave-by.
    expect(a!.at).toBe('2026-09-05T18:55:00.000Z');
  });

  it('claims nothing when no vehicles are on file, and nothing when there are enough cars', () => {
    expect(kinds(composeScheduleIntelligence(input({ events: [soccer, recital] })).byEvent.A)).not.toContain('vehicle_conflict');
    const two = composeScheduleIntelligence(input({ events: [soccer, recital], vehicles: [{ id: 'v1' }, { id: 'v2' }] }));
    expect(kinds(two.byEvent.A)).not.toContain('vehicle_conflict');
  });

  it('does not count two trips to the same place, or an event without a place', () => {
    const samePlace = composeScheduleIntelligence(input({ events: [soccer, { ...recital, location: 'city fields' }], vehicles: [{ id: 'v1' }] }));
    expect(kinds(samePlace.byEvent.A)).not.toContain('vehicle_conflict');
    const noPlace = composeScheduleIntelligence(input({ events: [soccer, { ...recital, location: null }], vehicles: [{ id: 'v1' }] }));
    expect(kinds(noPlace.byEvent.A)).not.toContain('vehicle_conflict');
    expect(noPlace.events.find((e) => e.eventId === 'B')?.needsCar).toBe(false);
  });

  it('uses the injected drive time for the car window, so a long drive can create the clash', () => {
    // Recital at 15:15 local, but 19:00–21:00 sports game at another field
    // still holds the car from 14:25; with a 90-minute drive to the recital the
    // car is needed from 13:45 — overlapping.
    const late = event({ id: 'B', title: 'Piano recital', location: 'Town Hall', starts_at: '2026-09-05T19:15:00Z', ends_at: '2026-09-05T20:00:00Z', assignee_id: 'dad' });
    const out = composeScheduleIntelligence(input({ events: [soccer, late], vehicles: [{ id: 'v1' }] }), { B: { driveSeconds: 90 * 60, source: 'routed' } });
    const b = out.events.find((e) => e.eventId === 'B')!;
    expect(b.leaveBy).toMatchObject({ source: 'drive_time', travelMinutes: 100 });
    expect(kinds(out.byEvent.B)).toContain('vehicle_conflict');
  });
});

describe('drivers', () => {
  const soccer = event({ id: 'A' });
  const ride = (over: Record<string, unknown>) => ({
    id: 'r', title: 'Ride to soccer', ride_date: DAY, pickup_time: '14:30', dropoff_time: '15:00',
    driver_id: 'mom', rider_ids: ['kid'], status: 'planned' as const, event_id: 'A', ...over,
  });

  it('flags a driver who is already down to drive another ride at the same time', () => {
    const out = composeScheduleIntelligence(input({
      events: [soccer],
      rides: [ride({ id: 'r1' }), ride({ id: 'r2', title: 'Carpool to swim', event_id: null, pickup_time: '14:30', dropoff_time: '15:15' })],
    }));
    const clash = out.byEvent.A?.find((i) => i.kind === 'driver_conflict');
    expect(clash).toMatchObject({ severity: 'urgent', reasonKey: 'scheduleInsight.driverDoubleBooked', href: '/dashboard/rides', id: 'driver_conflict:A:r1' });
    expect(clash!.params).toMatchObject({ driver: 'Maria', ride: 'Ride to soccer', other: 'Carpool to swim' });
    expect(clash!.relatedIds).toEqual(['r1', 'mom', 'r2']);
    expect(clash!.at).toBe('2026-09-05T18:30:00.000Z'); // 14:30 New York
  });

  it("flags a driver whose own calendar overlaps the ride they're down for", () => {
    const work = event({ id: 'C', title: 'Work call', category: 'general', location: null, starts_at: '2026-09-05T18:00:00Z', ends_at: '2026-09-05T19:00:00Z', assignee_id: 'mom' });
    const out = composeScheduleIntelligence(input({ events: [soccer, work], rides: [ride({ id: 'r1' })] }));
    const busy = out.byEvent.A?.find((i) => i.kind === 'driver_conflict');
    expect(busy).toMatchObject({ severity: 'warn', reasonKey: 'scheduleInsight.driverBusy' });
    expect(busy!.params).toMatchObject({ driver: 'Maria', ride: 'Ride to soccer', other: 'Work call', time: '2:00 PM' });
  });

  it('flags the person an event is for when they are down to drive something else over it', () => {
    const dentist = event({ id: 'C', title: 'Dentist', category: 'appointment', location: 'Clinic', starts_at: '2026-09-05T19:00:00Z', ends_at: '2026-09-05T20:00:00Z', assignee_id: 'mom' });
    const out = composeScheduleIntelligence(input({ events: [dentist], rides: [ride({ id: 'r3', title: 'Carpool to swim', event_id: null, pickup_time: '15:10', dropoff_time: '15:40' })] }));
    const driving = out.byEvent.C?.find((i) => i.kind === 'driver_conflict');
    expect(driving).toMatchObject({ severity: 'warn', reasonKey: 'scheduleInsight.assigneeDriving', id: 'driver_conflict:C:r3' });
    expect(driving!.params).toMatchObject({ who: 'Maria', ride: 'Carpool to swim', time: '3:10 PM' });
  });

  it('asks for a driver when the ride booked for the event has none, and ignores finished rides', () => {
    const out = composeScheduleIntelligence(input({
      events: [soccer],
      rides: [ride({ id: 'r1', driver_id: null }), ride({ id: 'r9', status: 'cancelled', driver_id: null })],
    }));
    expect(kinds(out.byEvent.A).filter((k) => k === 'driver_needed')).toEqual(['driver_needed']);
    expect(out.byEvent.A?.find((i) => i.kind === 'driver_needed')).toMatchObject({ severity: 'warn', relatedIds: ['r1'] });
  });

  it('stays quiet when the ride and the calendar agree', () => {
    const out = composeScheduleIntelligence(input({ events: [soccer], rides: [ride({ id: 'r1' })] }));
    expect(kinds(out.byEvent.A)).not.toContain('driver_conflict');
    expect(kinds(out.byEvent.A)).not.toContain('driver_needed');
  });
});

describe('dinner timing', () => {
  const dinner = [{ plan_date: DAY, meal_type: 'dinner', meal_id: 'm1' }];

  it('warns when a 6pm practice runs through the dinner planned for 6', () => {
    const practice = event({ id: 'P', title: 'Hockey practice', location: 'Rink', starts_at: '2026-09-05T22:00:00Z', ends_at: '2026-09-05T23:00:00Z' });
    const out = composeScheduleIntelligence(input({ events: [practice], meals: dinner }));
    const meal = out.byEvent.P?.find((i) => i.kind === 'meal_timing');
    expect(meal).toMatchObject({ severity: 'warn', reasonKey: 'scheduleInsight.mealTiming', href: '/dashboard/meals', at: '2026-09-05T22:00:00.000Z' });
    expect(meal!.params).toEqual({ dinner: '6:00 PM', title: 'Hockey practice', start: '6:00 PM', end: '7:00 PM' });
    expect(meal!.reason).toBe('Dinner is planned for 6:00 PM, but Hockey practice runs 6:00 PM–7:00 PM');
  });

  it('counts the drive there as away time', () => {
    // 6:20 start with a 35-minute sports buffer → out the door at 5:45, inside the dinner hour.
    const practice = event({ id: 'P', title: 'Hockey practice', location: 'Rink', starts_at: '2026-09-05T22:20:00Z', ends_at: '2026-09-05T23:00:00Z' });
    expect(kinds(composeScheduleIntelligence(input({ events: [practice], meals: dinner })).byEvent.P)).toContain('meal_timing');
  });

  it('is quiet for an afternoon event, another day, or a lunch plan', () => {
    const afternoon = event({ id: 'P' });
    expect(kinds(composeScheduleIntelligence(input({ events: [afternoon], meals: dinner })).byEvent.P)).not.toContain('meal_timing');
    const evening = event({ id: 'P', starts_at: '2026-09-05T22:00:00Z', ends_at: '2026-09-05T23:00:00Z' });
    expect(kinds(composeScheduleIntelligence(input({ events: [evening], meals: [{ plan_date: '2026-09-06', meal_type: 'dinner' }] })).byEvent.P)).not.toContain('meal_timing');
    expect(kinds(composeScheduleIntelligence(input({ events: [evening], meals: [{ plan_date: DAY, meal_type: 'lunch' }] })).byEvent.P)).not.toContain('meal_timing');
  });

  it('honours the family dinner hour', () => {
    const evening = event({ id: 'P', starts_at: '2026-09-05T22:00:00Z', ends_at: '2026-09-05T23:00:00Z' });
    const late = composeScheduleIntelligence(input({ events: [evening], meals: dinner, dinnerHour: 19, dinnerMinute: 30 }));
    expect(kinds(late.byEvent.P)).not.toContain('meal_timing');
  });
});

describe('care gap', () => {
  const soccer = event({ id: 'A' });
  const momBusy = event({ id: 'M', title: 'Work call', location: null, starts_at: '2026-09-05T19:00:00Z', ends_at: '2026-09-05T20:00:00Z', assignee_id: 'mom' });
  const dadBusy = event({ id: 'D', title: 'Dentist', location: 'Clinic', starts_at: '2026-09-05T19:30:00Z', ends_at: '2026-09-05T20:00:00Z', assignee_id: 'dad' });

  it("flags a child's event when every adult is busy and no sitter is booked", () => {
    const out = composeScheduleIntelligence(input({ events: [soccer, momBusy, dadBusy] }));
    const gap = out.byEvent.A?.find((i) => i.kind === 'care_gap');
    expect(gap).toMatchObject({ severity: 'urgent', reasonKey: 'scheduleInsight.careGap', href: '/wallet/babysitters', relatedIds: ['kid'], at: '2026-09-05T19:00:00.000Z' });
    expect(gap!.params).toEqual({ who: 'Emma', title: 'Soccer game', start: '3:00 PM', end: '4:30 PM' });
  });

  it('is covered by a sitter window spanning the event', () => {
    const out = composeScheduleIntelligence(input({
      events: [soccer, momBusy, dadBusy],
      coverage: [{ providerId: 's1', label: 'Sitter', kind: 'sitter', startsAt: '2026-09-05T18:30:00Z', endsAt: '2026-09-05T21:00:00Z' }],
    }));
    expect(kinds(out.byEvent.A)).not.toContain('care_gap');
    // A sitter who leaves before the end is not coverage.
    const short = composeScheduleIntelligence(input({
      events: [soccer, momBusy, dadBusy],
      coverage: [{ providerId: 's1', label: 'Sitter', kind: 'sitter', startsAt: '2026-09-05T18:30:00Z', endsAt: '2026-09-05T20:00:00Z' }],
    }));
    expect(kinds(short.byEvent.A)).toContain('care_gap');
  });

  it('is covered by a free adult, or by the adult driving the child there', () => {
    expect(kinds(composeScheduleIntelligence(input({ events: [soccer, momBusy] })).byEvent.A)).not.toContain('care_gap');
    const driving = composeScheduleIntelligence(input({
      events: [soccer, momBusy],
      rides: [{ id: 'r1', title: 'Ride to soccer', ride_date: DAY, pickup_time: '14:30', dropoff_time: '16:30', driver_id: 'dad', rider_ids: ['kid'], status: 'planned', event_id: 'A' }],
    }));
    expect(kinds(driving.byEvent.A)).not.toContain('care_gap');
    // The same ride to somewhere else makes Dad busy.
    const elsewhere = composeScheduleIntelligence(input({
      events: [soccer, momBusy],
      rides: [{ id: 'r1', title: 'Carpool to swim', ride_date: DAY, pickup_time: '14:30', dropoff_time: '16:30', driver_id: 'dad', rider_ids: [], status: 'planned', event_id: null }],
    }));
    expect(kinds(elsewhere.byEvent.A)).toContain('care_gap');
  });

  it("never flags an adult's own event, or a child's event when no adults are on file", () => {
    expect(kinds(composeScheduleIntelligence(input({ events: [dadBusy, momBusy] })).byEvent.D)).not.toContain('care_gap');
    const noAdults = composeScheduleIntelligence(input({ events: [soccer], members: members.filter((m) => m.role === 'child') }));
    expect(kinds(noAdults.byEvent.A)).not.toContain('care_gap');
  });
});

describe('leave-by', () => {
  const soccer = event({ id: 'A' });

  it('uses the injected drive-time fetcher, through the shared departure mapping', async () => {
    const fetcher = vi.fn<DriveTimeFetcher>(async () => ({ driveSeconds: 20 * 60, source: 'routed' }));
    const out = await buildScheduleIntelligence(input({ events: [soccer] }), { driveTime: fetcher });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith({ eventId: 'A', title: 'Soccer game', location: 'City Fields', startsAt: '2026-09-05T19:00:00Z' });
    // 15:00 − 5 buffer − 5 park − 20 drive = 14:30 local; prep does not move leave-by.
    expect(out.departures.A).toEqual({ leaveByISO: '2026-09-05T18:30:00.000Z', travelMinutes: 30, source: 'drive_time' });
    const sched = out.events[0];
    expect(sched.leaveBy).toEqual({ at: '2026-09-05T18:30:00.000Z', source: 'drive_time', travelMinutes: 30 });
    expect(sched.prep.leaveByISO).toBe('2026-09-05T18:30:00.000Z');
    expect(sched.prep.leaveBySource).toBe('drive_time');
    const leave = out.byEvent.A?.find((i) => i.kind === 'leave_by');
    expect(leave).toMatchObject({ severity: 'info', reasonKey: 'scheduleInsight.leaveByDrive', href: '/dashboard/trip-intel', at: '2026-09-05T18:30:00.000Z' });
    expect(leave!.params).toMatchObject({ time: '2:30 PM', minutes: 30, location: 'City Fields' });
  });

  it('falls back to the category buffer without a fetcher, and when the fetcher cannot answer', async () => {
    const none = await buildScheduleIntelligence(input({ events: [soccer] }));
    expect(none.departures.A).toEqual({ leaveByISO: '2026-09-05T18:25:00.000Z', travelMinutes: 35, source: 'category_buffer' });
    expect(none.byEvent.A?.find((i) => i.kind === 'leave_by')).toMatchObject({ reasonKey: 'scheduleInsight.leaveBy' });
    expect(none.byEvent.A?.find((i) => i.kind === 'leave_by')!.params).toMatchObject({ time: '2:25 PM', minutes: 35 });

    const unknown = await buildScheduleIntelligence(input({ events: [soccer] }), { driveTime: async () => null });
    expect(unknown.departures.A?.source).toBe('category_buffer');
    const throwing = await buildScheduleIntelligence(input({ events: [soccer] }), { driveTime: async () => { throw new Error('router down'); } });
    expect(throwing.departures.A?.source).toBe('category_buffer');
  });

  it('only asks the fetcher about timed events with a place', async () => {
    const fetcher = vi.fn<DriveTimeFetcher>(async () => ({ driveSeconds: 600, source: 'routed' }));
    const bare = event({ id: 'B', title: 'Work call', location: null });
    const allDay = event({ id: 'C', title: 'Teacher day', all_day: true });
    const times = await resolveDriveTimes([soccer, bare, allDay], fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(Object.keys(times)).toEqual(['A']);
    const out = composeScheduleIntelligence(input({ events: [bare] }));
    expect(out.departures.B).toBeUndefined();
    expect(out.byEvent.B).toBeUndefined();
  });

  it('escalates as the leave-by approaches, and says so when it has passed', () => {
    const at = (now: string) => composeScheduleIntelligence(input({ events: [soccer], now: new Date(now) })).byEvent.A?.find((i) => i.kind === 'leave_by');
    expect(at('2026-09-05T18:00:00Z')).toMatchObject({ severity: 'warn', reasonKey: 'scheduleInsight.leaveBy' });
    expect(at('2026-09-05T18:22:00Z')).toMatchObject({ severity: 'urgent', reasonKey: 'scheduleInsight.leaveNow' });
    expect(at('2026-09-05T18:40:00Z')).toMatchObject({ severity: 'urgent', reasonKey: 'scheduleInsight.leaveOverdue' });
  });
});

describe('the model', () => {
  it('flags the same person in two places, from the shared double-booking engine', () => {
    const a = event({ id: 'A', assignee_id: 'mom' });
    const b = event({ id: 'B', title: 'Dentist', location: 'Clinic', starts_at: '2026-09-05T19:30:00Z', ends_at: '2026-09-05T20:00:00Z', assignee_id: 'mom' });
    const out = composeScheduleIntelligence(input({ events: [a, b] }));
    expect(out.byEvent.A?.find((i) => i.kind === 'double_booking')).toMatchObject({ severity: 'warn', href: '/dashboard/calendar', relatedIds: ['B'], id: 'double_booking:A:B' });
    expect(out.byEvent.A?.find((i) => i.kind === 'double_booking')!.params).toEqual({ who: 'Maria', other: 'Dentist', title: 'Soccer game' });
  });

  it('skips all-day rows and events that have already ended', () => {
    const past = event({ id: 'P', starts_at: '2026-09-05T10:00:00Z', ends_at: '2026-09-05T11:00:00Z' });
    const allDay = event({ id: 'D', all_day: true });
    const out = composeScheduleIntelligence(input({ events: [past, allDay, event({ id: 'A' })] }));
    expect(out.events.map((e) => e.eventId)).toEqual(['A']);
  });

  it('orders insights severity first, then kind, and is deterministic', () => {
    const inp = input({
      events: [event({ id: 'A' }), event({ id: 'M', title: 'Work call', location: null, starts_at: '2026-09-05T19:00:00Z', ends_at: '2026-09-05T20:00:00Z', assignee_id: 'mom' }), event({ id: 'D', title: 'Dentist', location: 'Clinic', starts_at: '2026-09-05T19:30:00Z', ends_at: '2026-09-05T20:00:00Z', assignee_id: 'dad' })],
      vehicles: [{ id: 'v1' }],
      meals: [{ plan_date: DAY, meal_type: 'dinner' }],
    });
    const one = composeScheduleIntelligence(inp);
    const two = composeScheduleIntelligence(inp);
    expect(two).toEqual(one);
    expect(kinds(one.byEvent.A)).toEqual(['care_gap', 'vehicle_conflict', 'leave_by']);
    expect(topInsight(one.byEvent.A)?.kind).toBe('care_gap');
    expect(topInsight(undefined)).toBeNull();
    expect(topInsight([])).toBeNull();
  });

  it('keeps every event in `events` and only those with insights in `byEvent`', () => {
    const out = composeScheduleIntelligence(input({ events: [event({ id: 'A', location: null })] }));
    expect(out.events).toHaveLength(1);
    expect(out.byEvent).toEqual({});
    expect(out.events[0].prep.items.length).toBeGreaterThan(0);
  });
});

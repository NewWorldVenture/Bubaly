// A travel disruption re-flows the SHARED itinerary and pages the whole
// family about it, so it is a manager's act and it has to land whole:
//
//   • a guest, child, teen or caregiver is refused by the service AND by the
//     server action before any row moves and before `notify` is reached (the
//     action writes the family's notifications with the service role, so RLS
//     is not what stops it);
//   • the same report twice — a retry after a lost response, a second parent,
//     the day-of prompt running again — moves nothing a second time and files
//     no second note;
//   • a failure part-way restores every row that already moved and removes the
//     day rows the call created, so the family never sees half a re-flow;
//   • an item whose END alone crosses midnight is clamped, never stored as an
//     inverted interval on the same day.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { replanDisruption, type ItineraryLike } from '@/lib/vacations/disruption';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown, role: 'parent' as string, notify: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: 'user-1' },
  active: { familyId: 'fam-1', role: holder.role, member: { id: 'mem-1' }, family: { timezone: 'UTC' } },
}) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/services/notifications', () => ({ notify: (...args: unknown[]) => holder.notify(...args) }));

import { reportTripDisruption } from '@/lib/services/trips';
import { reportDisruptionAction } from '@/app/(app)/dashboard/vacations/[id]/actions';

const FAMILY = 'fam-1';
const DAY = '2026-07-14';

function seeded() {
  const db = createInMemorySupabase({
    defaults: {
      vacation_itinerary_items: { booked: false, sort_order: 0, member_ids: [], notes: null },
      vacation_itinerary_days: { title: null, summary: null },
    },
  });
  db.seed('vacations', [{
    id: 'trip-1', family_id: FAMILY, title: 'Barcelona', destination: 'Barcelona', kind: 'flight', status: 'booked',
    start_date: DAY, end_date: '2026-07-20', timezone: 'UTC', is_international: true,
  }]);
  db.seed('vacation_flights', [{
    id: 'flight-1', family_id: FAMILY, vacation_id: 'trip-1', airline: 'BA', flight_number: '274',
    depart_airport: 'LHR', arrive_airport: 'BCN', depart_at: `${DAY}T11:00:00Z`, arrive_at: `${DAY}T14:00:00Z`, booked: true,
  }]);
  db.seed('vacation_itinerary_days', [{ id: 'day-1', family_id: FAMILY, vacation_id: 'trip-1', day_date: DAY }]);
  db.seed('vacation_itinerary_items', [
    { id: 'item-early', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'morning', title: 'Airport', start_time: '09:00', end_time: '10:00' },
    { id: 'item-late', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'afternoon', title: 'Sagrada Familia', start_time: '16:00', end_time: '18:00', booked: true },
    { id: 'item-later', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'meal', day_part: 'evening', title: 'Dinner', start_time: '19:00', end_time: '20:00', booked: true },
  ]);
  return db;
}

const scopeFor = (db: unknown, role: ServiceScope['role'] = 'parent'): ServiceScope => ({
  db: db as SupabaseClient<Database>, familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role, actorKind: 'member', tz: 'UTC',
});
const items = (db: InMemorySupabase) => db.table('vacation_itinerary_items') as Record<string, unknown>[];
const notes = (db: InMemorySupabase) => items(db).filter((r) => r.kind === 'note');
const request = { kind: 'flight' as const, bookingId: 'flight-1', delayMinutes: 120 };

/** A PostgREST failure for one write, in the chainable shape the service expects. */
const failure = { data: null, error: { code: 'XX000', message: 'write rejected' }, count: null };
const failed: Record<string, unknown> = {};
Object.assign(failed, {
  select: () => failed, eq: () => failed, in: () => failed, order: () => failed,
  maybeSingle: async () => failure, single: async () => failure,
  then: (resolve: (value: unknown) => unknown) => resolve(failure),
});

/** Make the n-th `update` (1-based) of `table` fail, after the earlier ones landed. */
function failNthUpdate(db: InMemorySupabase, table: string, n: number) {
  let seen = 0;
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(((name: string) => {
    const builder = from(name);
    if (name !== table) return builder;
    const update = builder.update.bind(builder);
    builder.update = ((patch: Record<string, unknown>) => (++seen === n ? failed : update(patch))) as never;
    return builder;
  }) as typeof db.from);
}

/** Make the insert of a `note` itinerary item fail. */
function failNoteInsert(db: InMemorySupabase) {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(((name: string) => {
    const builder = from(name);
    if (name !== 'vacation_itinerary_items') return builder;
    const insert = builder.insert.bind(builder);
    builder.insert = ((row: Record<string, unknown>) => (row?.kind === 'note' ? failed : insert(row))) as never;
    return builder;
  }) as typeof db.from);
}

beforeEach(() => {
  vi.restoreAllMocks();
  holder.notify.mockReset();
  holder.notify.mockResolvedValue({ ok: true, data: { created: 2, skippedMemberIds: [] } });
  holder.role = 'parent';
});

describe('replanDisruption keeps an interval inside its day', () => {
  it('clamps an end that crosses midnight when the start does not', () => {
    const itinerary: ItineraryLike[] = [{ id: 'late', day_id: 'd', day_date: DAY, kind: 'activity', day_part: 'evening', title: 'Show', start_time: '23:00', end_time: '23:45' }];
    const plan = replanDisruption({ kind: 'flight', id: 'f', label: 'BA 274', anchorDay: DAY, anchorTime: '14:00', delayMinutes: 30 }, itinerary);
    expect(plan.shiftedItems).toEqual([expect.objectContaining({ id: 'late', toDay: DAY, toStart: '23:30', toEnd: '23:59', rolledOvernight: false })]);
  });

  it('still rolls the whole item when the start crosses midnight', () => {
    const itinerary: ItineraryLike[] = [{ id: 'late', day_id: 'd', day_date: DAY, kind: 'activity', day_part: 'evening', title: 'Show', start_time: '23:00', end_time: '23:45' }];
    const plan = replanDisruption({ kind: 'flight', id: 'f', label: 'BA 274', anchorDay: DAY, anchorTime: '14:00', delayMinutes: 90 }, itinerary);
    expect(plan.shiftedItems[0]).toMatchObject({ toDay: '2026-07-15', toStart: '00:30', toEnd: '01:15', rolledOvernight: true });
  });
});

describe('reportTripDisruption is refused for every non-manager role', () => {
  it.each(['guest', 'child', 'teen', 'caregiver'] as const)('%s moves nothing and records nothing', async (role) => {
    const db = seeded();
    const before = JSON.stringify(items(db));
    const res = await reportTripDisruption(scopeFor(db, role), 'trip-1', request);
    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(JSON.stringify(items(db))).toBe(before);
    expect(notes(db)).toHaveLength(0);
  });

  it.each(['parent', 'adult'] as const)('%s re-flows the itinerary', async (role) => {
    const db = seeded();
    const res = await reportTripDisruption(scopeFor(db, role), 'trip-1', request);
    expect(res).toMatchObject({ ok: true, data: { applied: { shifted: 2 }, alreadyApplied: false } });
    expect(items(db).find((r) => r.id === 'item-late')).toMatchObject({ start_time: '18:00', end_time: '20:00' });
  });
});

describe('the same disruption reported twice lands once', () => {
  it('does not shift the already-shifted items again or file a second note', async () => {
    const db = seeded();
    const first = await reportTripDisruption(scopeFor(db), 'trip-1', request);
    expect(first.ok).toBe(true);
    const second = await reportTripDisruption(scopeFor(db), 'trip-1', request);
    expect(second).toMatchObject({ ok: true, data: { alreadyApplied: true, applied: { shifted: 0 } } });
    if (!second.ok || !first.ok) return;
    expect(second.data.applied.noteItemId).toBe(first.data.applied.noteItemId);
    expect(items(db).find((r) => r.id === 'item-late')).toMatchObject({ start_time: '18:00', end_time: '20:00' });
    expect(items(db).find((r) => r.id === 'item-later')).toMatchObject({ start_time: '21:00', end_time: '22:00' });
    expect(notes(db)).toHaveLength(1);
  });

  it('a DIFFERENT delay for the same booking is a new report', async () => {
    const db = seeded();
    expect((await reportTripDisruption(scopeFor(db), 'trip-1', request)).ok).toBe(true);
    const more = await reportTripDisruption(scopeFor(db), 'trip-1', { ...request, delayMinutes: 30 });
    expect(more).toMatchObject({ ok: true, data: { alreadyApplied: false } });
    expect(notes(db)).toHaveLength(2);
  });
});

describe('a re-flow that fails part-way is rolled back', () => {
  it('restores the rows that already moved and files no note', async () => {
    const db = seeded();
    failNthUpdate(db, 'vacation_itinerary_items', 2);
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', request);
    expect(res.ok).toBe(false);
    expect(items(db).find((r) => r.id === 'item-late')).toMatchObject({ start_time: '16:00', end_time: '18:00', day_id: 'day-1' });
    expect(items(db).find((r) => r.id === 'item-later')).toMatchObject({ start_time: '19:00', end_time: '20:00' });
    expect(notes(db)).toHaveLength(0);
  });

  it('removes the day row it created when the note cannot be written', async () => {
    const db = seeded();
    failNoteInsert(db);
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', { ...request, delayMinutes: 10 * 60 });
    expect(res.ok).toBe(false);
    const days = db.table('vacation_itinerary_days') as Record<string, unknown>[];
    expect(days.map((d) => d.day_date)).toEqual([DAY]);
    expect(items(db).find((r) => r.id === 'item-late')).toMatchObject({ start_time: '16:00', end_time: '18:00', day_id: 'day-1' });
    expect(notes(db)).toHaveLength(0);
    // Nothing was recorded, so the same report is not "already applied" — a
    // retry gets to land it.
    vi.restoreAllMocks();
    expect(await reportTripDisruption(scopeFor(db), 'trip-1', { ...request, delayMinutes: 10 * 60 })).toMatchObject({ ok: true, data: { alreadyApplied: false, applied: { shifted: 2 } } });
  });
});

describe('reportDisruptionAction', () => {
  it.each(['guest', 'child', 'teen', 'caregiver'] as const)('refuses a %s before any write and never notifies the family', async (role) => {
    const db = seeded();
    holder.db = db;
    holder.role = role;
    const before = JSON.stringify(items(db));
    const result = await reportDisruptionAction({ vacationId: 'trip-1', kind: 'flight', bookingId: 'flight-1', outcome: 'delayed', delayMinutes: 120 });
    expect(result).toEqual({ ok: false, error: 'vacationDisruption.parentsOnly' });
    expect(holder.notify).not.toHaveBeenCalled();
    expect(JSON.stringify(items(db))).toBe(before);
  });

  it('a parent re-flows the itinerary and the family hears about it once', async () => {
    const db = seeded();
    holder.db = db;
    const first = await reportDisruptionAction({ vacationId: 'trip-1', kind: 'flight', bookingId: 'flight-1', outcome: 'delayed', delayMinutes: 120 });
    expect(first).toMatchObject({ ok: true, notified: true, recorded: true, noChange: false });
    expect(holder.notify).toHaveBeenCalledTimes(1);
    expect(holder.notify.mock.calls[0][1]).toMatchObject({ recipients: 'family', urgent: true, relatedId: 'trip-1' });

    // The same submit again — a retry after a lost response — pages nobody.
    const again = await reportDisruptionAction({ vacationId: 'trip-1', kind: 'flight', bookingId: 'flight-1', outcome: 'delayed', delayMinutes: 120 });
    expect(again).toMatchObject({ ok: true, notified: false, recorded: true });
    expect(holder.notify).toHaveBeenCalledTimes(1);
    expect(notes(db)).toHaveLength(1);
  });
});

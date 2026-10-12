// A travel disruption is two facts, not one: the itinerary was re-flowed, and
// the family was told. Driven through the real caller (reportDisruptionAction)
// and the REAL notify(), against an in-memory database that applies filters.
//
//   • The itinerary marker used to be the only record, and the action skipped
//     the notice for any report the itinerary already carried — so a notice
//     that failed, or a request cut off after the note was written, was never
//     sent by any retry. Delivery is now its own stamp on the note, and the
//     notice carries a per-disruption key that notify() will not send twice.
//   • A repeat of the same report re-planned the already-moved itinerary and
//     answered with that plan: a 16:00→18:00 report, sent again, showed an
//     18:00→20:00 move under "Moved on the itinerary" that never happened.
//   • The rollback deleted every day row it had created, even one an item
//     still sat on (a restore that failed, or a shift that committed but
//     answered with an error) — and `day_id` is ON DELETE CASCADE (0070).
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';
import { getMessages } from '@/lib/i18n/messages';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: 'user-1' },
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' }, family: { name: 'The Rivers', timezone: 'UTC' } },
}) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { DISRUPTION_NOTIFIED_STAMP, reportTripDisruption } from '@/lib/services/trips';
import { reportDisruptionAction } from '@/app/(app)/dashboard/vacations/[id]/actions';
import { DisruptionReceipt } from '@/app/(app)/dashboard/vacations/[id]/travel/disruption-form';

const FAMILY = 'fam-1';
const DAY = '2026-07-14';
const EN = getMessages('en-US') as Record<string, string>;

type Hook = (name: string, builder: ReturnType<InMemorySupabase['from']>) => void;
let hooks: Hook[] = [];

function seeded() {
  const db = createInMemorySupabase({
    defaults: {
      vacation_itinerary_items: { booked: false, sort_order: 0, member_ids: [], notes: null },
      vacation_itinerary_days: { title: null, summary: null },
      notifications: { is_read: false },
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
    { id: 'item-later', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'meal', day_part: 'evening', title: 'Dinner', start_time: '19:00', end_time: '20:00', booked: true, confirmation_code: 'RES-4417' },
  ]);
  // Two members with a login, one managed profile without: two notices.
  db.seed('family_members', [
    { id: 'mem-1', family_id: FAMILY, user_id: 'user-1', role: 'parent', is_active: true },
    { id: 'mem-2', family_id: FAMILY, user_id: 'user-2', role: 'teen', is_active: true },
    { id: 'mem-3', family_id: FAMILY, user_id: null, role: 'child', is_active: true },
  ]);
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation(((name: string) => {
    const builder = from(name);
    for (const hook of hooks) hook(name, builder);
    return builder;
  }) as typeof db.from);
  holder.db = db;
  return db;
}

const failure = { data: null, error: { code: 'XX000', message: 'write rejected' }, count: null };
/** A PostgREST failure for one write, in the chainable shape callers expect. */
function failed(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain, eq: () => chain, is: () => chain, in: () => chain, order: () => chain,
    maybeSingle: async () => failure, single: async () => failure,
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(failure).then(resolve),
  });
  return chain;
}

const items = (db: InMemorySupabase) => db.table('vacation_itinerary_items') as Row[];
const item = (db: InMemorySupabase, id: string) => items(db).find((r) => r.id === id);
const notes = (db: InMemorySupabase) => items(db).filter((r) => r.kind === 'note');
const notices = (db: InMemorySupabase) => db.table('notifications') as Row[];
const report = (delayMinutes = 120) => reportDisruptionAction({ vacationId: 'trip-1', kind: 'flight', bookingId: 'flight-1', outcome: 'delayed', delayMinutes });
const scope = (db: InMemorySupabase): ServiceScope => ({
  db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz: 'UTC',
});

beforeEach(() => {
  vi.restoreAllMocks();
  hooks = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a notice that did not go out is sent by the retry — once — and nothing moves twice', () => {
  it('the notification insert fails, then the same report is submitted again', async () => {
    const db = seeded();
    let refusals = 1;
    hooks.push((name, builder) => {
      if (name !== 'notifications') return;
      const insert = builder.insert.bind(builder);
      builder.insert = ((rows: Row[]) => (refusals-- > 0 ? failed() : insert(rows))) as never;
    });

    const first = await report();
    expect(first).toMatchObject({ ok: true, recorded: true, notified: false, alreadyApplied: false });
    expect(item(db, 'item-late')).toMatchObject({ start_time: '18:00', end_time: '20:00' });
    expect(notices(db)).toHaveLength(0);
    expect(String(notes(db)[0].notes)).not.toContain(DISRUPTION_NOTIFIED_STAMP);

    const retry = await report();
    expect(retry).toMatchObject({ ok: true, recorded: true, notified: true, alreadyApplied: true, shifted: [] });
    // The itinerary did not move a second time …
    expect(item(db, 'item-late')).toMatchObject({ start_time: '18:00', end_time: '20:00' });
    expect(item(db, 'item-later')).toMatchObject({ start_time: '21:00', end_time: '22:00' });
    expect(notes(db)).toHaveLength(1);
    // … and the family heard about it, one notice each, keyed to this disruption.
    const noteId = String(notes(db)[0].id);
    expect(notices(db).map((n) => n.user_id).sort()).toEqual(['user-1', 'user-2']);
    expect(notices(db).every((n) => n.related_id === `trip-1:disruption:${noteId}` && n.type === 'system')).toBe(true);
    expect(String(notes(db)[0].notes)).toContain(DISRUPTION_NOTIFIED_STAMP);

    const third = await report();
    expect(third).toMatchObject({ ok: true, notified: false, previouslyNotified: true, alreadyApplied: true });
    expect(notices(db)).toHaveLength(2);
  });

  it('a request cut off after the note was written (notify threw) is finished by the retry', async () => {
    const db = seeded();
    let interruptions = 1;
    hooks.push((name, builder) => {
      if (name !== 'family_members') return;
      const run = builder.then.bind(builder);
      Object.assign(builder, {
        then: (ok: never, ko: never) => (interruptions-- > 0 ? Promise.reject(new Error('connection reset')).then(ok, ko) : run(ok, ko)),
      });
    });

    await expect(report()).rejects.toThrow('connection reset');
    expect(item(db, 'item-late')).toMatchObject({ start_time: '18:00' });
    expect(notices(db)).toHaveLength(0);

    expect(await report()).toMatchObject({ ok: true, notified: true, alreadyApplied: true });
    expect(item(db, 'item-late')).toMatchObject({ start_time: '18:00' });
    expect(notices(db)).toHaveLength(2);
  });

  it('a notice that was written but never stamped (the request died in between) is not sent twice', async () => {
    const db = seeded();
    let stampFailures = 1;
    hooks.push((name, builder) => {
      if (name !== 'vacation_itinerary_items') return;
      const update = builder.update.bind(builder);
      builder.update = ((patch: Row) => (String(patch.notes ?? '').includes(DISRUPTION_NOTIFIED_STAMP) && stampFailures-- > 0 ? failed() : update(patch))) as never;
    });

    expect(await report()).toMatchObject({ ok: true, notified: true });
    expect(notices(db)).toHaveLength(2);
    expect(String(notes(db)[0].notes)).not.toContain(DISRUPTION_NOTIFIED_STAMP);

    // The retry asks notify() again; its per-disruption key finds both copies.
    const retry = await report();
    expect(retry).toMatchObject({ ok: true, notified: false, previouslyNotified: true, alreadyApplied: true });
    expect(notices(db)).toHaveLength(2);
    expect(String(notes(db)[0].notes)).toContain(DISRUPTION_NOTIFIED_STAMP);
    // Nobody was paged this time because everyone already had it: the receipt
    // says the family was told, not that no notification was sent.
    if (!retry.ok) throw new Error('the retry should succeed');
    const html = renderTranslated(createElement(DisruptionReceipt, { result: retry }));
    expect(html).toContain(EN['vacationDisruption.familyAlreadyNotified']);
    expect(html).not.toContain(EN['vacationDisruption.familyNotNotified']);
  });

  it('a notice that went out is still reported as told when the retry\'s own stamp fails too', async () => {
    const db = seeded();
    hooks.push((name, builder) => {
      if (name !== 'vacation_itinerary_items') return;
      const update = builder.update.bind(builder);
      builder.update = ((patch: Row) => (String(patch.notes ?? '').includes(DISRUPTION_NOTIFIED_STAMP) ? failed() : update(patch))) as never;
    });

    expect(await report()).toMatchObject({ ok: true, notified: true });
    const retry = await report();
    expect(retry).toMatchObject({ ok: true, notified: false, previouslyNotified: true, alreadyApplied: true });
    expect(notices(db)).toHaveLength(2);
    expect(String(notes(db)[0].notes)).not.toContain(DISRUPTION_NOTIFIED_STAMP);
  });

  it('a different disruption of the same trip is its own notice, not a duplicate of the first', async () => {
    const db = seeded();
    expect(await report(120)).toMatchObject({ notified: true });
    expect(await report(30)).toMatchObject({ notified: true, alreadyApplied: false });
    expect(notices(db)).toHaveLength(4);
  });
});

describe('a repeated report answers with what is true: nothing moved again', () => {
  it('the service returns no moves and the summary that was recorded, not a re-plan of the moved itinerary', async () => {
    const db = seeded();
    const first = await reportTripDisruption(scope(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    const again = await reportTripDisruption(scope(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    if (!first.ok || !again.ok) throw new Error('both reports should succeed');
    expect(first.data.plan.shiftedItems.map((s) => [s.title, s.fromStart, s.toStart, s.toEnd])).toEqual([
      ['Sagrada Familia', '16:00', '18:00', '20:00'],
      ['Dinner', '19:00', '21:00', '22:00'],
    ]);
    expect(again.data).toMatchObject({ alreadyApplied: true, applied: { shifted: 0, noteItemId: first.data.applied.noteItemId } });
    // Not 18:00→20:00 and 21:00→23:00: those moves never happened.
    expect(again.data.plan.shiftedItems).toEqual([]);
    expect(again.data.plan.summary).toBe(first.data.plan.summary);
    expect(item(db, 'item-late')).toMatchObject({ start_time: '18:00', end_time: '20:00' });
  });

  it('the action and the receipt say it was already on the itinerary, and list no move', async () => {
    seeded();
    const first = await report();
    const again = await report();
    if (!first.ok || !again.ok) throw new Error('both reports should succeed');
    expect(again).toMatchObject({ noChange: false, recorded: true, alreadyApplied: true, previouslyNotified: true, notified: false, shifted: [] });
    expect(again.summary).toBe(first.summary);

    const html = renderTranslated(createElement(DisruptionReceipt, { result: again }));
    expect(html).toContain(EN['vacationDisruption.alreadyOnItinerary']);
    expect(html).toContain(EN['vacationDisruption.familyAlreadyNotified']);
    expect(html).not.toContain('20:00');
    expect(html).not.toContain('23:00');
    // The first receipt still shows the moves that did happen.
    const shown = renderTranslated(createElement(DisruptionReceipt, { result: first }));
    expect(shown).toContain('18:00');
    expect(shown).toContain(EN['vacationDisruption.familyNotified']);
  });
});

describe('a rollback never deletes a day an item still sits on', () => {
  /** Ten hours late: the 19:00 Dinner rolls to 05:00 on a day the trip has no row for. */
  const late = { kind: 'flight' as const, bookingId: 'flight-1', delayMinutes: 10 * 60 };

  it('the note fails and the Dinner\'s restore fails too: its new day is kept, so the booked Dinner is not cascaded away', async () => {
    const db = seeded();
    let updates = 0;
    hooks.push((name, builder) => {
      if (name !== 'vacation_itinerary_items') return;
      const insert = builder.insert.bind(builder);
      builder.insert = ((row: Row) => (row?.kind === 'note' ? failed() : insert(row))) as never;
      const update = builder.update.bind(builder);
      // 1, 2: the two shifts land. 3: Sagrada's restore lands. 4: Dinner's restore fails.
      builder.update = ((patch: Row) => (++updates === 4 ? failed() : update(patch))) as never;
    });

    const res = await reportTripDisruption(scope(db), 'trip-1', late);
    expect(res.ok).toBe(false);
    const dinner = item(db, 'item-later');
    expect(dinner).toMatchObject({ start_time: '05:00', booked: true, confirmation_code: 'RES-4417' });
    const days = db.table('vacation_itinerary_days') as Row[];
    expect(days.map((d) => d.id)).toContain(dinner!.day_id);
    // Sagrada was restored, so nothing of its own pins a day; the anchor day stays.
    expect(item(db, 'item-late')).toMatchObject({ start_time: '16:00', day_id: 'day-1' });
  });

  it('a shift that committed but answered with an error is not in the restore list — its day is kept all the same', async () => {
    const db = seeded();
    let updates = 0;
    hooks.push((name, builder) => {
      if (name !== 'vacation_itinerary_items') return;
      const update = builder.update.bind(builder);
      builder.update = ((patch: Row) => {
        updates += 1;
        if (updates !== 2) return update(patch);
        // The Dinner's shift reaches the database, and the answer is lost.
        const query = update(patch);
        const run = query.then.bind(query);
        Object.assign(query, { then: (ok: never, ko: never) => run(() => failure as never).then(ok, ko) });
        return query;
      }) as never;
    });

    const res = await reportTripDisruption(scope(db), 'trip-1', late);
    expect(res.ok).toBe(false);
    const dinner = item(db, 'item-later');
    const days = db.table('vacation_itinerary_days') as Row[];
    expect(dinner).toBeDefined();
    expect(days.map((d) => d.id)).toContain(dinner!.day_id);
  });

  it('an ordinary failed re-flow still removes the empty day it created', async () => {
    const db = seeded();
    hooks.push((name, builder) => {
      if (name !== 'vacation_itinerary_items') return;
      const insert = builder.insert.bind(builder);
      builder.insert = ((row: Row) => (row?.kind === 'note' ? failed() : insert(row))) as never;
    });
    expect((await reportTripDisruption(scope(db), 'trip-1', late)).ok).toBe(false);
    expect((db.table('vacation_itinerary_days') as Row[]).map((d) => d.day_date)).toEqual([DAY]);
    expect(item(db, 'item-later')).toMatchObject({ start_time: '19:00', day_id: 'day-1' });
  });
});

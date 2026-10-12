import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// A relationship date points at its calendar event through `calendar_event_id`,
// and three actions move that link: the toggle (on and off), the sync after an
// edit, and the removal. Each is several statements, and the other two can land
// between them.
//
//   SYNC     It reads the date linked to event A, finds A gone, and clears the
//            link — guarded on A, so a link a toggle has since moved to a NEW
//            event B is not cleared. But the guard matching nothing was read as
//            a failure: a second sync of the same deleted event, or a sync
//            overlapping a toggle off, said "Could not update your calendar"
//            over a date already unlinked; and a date re-linked to B was told
//            the same, instead of that it had changed. The link is now read
//            again: null is done, another event is a conflict (nothing cleared),
//            the same event is the failure it was.
//
//   REMOVAL  It reads the date linked to A, deletes A, then deletes the date —
//            unconditionally. A toggle between the two found the date off the
//            calendar, put it back on as B, and the removal then deleted the
//            date: B stayed on the calendar with nothing pointing at it. The date
//            now goes only while its link is A or null, and is kept, with B, when
//            it names anything else.
//
// THE FOREIGN KEY. `calendar_event_id` is `ON DELETE SET NULL` (00980): on the
// real schema, deleting A clears the date's link inside the same statement. The
// in-memory database does not model that, so a test of the removal that leaned
// on it would only ever see the link still saying A — and a fix that demanded A
// would pass here and refuse every healthy removal in production. The cases
// below that depend on it say so and run through `withSetNullOnEventDelete`,
// which applies the SET NULL explicitly and records that it did.
//
// Driven through the real actions and the real calendar service against an
// in-memory database. The only additions are barriers that hold one action at a
// chosen write while another runs, and, for the refusal controls, a client that
// answers one query itself.
//
// What this does NOT establish: the date/event lifecycle as a whole is still not
// atomic. These guards refuse the stale writes; they do not make the event and
// the date change together.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Family One', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));

const relationship = await import('@/app/(app)/dashboard/relationship/actions');

const FAMILY = 'family-1';
const RELINKED_WHILE_SAVING = 'actions.theDateWasPutBackOnTheCalendarWhileSaving';
const RELINKED_WHILE_REMOVING = 'actions.theDateWasPutBackOnTheCalendarWhileRemoving';
let db: InMemorySupabase & SupabaseClient<Database>;

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      calendar_events: { description: null, location: null, ends_at: null, all_day: false, category: 'general', recurrence: 'none', recurrence_until: null, assignee_id: null, idempotency_key: null, feed_id: null, external_uid: null },
      relationship_dates: { recurs_annually: false, location: null, notes: null, calendar_event_id: null, member_id: null, reminder_days_before: 7, status: 'upcoming' },
    },
  });
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('relationship_dates', [{ id: 'date-1', family_id: FAMILY, kind: 'anniversary', title: 'Our anniversary', event_date: '2026-11-14', recurs_annually: true }]);
});
afterEach(() => { vi.restoreAllMocks(); });

/** The builder calls that run a query: where the in-memory database reads or writes. */
const RUNS = new Set(['maybeSingle', 'single', 'then']);

type Reply = { data: unknown; error: { code: string; message: string; details: null; hint: null } | null; count: null; status: number; statusText: string };
/** A write RLS filters away: no error, and no rows. */
const FILTERED: Reply = { data: [], error: null, count: null, status: 200, statusText: 'OK' };
const TIMEOUT: Reply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null }, count: null, status: 500, statusText: 'Error' };

/**
 * Wrap every builder `from(table)` returns. `call` sees each builder call (its
 * name, every call on the same builder so far, how to run it for real, and its
 * arguments) and returns what the caller gets back.
 */
function onTable<T extends object>(
  target: T,
  table: string,
  call: (key: string, calls: string[], run: () => unknown, args: unknown[]) => unknown,
): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (property !== 'from') return Reflect.get(object, property, receiver);
      return (name: string) => {
        const builder = (object as unknown as InMemorySupabase).from(name);
        if (name !== table) return builder;
        const calls: string[] = [];
        const proxy: object = new Proxy(builder, {
          get(inner, key) {
            const value = Reflect.get(inner, key);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              calls.push(String(key));
              const result = call(String(key), calls, () => Reflect.apply(value, inner, args), args);
              return result === inner ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  });
}

/**
 * `ON DELETE SET NULL` on `relationship_dates.calendar_event_id` (00980), made
 * explicit: every `calendar_events` delete through the returned client nulls the
 * link on each date that named a removed event, in the same step, as Postgres
 * does inside the delete's own statement. `cleared` records each date it nulled,
 * so a test can show the foreign key really fired.
 */
function withSetNullOnEventDelete(target: InMemorySupabase) {
  const cleared: string[] = [];
  const client = onTable(target, 'calendar_events', (key, calls, run) => {
    if (!calls.includes('delete') || !RUNS.has(key)) return run();
    const before = new Set(target.table('calendar_events').map((e) => e.id));
    const result = run(); // the in-memory query executes synchronously here
    const after = new Set(target.table('calendar_events').map((e) => e.id));
    for (const date of target.table('relationship_dates')) {
      const linked = date.calendar_event_id;
      if (linked != null && before.has(linked) && !after.has(linked)) {
        date.calendar_event_id = null;
        cleared.push(String(date.id));
      }
    }
    return result;
  });
  return { client, cleared };
}

/**
 * The same client, with every `verb` on `table` held at the point it would run.
 * A held write runs when released — against the tables as they stand THEN,
 * which is what lets another action move the link under it.
 */
function holdWrites<T extends object>(target: T, table: string, verb: 'update' | 'delete') {
  const held: { release: () => void }[] = [];
  const client = onTable(target, table, (key, calls, run) => {
    if (!calls.includes(verb) || !RUNS.has(key)) return run();
    return new Promise((resolve, reject) => {
      held.push({ release: () => { try { resolve(run()); } catch (error) { reject(error); } } });
    });
  });
  return { client, held };
}

/** The same client, with `answer` replying to chosen queries on `table` instead of the database. */
function answering<T extends object>(target: T, table: string, answer: (calls: string[]) => Reply | undefined): T {
  return onTable(target, table, (key, calls, run, args) => {
    if (!RUNS.has(key)) return run();
    const reply = answer(calls);
    if (!reply) return run();
    // `await` reaches the builder through `then(onFulfilled, onRejected)`.
    const [onFulfilled, onRejected] = args as [(value: Reply) => unknown, (reason: unknown) => unknown];
    return key === 'then' ? Promise.resolve(reply).then(onFulfilled, onRejected) : Promise.resolve(reply);
  });
}

const date = () => db.table('relationship_dates').find((d) => d.id === 'date-1');
const link = () => date()?.calendar_event_id as string | null | undefined;
const event = (id: string) => db.table('calendar_events').find((e) => e.id === id && e.family_id === FAMILY);
const events = () => db.table('calendar_events').filter((e) => e.family_id === FAMILY);
/** Deleted on the calendar itself, outside the relationship actions. */
const deleteOnTheCalendar = async (client: InMemorySupabase, id: string) => {
  const { data, error } = await client.from('calendar_events').delete().eq('id', id).eq('family_id', FAMILY).select('id');
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
};
/** The in-memory database has no foreign key: the event goes and the link dangles. */
const dropEventLeavingTheLink = (id: string) => db.replace('calendar_events', db.table('calendar_events').filter((e) => e.id !== id));

async function onTheCalendar(): Promise<string> {
  expect(await relationship.toggleDateOnCalendarAction('date-1')).toMatchObject({ ok: true, onCalendar: true });
  const id = link();
  expect(id).toBeTruthy();
  return id as string;
}

describe('a sync whose guarded unlink matches nothing reads the link again', () => {
  it('(a) a toggle that puts the date back on as B before the unlink: B stays linked and the sync reports a conflict (foreign key on)', async () => {
    const a = await onTheCalendar();
    Object.assign(date()!, { event_date: '2026-11-21' });
    const fk = withSetNullOnEventDelete(db);
    const sync = holdWrites(fk.client, 'calendar_events', 'update');
    h.db = sync.client;
    const syncing = relationship.syncDateOnCalendarAction('date-1');
    // The sync has read the date (linked to A) and A's clock, and waits at its guarded event write.
    await vi.waitFor(() => expect(sync.held).toHaveLength(1));

    h.db = fk.client;
    // A is deleted on the calendar itself, and the foreign key clears the link...
    await deleteOnTheCalendar(fk.client, a);
    expect(fk.cleared).toEqual(['date-1']);
    expect(link()).toBeNull();
    // ...so a toggle finds the date off the calendar and puts it back on: B.
    expect(await relationship.toggleDateOnCalendarAction('date-1')).toMatchObject({ ok: true, onCalendar: true });
    const b = link()!;
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);

    sync.held[0].release();
    expect(await syncing).toEqual({ ok: false, error: RELINKED_WHILE_SAVING });
    expect(link()).toBe(b);
    expect(event(b)).toMatchObject({ title: 'Our anniversary', starts_at: '2026-11-21T00:00:00.000Z' });
    expect(event(a)).toBeUndefined();

    // "Try again" is true: the next sync brings B in line, and keeps it.
    Object.assign(date()!, { title: 'Ten years' });
    expect(await relationship.syncDateOnCalendarAction('date-1')).toEqual({ ok: true });
    expect(link()).toBe(b);
    expect(event(b)).toMatchObject({ title: 'Ten years' });
  });

  it('(a) the same race held at the unlink itself: a toggle off and on in between leaves B linked, and the sync reports a conflict', async () => {
    const a = await onTheCalendar();
    dropEventLeavingTheLink(a);
    Object.assign(date()!, { event_date: '2026-11-21' });
    const sync = holdWrites(db, 'relationship_dates', 'update');
    h.db = sync.client;
    const syncing = relationship.syncDateOnCalendarAction('date-1');
    // Update said notFound, the re-check found A gone: the sync is at its guarded unlink.
    await vi.waitFor(() => expect(sync.held).toHaveLength(1));

    h.db = db;
    expect(await relationship.toggleDateOnCalendarAction('date-1')).toMatchObject({ ok: true, onCalendar: false });
    expect(await relationship.toggleDateOnCalendarAction('date-1')).toMatchObject({ ok: true, onCalendar: true });
    const b = link()!;
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);

    sync.held[0].release();
    expect(await syncing).toEqual({ ok: false, error: RELINKED_WHILE_SAVING });
    expect(link()).toBe(b);
    expect(event(b)).toBeTruthy();
    expect(events()).toHaveLength(1);
  });

  it('(d) two syncs of one deleted event both succeed, and the link ends null', async () => {
    const a = await onTheCalendar();
    dropEventLeavingTheLink(a);
    Object.assign(date()!, { event_date: '2026-11-21' });
    const both = holdWrites(db, 'relationship_dates', 'update');
    h.db = both.client;
    const outcomes: { ok: boolean; error?: string }[] = [];
    const first = relationship.syncDateOnCalendarAction('date-1').then((r) => { outcomes.push(r); return r; });
    const second = relationship.syncDateOnCalendarAction('date-1').then((r) => { outcomes.push(r); return r; });
    // Both found A gone and are at the guarded unlink.
    await vi.waitFor(() => expect(both.held).toHaveLength(2));

    both.held[0].release();
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toEqual({ ok: true });
    expect(link()).toBeNull();

    // The second's guard names A, which is no longer the link: no rows, and not a failure.
    both.held[1].release();
    await Promise.all([first, second]);
    expect(outcomes).toEqual([{ ok: true }, { ok: true }]);
    expect(link()).toBeNull();
    expect(events()).toEqual([]);
  });

  it('(d) two syncs overlapping the event\'s deletion on the calendar both succeed (foreign key on)', async () => {
    const a = await onTheCalendar();
    Object.assign(date()!, { event_date: '2026-11-21' });
    const fk = withSetNullOnEventDelete(db);
    const both = holdWrites(fk.client, 'calendar_events', 'update');
    h.db = both.client;
    const first = relationship.syncDateOnCalendarAction('date-1');
    const second = relationship.syncDateOnCalendarAction('date-1');
    // Both read the date while it still named A.
    await vi.waitFor(() => expect(both.held).toHaveLength(2));

    await deleteOnTheCalendar(fk.client, a);
    expect(fk.cleared).toEqual(['date-1']);
    both.held[0].release();
    both.held[1].release();
    // Each update misses, each re-check finds A gone, each unlink finds the link
    // already null — which is what the real schema does after ANY such deletion.
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(link()).toBeNull();
    expect(events()).toEqual([]);
  });

  it('a sync overlapping a toggle off succeeds, and the date stays off the calendar (foreign key on)', async () => {
    const a = await onTheCalendar();
    Object.assign(date()!, { event_date: '2026-11-21' });
    const fk = withSetNullOnEventDelete(db);
    const sync = holdWrites(fk.client, 'calendar_events', 'update');
    h.db = sync.client;
    const syncing = relationship.syncDateOnCalendarAction('date-1');
    await vi.waitFor(() => expect(sync.held).toHaveLength(1));

    h.db = fk.client;
    expect(await relationship.toggleDateOnCalendarAction('date-1')).toEqual({ ok: true, onCalendar: false, eventId: null });
    expect(event(a)).toBeUndefined();

    sync.held[0].release();
    expect(await syncing).toEqual({ ok: true });
    expect(link()).toBeNull();
    expect(events()).toEqual([]);
  });

  it('a date removed while its sync was unlinking is reported as not found, not as done', async () => {
    const a = await onTheCalendar();
    dropEventLeavingTheLink(a);
    const sync = holdWrites(db, 'relationship_dates', 'update');
    h.db = sync.client;
    const syncing = relationship.syncDateOnCalendarAction('date-1');
    await vi.waitFor(() => expect(sync.held).toHaveLength(1));

    h.db = db;
    expect(await relationship.removeRelationshipDateAction('date-1')).toEqual({ ok: true });
    sync.held[0].release();
    expect(await syncing).toEqual({ ok: false, error: 'actions.thatDateCouldNotBe' });
    expect(date()).toBeUndefined();
  });

  it('control: an unlink refused while the link still names the observed event is the failure it was, and keeps the link', async () => {
    const a = await onTheCalendar();
    dropEventLeavingTheLink(a);
    h.db = answering(db, 'relationship_dates', (calls) => (calls.includes('update') ? FILTERED : undefined));

    expect(await relationship.syncDateOnCalendarAction('date-1')).toEqual({ ok: false, error: 'actions.couldNotUpdateYourCalendar' });
    expect(link()).toBe(a);
  });

  it('a link that cannot be read back after a lost unlink is not taken as done', async () => {
    const a = await onTheCalendar();
    dropEventLeavingTheLink(a);
    let reads = 0;
    h.db = answering(db, 'relationship_dates', (calls) => {
      if (calls.includes('update')) return FILTERED;
      // The sync's own first read answers; the re-read after the lost unlink fails.
      if (calls.at(-1) === 'maybeSingle' && ++reads === 2) return TIMEOUT;
      return undefined;
    });

    expect(await relationship.syncDateOnCalendarAction('date-1')).toEqual({ ok: false, error: 'actions.couldNotUpdateYourCalendar' });
    expect(reads).toBe(2);
    expect(link()).toBe(a);
  });
});

describe('a removal deletes the date only while its link is the event it removed, or none', () => {
  it('(b) a toggle that puts the date back on as B before the date\'s delete: the date and B are kept, and the removal reports a conflict (foreign key on)', async () => {
    const a = await onTheCalendar();
    const fk = withSetNullOnEventDelete(db);
    const removal = holdWrites(fk.client, 'relationship_dates', 'delete');
    h.db = removal.client;
    const removing = relationship.removeRelationshipDateAction('date-1');
    await vi.waitFor(() => expect(removal.held).toHaveLength(1));
    // A is gone, and with it — by the foreign key — the date's link.
    expect(event(a)).toBeUndefined();
    expect(fk.cleared).toEqual(['date-1']);
    expect(link()).toBeNull();

    h.db = fk.client;
    expect(await relationship.toggleDateOnCalendarAction('date-1')).toMatchObject({ ok: true, onCalendar: true });
    const b = link()!;
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);

    removal.held[0].release();
    expect(await removing).toEqual({ ok: false, error: RELINKED_WHILE_REMOVING });
    expect(date()).toMatchObject({ title: 'Our anniversary', calendar_event_id: b });
    expect(event(b)).toMatchObject({ title: 'Our anniversary' });

    // "Try again" is true: removing it now takes the date and B together.
    expect(await relationship.removeRelationshipDateAction('date-1')).toEqual({ ok: true });
    expect(date()).toBeUndefined();
    expect(events()).toEqual([]);
  });

  it('(b) a date that was off the calendar when the removal read it, put on as B before its delete: kept, with B (foreign key on)', async () => {
    const fk = withSetNullOnEventDelete(db);
    const removal = holdWrites(fk.client, 'relationship_dates', 'delete');
    h.db = removal.client;
    const removing = relationship.removeRelationshipDateAction('date-1');
    await vi.waitFor(() => expect(removal.held).toHaveLength(1));

    h.db = fk.client;
    const b = await onTheCalendar();

    removal.held[0].release();
    expect(await removing).toEqual({ ok: false, error: RELINKED_WHILE_REMOVING });
    expect(link()).toBe(b);
    expect(event(b)).toBeTruthy();
  });

  it('(c) a healthy removal succeeds when deleting the event has cleared the link through ON DELETE SET NULL', async () => {
    const a = await onTheCalendar();
    const fk = withSetNullOnEventDelete(db);
    const removal = holdWrites(fk.client, 'relationship_dates', 'delete');
    h.db = removal.client;
    const removing = relationship.removeRelationshipDateAction('date-1');
    await vi.waitFor(() => expect(removal.held).toHaveLength(1));
    // What the date's delete will find: the link the foreign key cleared, not A.
    // A delete that demanded A here would refuse every removal on the real schema.
    expect(event(a)).toBeUndefined();
    expect(fk.cleared).toEqual(['date-1']);
    expect(link()).toBeNull();

    removal.held[0].release();
    expect(await removing).toEqual({ ok: true });
    expect(date()).toBeUndefined();
    expect(events()).toEqual([]);
  });

  it('control: with the link still naming the removed event (no foreign key in play), the date is removed', async () => {
    await onTheCalendar();
    expect(await relationship.removeRelationshipDateAction('date-1')).toEqual({ ok: true });
    expect(date()).toBeUndefined();
    expect(events()).toEqual([]);
  });

  it('control: a date never on the calendar is removed', async () => {
    expect(await relationship.removeRelationshipDateAction('date-1')).toEqual({ ok: true });
    expect(date()).toBeUndefined();
  });

  it('control: a delete refused while the link is unchanged is the failure it was, and keeps the date', async () => {
    const a = await onTheCalendar();
    h.db = answering(db, 'relationship_dates', (calls) => (calls.includes('delete') ? FILTERED : undefined));

    expect(await relationship.removeRelationshipDateAction('date-1')).toEqual({ ok: false, error: 'errors.thatChangeWasNotSaved' });
    expect(link()).toBe(a);
  });

  it('a link that cannot be read back after a refused delete is not read as a conflict', async () => {
    await onTheCalendar();
    let reads = 0;
    h.db = answering(db, 'relationship_dates', (calls) => {
      if (calls.includes('delete')) return FILTERED;
      if (calls.at(-1) === 'maybeSingle' && ++reads === 2) return TIMEOUT;
      return undefined;
    });

    expect(await relationship.removeRelationshipDateAction('date-1')).toEqual({ ok: false, error: 'errors.thatChangeWasNotSaved' });
    expect(reads).toBe(2);
    expect(date()).toBeDefined();
  });
});

describe('a toggle keeps a link another toggle wrote in between', () => {
  // Review on #1031 (6133265985): toggle-off deleted A, the foreign key nulled
  // the link, a toggle-on linked B, and toggle-off's unconditional unlink then
  // cleared B, leaving B on the calendar with nothing pointing at it.
  it('a toggle-off whose unlink lands after a toggle-on linked B leaves B linked and reports the conflict (foreign key on)', async () => {
    const a = await onTheCalendar();
    const fk = withSetNullOnEventDelete(db);
    const stale = holdWrites(fk.client, 'relationship_dates', 'update');
    h.db = stale.client;
    const turningOff = relationship.toggleDateOnCalendarAction('date-1');
    await vi.waitFor(() => expect(stale.held).toHaveLength(1));
    expect(fk.cleared).toEqual(['date-1']);
    expect(link()).toBeNull();
    expect(event(a)).toBeUndefined();

    h.db = fk.client;
    expect(await relationship.toggleDateOnCalendarAction('date-1')).toMatchObject({ ok: true, onCalendar: true });
    const b = link()!;
    expect(b).toBeTruthy();
    expect(b).not.toBe(a);
    expect(event(b)).toBeTruthy();

    stale.held[0].release();
    expect(await turningOff).toEqual({ ok: false, error: 'actions.theDateWasPutBackOnTheCalendarWhileSaving' });
    expect(link()).toBe(b);
    expect(event(b)).toBeTruthy();
  });

  it('control: a toggle-off after the foreign key already nulled the link is a clean success', async () => {
    const a = await onTheCalendar();
    h.db = withSetNullOnEventDelete(db).client;

    expect(await relationship.toggleDateOnCalendarAction('date-1')).toEqual({ ok: true, onCalendar: false, eventId: null });
    expect(link()).toBeNull();
    expect(event(a)).toBeUndefined();
  });

  it('control: a toggle-off with no foreign key in play clears the link it removed', async () => {
    const a = await onTheCalendar();

    expect(await relationship.toggleDateOnCalendarAction('date-1')).toEqual({ ok: true, onCalendar: false, eventId: null });
    expect(link()).toBeNull();
    expect(event(a)).toBeUndefined();
  });

  it('two toggles on at once leave one event linked and remove the loser\'s duplicate', async () => {
    const first = holdWrites(db, 'relationship_dates', 'update');
    h.db = first.client;
    const firstOn = relationship.toggleDateOnCalendarAction('date-1');
    await vi.waitFor(() => expect(first.held).toHaveLength(1));
    expect(events()).toHaveLength(1);

    h.db = db;
    expect(await relationship.toggleDateOnCalendarAction('date-1')).toMatchObject({ ok: true, onCalendar: true });
    const winner = link()!;
    expect(events()).toHaveLength(2);

    first.held[0].release();
    expect(await firstOn).toEqual({ ok: true, onCalendar: true, eventId: winner });
    expect(link()).toBe(winner);
    expect(events().map((e) => e.id)).toEqual([winner]);
  });
});

describe('a losing toggle-on reports the winner only if it is still there after its cleanup', () => {
  // Review on #1031 (AUD-1031-TOGGLE-WINNER): the loser read the winner B,
  // awaited the deletion of its own duplicate, and answered "on the calendar
  // as B" from the read before it, though a removal in that wait had deleted
  // the date and B.
  it('a removal during the loser\'s cleanup: the loser does not claim the deleted event', async () => {
    const linkHold = holdWrites(db, 'relationship_dates', 'update');
    const cleanupHold = holdWrites(linkHold.client, 'calendar_events', 'delete');
    h.db = cleanupHold.client;
    const loser = relationship.toggleDateOnCalendarAction('date-1');
    await vi.waitFor(() => expect(linkHold.held).toHaveLength(1));

    h.db = db;
    expect(await relationship.toggleDateOnCalendarAction('date-1')).toMatchObject({ ok: true, onCalendar: true });
    const b = link()!;
    expect(event(b)).toBeTruthy();

    linkHold.held[0].release();
    await vi.waitFor(() => expect(cleanupHold.held).toHaveLength(1));

    h.db = withSetNullOnEventDelete(db).client;
    expect(await relationship.removeRelationshipDateAction('date-1')).toEqual({ ok: true });
    expect(date()).toBeUndefined();
    expect(event(b)).toBeUndefined();

    cleanupHold.held[0].release();
    expect(await loser).toEqual({ ok: false, error: 'actions.thatDateCouldNotBe' });
    expect(events()).toEqual([]);
  });
});

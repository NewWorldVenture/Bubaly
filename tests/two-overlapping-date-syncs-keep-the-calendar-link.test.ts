import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// `syncDateOnCalendarAction` read the calendar service's `notFound` as "the
// event is gone" and cleared the date's `calendar_event_id`, reporting success.
// But the service answers `notFound` for a second thing too: its update is
// guarded on the start, end and all-day it read a moment before, so a write
// that lands in between — another sync of the same date (two tabs, a double
// save), an edit on the calendar itself — makes the guard match nothing. Two
// overlapping syncs therefore unlinked an event that was still there, said
// done, and the next sync treated the date as off the calendar.
//
// Driven through the real action and the real calendar service against an
// in-memory database. The only thing added is a barrier on the guarded event
// UPDATE: each sync is held there once it has read the event, and the test
// lets the two writes through one at a time.

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

/**
 * The same client, with every UPDATE of `calendar_events` held before it runs.
 * A held write executes when released — against the table as it stands THEN,
 * which is what lets the first write move the event under the second.
 */
function withEventWriteBarrier(target: InMemorySupabase) {
  const held: { release: () => void }[] = [];
  /** Event reads that ran before any write: the service's snapshot of the clock. */
  const snapshots: number[] = [];
  const client = new Proxy(target, {
    get(object, property, receiver) {
      if (property !== 'from') return Reflect.get(object, property, receiver);
      return (table: string) => {
        const builder = object.from(table);
        if (table !== 'calendar_events') return builder;
        let writing = false;
        const proxy: object = new Proxy(builder, {
          get(inner, key) {
            const value = Reflect.get(inner, key);
            if (typeof value !== 'function') return value;
            return (...args: unknown[]) => {
              if (key === 'update' || key === 'delete') writing = true;
              const runs = key === 'maybeSingle' || key === 'single' || key === 'then';
              if (runs && !writing) snapshots.push(snapshots.length + 1);
              if (runs && writing) {
                return new Promise((resolve, reject) => {
                  held.push({
                    release: () => {
                      try { resolve(Reflect.apply(value, inner, args)); } catch (error) { reject(error); }
                    },
                  });
                });
              }
              const result = Reflect.apply(value, inner, args);
              return result === inner ? proxy : result;
            };
          },
        });
        return proxy;
      };
    },
  });
  return { client, held, snapshots };
}

const link = () => db.table('relationship_dates')[0].calendar_event_id as string | null;
const event = (id: string) => db.table('calendar_events').find((e) => e.id === id && e.family_id === FAMILY);

describe('two syncs of one date, overlapping on its calendar event', () => {
  it('the one whose guarded write loses keeps the link and asks to try again, rather than unlinking a live event', async () => {
    expect((await relationship.toggleDateOnCalendarAction('date-1')).ok).toBe(true);
    const eventId = link();
    expect(eventId).toBeTruthy();
    expect(event(eventId!)).toMatchObject({ starts_at: '2026-11-14T00:00:00.000Z' });

    // The anniversary moves a week; two saves each ask for the event to follow.
    Object.assign(db.table('relationship_dates')[0], { event_date: '2026-11-21' });
    const barrier = withEventWriteBarrier(db);
    h.db = barrier.client;
    const outcomes: { ok: boolean; error?: string }[] = [];
    const first = relationship.syncDateOnCalendarAction('date-1').then((r) => { outcomes.push(r); return r; });
    const second = relationship.syncDateOnCalendarAction('date-1').then((r) => { outcomes.push(r); return r; });

    // Both have read the event as it was (the 14th) and are at the guarded write.
    await vi.waitFor(() => expect(barrier.held).toHaveLength(2));
    expect(barrier.snapshots).toHaveLength(2);

    // One write lands and moves the event to the 21st...
    barrier.held[0].release();
    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toEqual({ ok: true });
    expect(event(eventId!)).toMatchObject({ starts_at: '2026-11-21T00:00:00.000Z' });

    // ...then the other, whose guard still names the 14th.
    barrier.held[1].release();
    await Promise.all([first, second]);

    expect(outcomes[1]).toEqual({ ok: false, error: 'actions.theCalendarEventChangedWhileSaving' });
    // No false success, and no unlink: the date still points at its event,
    // which is still on the calendar, on the day the date says.
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(link()).toBe(eventId);
    expect(event(eventId!)).toMatchObject({ starts_at: '2026-11-21T00:00:00.000Z' });
  });

  it('an event that really is gone is still unlinked, and the sync succeeds', async () => {
    expect((await relationship.toggleDateOnCalendarAction('date-1')).ok).toBe(true);
    const eventId = link()!;
    // Deleted from the calendar itself.
    db.replace('calendar_events', db.table('calendar_events').filter((e) => e.id !== eventId));
    Object.assign(db.table('relationship_dates')[0], { event_date: '2026-11-21' });

    expect(await relationship.syncDateOnCalendarAction('date-1')).toEqual({ ok: true });
    expect(link()).toBeNull();
  });

  it('a re-check that cannot be read keeps the link: unknown is not gone', async () => {
    expect((await relationship.toggleDateOnCalendarAction('date-1')).ok).toBe(true);
    const eventId = link()!;
    db.replace('calendar_events', db.table('calendar_events').filter((e) => e.id !== eventId));
    // The service's own read answers (no row); the action's re-check after it fails.
    let eventReads = 0;
    h.db = new Proxy(db, {
      get(object, property, receiver) {
        if (property !== 'from') return Reflect.get(object, property, receiver);
        return (table: string) => {
          const builder = object.from(table);
          if (table !== 'calendar_events') return builder;
          return new Proxy(builder, {
            get(inner, key) {
              const value = Reflect.get(inner, key);
              if (key !== 'maybeSingle' || typeof value !== 'function') return value;
              return (...args: unknown[]) => (++eventReads === 2
                ? Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null } })
                : Reflect.apply(value, inner, args));
            },
          });
        };
      },
    });

    expect(await relationship.syncDateOnCalendarAction('date-1')).toEqual({ ok: false, error: 'actions.couldNotUpdateYourCalendar' });
    expect(eventReads).toBe(2);
    expect(link()).toBe(eventId);
  });

  it('an event in ANOTHER family is gone as far as this one is concerned, and is not touched', async () => {
    db.seed('calendar_events', [{ id: 'foreign-event', family_id: 'family-2', title: 'Theirs', starts_at: '2026-11-14T00:00:00.000Z', all_day: true }]);
    Object.assign(db.table('relationship_dates')[0], { calendar_event_id: 'foreign-event' });

    expect(await relationship.syncDateOnCalendarAction('date-1')).toEqual({ ok: true });
    expect(link()).toBeNull();
    expect(db.table('calendar_events').find((e) => e.id === 'foreign-event')).toMatchObject({ family_id: 'family-2', title: 'Theirs' });
  });
});

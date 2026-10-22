// N8 — a relative routine ("two days before every trip") fired at the
// `next_run_at` it was armed with, whatever had happened to its anchor since.
// Nothing re-arms a relative routine when its anchor row changes, so a
// cancelled trip still filed a request on its old date, and a trip moved later
// fired at the old time and then — re-armed from the same trip at its new date
// — again: routine_runs is keyed on (rule_id, due_at), and two different
// instants pass it.
//
// N11 — the anchor's day was its column's first ten characters. For the event,
// school-event and game anchors that column is a timestamptz, so the day was
// Greenwich's: a 6pm game in Los Angeles is 01:00Z the next day, and "the day
// before every game" fired on game day; an 8am event in Tokyo is the previous
// day in Greenwich, and it fired a day early. An all-day calendar row is
// stored at Greenwich midnight of its own date, so its stored date stands.
//
// The real routine cron and the real nextRelativeFire, over the in-memory
// database. What a filed occurrence then does (request, plan, run) has its own
// suites; here it is counted.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, filed: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/services/ai-settings', () => ({ loadAISettings: async () => ({ ok: true, data: { enabled: true } }) }));
vi.mock('@/lib/ai/runs/entitlement', () => ({ agentRunEntitlementChecker: () => async () => 'entitled' }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => {} }));
vi.mock('@/lib/ai/runs/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/runs/store')>()),
  createRequest: async (_scope: unknown, input: { requestText: string }) => {
    h.filed.push(input.requestText);
    return { ok: true, data: { id: `req-${h.filed.length}` } };
  },
  createRun: async () => ({ ok: true, data: { id: 'run-1' } }),
  updateRequest: async () => ({ ok: true }),
}));
vi.mock('@/lib/ai/runs/intake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/runs/intake')>()),
  planRoutineRequest: async () => ({ ok: true, data: { runId: 'run-1', outcome: 'answer' } }),
}));

const { GET: tick } = await import('@/app/api/cron/family-routines/route');
const { nextRelativeFire } = await import('@/lib/services/routines');
const { anchorByKey } = await import('@/lib/services/routines/anchors');

type DB = SupabaseClient<Database>;
const FAMILY = 'fam-routines';
const RULE = 'rule-trip';
let db: InMemorySupabase;

const at = (iso: string) => { vi.setSystemTime(new Date(iso)); return tick(new NextRequest('https://bubaly.test/api/cron/family-routines')); };
const rule = () => db.table('family_automation_rules').find((r) => r.id === RULE)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  db = createInMemorySupabase({ uniques: { routine_runs: [['rule_id', 'due_at']] } });
  h.db = db;
  h.filed = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, timezone: 'America/New_York', closed_at: null }]);
  // "Two days before every trip, make sure we're ready", armed for the trip on
  // 20 October: 9am New York on the 18th.
  db.seed('vacations', [{ id: 'trip-1', family_id: FAMILY, title: 'Lake house', start_date: '2026-10-20', end_date: '2026-10-24' }]);
  db.seed('family_automation_rules', [{
    id: RULE, family_id: FAMILY, name: 'Trip prep', action_config: { prompt: 'Make sure we are ready for the trip' },
    schedule_kind: 'relative', schedule_expr: null, anchor_key: 'trip', offset_days: -2, at_hour: 9,
    said: 'two days before every trip', is_enabled: true, next_run_at: '2026-10-18T13:00:00.000Z',
  }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('N8 — a relative routine fires for the anchor as it is now', () => {
  it('fires once for a trip that did not change', async () => {
    const res = await at('2026-10-18T13:05:00Z');
    expect(res.status).toBe(200);
    expect(h.filed).toEqual(['Make sure we are ready for the trip']);
  });

  it('files nothing for a trip that was cancelled, and waits for the next one', async () => {
    db.replace('vacations', []);
    const res = await at('2026-10-18T13:05:00Z');
    expect(res.status).toBe(200);
    expect(h.filed).toEqual([]);
    expect(db.table('routine_runs')).toEqual([]);
    expect(rule().next_run_at).toBeNull();
  });

  it('a failed anchor read loses nothing: the rule stays on its occurrence, and the next tick files it', async () => {
    // The re-check used to read a failed read as "the trip is gone": it moved
    // the rule to null, and the next tick armed it from its own `now`, after
    // the 9am this trip was due at, so the occurrence was never filed.
    let failing = true;
    h.db = withFaults(db, (table) => (failing && table === 'vacations' ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));

    const first = await at('2026-10-18T13:05:00Z');
    expect(first.status, 'a tick that could not read an anchor answered as if clean').toBe(502);
    expect(h.filed).toEqual([]);
    expect(db.table('routine_runs')).toEqual([]);
    expect(rule().next_run_at).toBe('2026-10-18T13:00:00.000Z');

    failing = false;
    const second = await at('2026-10-18T13:10:00Z');
    expect(second.status).toBe(200);
    expect(h.filed).toEqual(['Make sure we are ready for the trip']);
    expect(db.table('routine_runs').map((r) => r.due_at)).toEqual(['2026-10-18T13:00:00.000Z']);
  });

  it('fires ONCE for a trip that moved later: at the new time, not at both', async () => {
    db.table('vacations')[0].start_date = '2026-10-25';
    db.table('vacations')[0].end_date = '2026-10-29';

    await at('2026-10-18T13:05:00Z');
    expect(h.filed).toEqual([]);
    expect(rule().next_run_at).toBe('2026-10-23T13:00:00.000Z');

    await at('2026-10-23T13:05:00Z');
    expect(h.filed).toEqual(['Make sure we are ready for the trip']);
    expect(db.table('routine_runs').map((r) => r.due_at)).toEqual(['2026-10-23T13:00:00.000Z']);
  });
});

describe('N8 — a busy calendar does not crowd out the event a routine counts back from', () => {
  // "The day before every event, at 9am", due 9am New York on Monday 19
  // October for a 3pm event on Tuesday the 20th. The anchor read takes twenty
  // rows, ascending from its lower bound, and that bound began days before any
  // row that could still fire: twenty-three events on the Monday itself filled
  // it, the Tuesday event was never read, and the re-check moved the routine
  // off a real occurrence.
  const EVENT_RULE = {
    id: RULE, family_id: FAMILY, name: 'Event prep', action_config: { prompt: 'Get us ready for tomorrow' },
    schedule_kind: 'relative', schedule_expr: null, anchor_key: 'event', offset_days: -1, at_hour: 9,
    said: 'the day before every event', is_enabled: true, next_run_at: '2026-10-19T13:00:00.000Z',
  };
  const monday = (i: number, iso: string) => ({ id: `busy-${i}`, family_id: FAMILY, title: `Busy ${i}`, starts_at: iso, all_day: false });

  beforeEach(() => {
    db.replace('family_automation_rules', [EVENT_RULE]);
    db.seed('calendar_events', [
      // Twenty from 10am to 7:30pm on the Monday, and three that evening after
      // 8pm, which in Greenwich is already Tuesday.
      ...Array.from({ length: 20 }, (_, i) => monday(i, new Date(Date.parse('2026-10-19T14:00:00Z') + i * 30 * 60_000).toISOString())),
      monday(20, '2026-10-20T00:30:00.000Z'), monday(21, '2026-10-20T01:30:00.000Z'), monday(22, '2026-10-20T03:30:00.000Z'),
      { id: 'the-event', family_id: FAMILY, title: 'Parents evening', starts_at: '2026-10-20T19:00:00.000Z', all_day: false },
    ]);
  });

  it('fires for Tuesday\'s event on Monday at 9am', async () => {
    const res = await at('2026-10-19T13:05:00Z');
    expect(res.status).toBe(200);
    expect(h.filed).toEqual(['Get us ready for tomorrow']);
    expect(db.table('routine_runs').map((r) => r.due_at)).toEqual(['2026-10-19T13:00:00.000Z']);
  });

  it('and an all-day event on the Tuesday still counts', async () => {
    db.replace('calendar_events', [
      ...db.table('calendar_events').filter((e) => e.id !== 'the-event'),
      { id: 'the-event', family_id: FAMILY, title: 'Picture day', starts_at: '2026-10-20T00:00:00Z', all_day: true },
    ]);
    const fire = await nextRelativeFire(db as unknown as DB, FAMILY, {
      kind: 'relative', anchor: anchorByKey('event')!, offsetDays: -1, atHour: 9, said: 'the day before every event',
    }, new Date('2026-10-19T12:59:59.999Z'), 'America/New_York');
    expect(fire?.toISOString()).toBe('2026-10-19T13:00:00.000Z');
  });

  it('armed on Sunday after 9am, it skips Monday\'s events, whose 9am has passed, for Tuesday\'s', async () => {
    const fire = await nextRelativeFire(db as unknown as DB, FAMILY, {
      kind: 'relative', anchor: anchorByKey('event')!, offsetDays: -1, atHour: 9, said: 'the day before every event',
    }, new Date('2026-10-18T14:00:00Z'), 'America/New_York');
    expect(fire?.toISOString()).toBe('2026-10-19T13:00:00.000Z');
  });

  it('nor do Monday evening\'s events, which are Tuesday in Greenwich', async () => {
    // An all-day row is read from Greenwich midnight of its own date, which in
    // New York is 8pm the evening before; a timed row only from New York's
    // midnight. Twenty events between 8pm and midnight on the Monday are read
    // by neither.
    db.replace('calendar_events', [
      ...Array.from({ length: 20 }, (_, i) => monday(i, new Date(Date.parse('2026-10-20T00:00:00Z') + i * 12 * 60_000).toISOString())),
      { id: 'the-event', family_id: FAMILY, title: 'Parents evening', starts_at: '2026-10-20T19:00:00.000Z', all_day: false },
    ]);
    const fire = await nextRelativeFire(db as unknown as DB, FAMILY, {
      kind: 'relative', anchor: anchorByKey('event')!, offsetDays: -1, atHour: 9, said: 'the day before every event',
    }, new Date('2026-10-19T12:59:59.999Z'), 'America/New_York');
    expect(fire?.toISOString()).toBe('2026-10-19T13:00:00.000Z');
  });
});

describe('N11 — an event anchor counts back from the family\'s day, not Greenwich\'s', () => {
  const from = new Date('2026-10-14T00:00:00Z');
  const dayBefore = (key: string) => ({ kind: 'relative' as const, anchor: anchorByKey(key)!, offsetDays: -1, atHour: 9, said: 'the day before' });

  it('a 6pm game in Los Angeles: "the day before" is the day before, at 9am there', async () => {
    db.seed('sports_events', [{ id: 'g-1', family_id: FAMILY, title: 'Game', starts_at: '2026-10-21T01:00:00Z' }]);
    const fire = await nextRelativeFire(db as unknown as DB, FAMILY, dayBefore('game'), from, 'America/Los_Angeles');
    // Game day is Tuesday 20 October in Los Angeles; the day before, 9am PDT.
    expect(fire?.toISOString()).toBe('2026-10-19T16:00:00.000Z');
  });

  it('an 8am school event in Tokyo: the day before is not two days before', async () => {
    db.seed('school_events', [{ id: 's-1', family_id: FAMILY, title: 'Sports day', starts_at: '2026-10-20T23:00:00Z' }]);
    const fire = await nextRelativeFire(db as unknown as DB, FAMILY, dayBefore('school_event'), from, 'Asia/Tokyo');
    // The event is Wednesday 21 October in Tokyo; the day before, 9am JST.
    expect(fire?.toISOString()).toBe('2026-10-20T00:00:00.000Z');
  });

  it('an all-day calendar event keeps its own date, west of Greenwich too', async () => {
    db.seed('calendar_events', [{ id: 'e-1', family_id: FAMILY, title: 'Picture day', starts_at: '2026-10-20T00:00:00Z', all_day: true }]);
    const fire = await nextRelativeFire(db as unknown as DB, FAMILY, dayBefore('event'), from, 'America/Los_Angeles');
    expect(fire?.toISOString()).toBe('2026-10-19T16:00:00.000Z');
  });

  it('a timed calendar event in Los Angeles in the evening is its local day', async () => {
    db.seed('calendar_events', [{ id: 'e-2', family_id: FAMILY, title: 'Recital', starts_at: '2026-10-21T02:30:00Z', all_day: false }]);
    const fire = await nextRelativeFire(db as unknown as DB, FAMILY, dayBefore('event'), from, 'America/Los_Angeles');
    expect(fire?.toISOString()).toBe('2026-10-19T16:00:00.000Z');
  });
});

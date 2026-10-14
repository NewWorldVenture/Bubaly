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
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

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

import { afterEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadMoneyTimeline, loadMoneyTimelineInput, planCommitments } from '@/lib/finance/timeline-load';

// The Financial Copilot's loader used to build its day key with
// `now.toISOString().slice(0, 10)` — the day at GREENWICH — and then spend it
// three ways: as the lower bound on `vacations.start_date` (a DATE column, so
// already the family's day), as the date an undated subscription starts
// accruing, and as the `now` it hands the pure brain, which reads only that
// value's UTC calendar date.
//
// At 18:30 on a Sunday in Los Angeles the Greenwich key is Monday's, so all
// three answered for a day the family had not reached:
//
//   - a trip departing that Sunday was filtered out as already gone;
//   - an undated subscription on the 30th accrued from the 1st of the month
//     after the family's;
//   - the brain seeded its buckets from the week of the 21st, so the week the
//     family was actually living in never existed and a bill due that Sunday
//     dropped out of the projection entirely.
//
// Every case below fixes BOTH the instant and the zone, because "unbound" is
// not a zone — it is whatever the machine says — and the expected values are
// hand-computed properties of (instant, zone) pairs, true on any host. The
// zones are named on both sides of Greenwich: at 01:30Z the family in Los
// Angeles is still on the previous day, and at 22:00Z the family in Tokyo is
// already on the next one.

/** 01:30 UTC Monday — still 18:30 Sunday in Los Angeles. */
const WEST_OF_GREENWICH = new Date('2026-09-21T01:30:00Z');
/** 22:00 UTC Sunday — already 07:00 Monday in Tokyo. */
const EAST_OF_GREENWICH = new Date('2026-09-20T22:00:00Z');

type Case = {
  tz: string;
  now: Date;
  /** The family's day at that instant. */
  day: string;
  /** The day before it, on the family's calendar. */
  dayBefore: string;
  /** Monday of the ISO week containing `day` — where the forecast must start. */
  week: string;
  /** `day` + 91 days on the family's calendar (the loader's 13-week read bound). */
  horizonEnd: string;
  /** Local midnight of `day`, as the instant the events window starts at. */
  midnightIso: string;
};

// 2026-09-21 is a Monday, so 2026-09-20 is the Sunday before it.
const CASES: Case[] = [
  { tz: 'UTC', now: WEST_OF_GREENWICH, day: '2026-09-21', dayBefore: '2026-09-20', week: '2026-09-21', horizonEnd: '2026-12-21', midnightIso: '2026-09-21T00:00:00.000Z' },
  // The case the defect was measured on: Greenwich is already Monday here.
  // Its horizon also crosses the 2026-11-01 fall-back, so a 91-day hop made of
  // fixed milliseconds from local midnight lands at 23:00 on 2026-12-19 and
  // reads as the 19th. The expected 20th is what makes that hop's absence
  // load-bearing.
  { tz: 'America/Los_Angeles', now: WEST_OF_GREENWICH, day: '2026-09-20', dayBefore: '2026-09-19', week: '2026-09-14', horizonEnd: '2026-12-20', midnightIso: '2026-09-20T07:00:00.000Z' },
  { tz: 'Asia/Tokyo', now: WEST_OF_GREENWICH, day: '2026-09-21', dayBefore: '2026-09-20', week: '2026-09-21', horizonEnd: '2026-12-21', midnightIso: '2026-09-20T15:00:00.000Z' },
  // The mirror image: Greenwich is still Sunday and the family is not.
  { tz: 'UTC', now: EAST_OF_GREENWICH, day: '2026-09-20', dayBefore: '2026-09-19', week: '2026-09-14', horizonEnd: '2026-12-20', midnightIso: '2026-09-20T00:00:00.000Z' },
  { tz: 'Asia/Tokyo', now: EAST_OF_GREENWICH, day: '2026-09-21', dayBefore: '2026-09-20', week: '2026-09-21', horizonEnd: '2026-12-21', midnightIso: '2026-09-20T15:00:00.000Z' },
  { tz: 'Pacific/Kiritimati', now: EAST_OF_GREENWICH, day: '2026-09-21', dayBefore: '2026-09-20', week: '2026-09-21', horizonEnd: '2026-12-21', midnightIso: '2026-09-20T10:00:00.000Z' },
];

const label = (c: Case) => `${c.tz} at ${c.now.toISOString()}`;

// ── A Supabase stub that records what it was filtered by ────────────────────
type Reply = { data: unknown; error: unknown };
type Filter = { table: string; op: string; column: string; value: unknown };

function fakeSupabase(results: Record<string, Reply>, filters: Filter[] = []): SupabaseClient<Database> {
  const chain = (table: string, result: Reply) => {
    const c: Record<string, unknown> = {};
    for (const m of ['select', 'order', 'limit']) c[m] = () => c;
    for (const op of ['eq', 'neq', 'in', 'gte', 'lte', 'gt', 'lt']) {
      c[op] = (column: string, value: unknown) => { filters.push({ table, op, column, value }); return c; };
    }
    c.range = (from: number, to: number) => ({
      then: (res: (v: Reply) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(
        Array.isArray(result.data) ? { ...result, data: result.data.slice(from, to + 1) } : result,
      ).then(res, rej),
    });
    c.then = (res: (v: Reply) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej);
    return c;
  };
  return { from: (table: string) => chain(table, results[table] ?? { data: [], error: null }) } as unknown as SupabaseClient<Database>;
}

function bound(filters: Filter[], table: string, op: string, column: string): unknown {
  const hit = filters.find((f) => f.table === table && f.op === op && f.column === column);
  expect(hit, `${table}.${op}('${column}') should have been applied`).toBeDefined();
  return hit!.value;
}

const project = { title: 'Fence', status: 'in_progress', budget_cents: 45_000, target_start: null, target_end: null };

describe("the money forecast asks the family's day, not Greenwich's", () => {
  it.each(CASES)('places an undated in-progress project on the family today ($tz, $day)', (c) => {
    const plans = planCommitments({
      subscriptions: [], vacations: [], vacationBudgets: [], vacationExpenses: [], moves: [],
      projects: [project],
    }, c.tz, c.now);
    expect(plans.map((p) => p.date), label(c)).toEqual([c.day]);
  });

  it.each(CASES)('keeps a trip departing on the family today and drops the one that left ($tz, $day)', (c) => {
    const plans = planCommitments({
      subscriptions: [], vacationBudgets: [], vacationExpenses: [], moves: [], projects: [],
      vacations: [
        { id: 'v-today', title: 'Leaves today', start_date: c.day, status: 'booked', budget_cents: 100_000 },
        { id: 'v-gone', title: 'Already gone', start_date: c.dayBefore, status: 'booked', budget_cents: 100_000 },
      ],
    }, c.tz, c.now);
    expect(plans.map((p) => p.label), label(c)).toEqual(['Leaves today']);
    // `start_date` is a DATE column: it is ALREADY the family's day, so it is
    // forwarded exactly as it arrived. Binding a zone to it here would move the
    // departure a day — the same error as the one above, in the other direction.
    expect(plans[0].date, label(c)).toBe(c.day);
  });

  // Month ends are where a Greenwich day key costs a whole month rather than a
  // day: at 19:00 on the 30th in Los Angeles, Greenwich has already turned over,
  // so the accrual skipped the month the family was about to start.
  it.each([
    { tz: 'UTC', now: '2026-10-01T02:00:00Z', accruesFrom: '2026-11-01' },
    { tz: 'America/Los_Angeles', now: '2026-10-01T02:00:00Z', accruesFrom: '2026-10-01' },
    { tz: 'Asia/Tokyo', now: '2026-10-01T02:00:00Z', accruesFrom: '2026-11-01' },
    // …and across a year boundary, where the month arithmetic has to roll over.
    { tz: 'UTC', now: '2027-01-01T02:00:00Z', accruesFrom: '2027-02-01' },
    { tz: 'America/Los_Angeles', now: '2027-01-01T02:00:00Z', accruesFrom: '2027-01-01' },
  ])('accrues an undated subscription from the 1st of the family\'s next month ($tz, $now)', ({ tz, now, accruesFrom }) => {
    const plans = planCommitments({
      vacations: [], vacationBudgets: [], vacationExpenses: [], moves: [], projects: [],
      subscriptions: [{ name: 'Cloud backup', cost_cents: 12_000, cadence: 'yearly', status: 'trial', next_charge: null, category: null }],
    }, tz, new Date(now));
    expect(plans.map((p) => p.date), `${tz} at ${now}`).toEqual([accruesFrom]);
  });

  it.each(CASES)('bounds the DATE and timestamptz reads on the family calendar ($tz, $day)', async (c) => {
    const filters: Filter[] = [];
    await loadMoneyTimelineInput(fakeSupabase({}, filters), 'fam-1', c.tz, c.now);

    // A DATE column is bounded by family day keys, compared as text.
    expect(bound(filters, 'vacations', 'gte', 'start_date'), label(c)).toBe(c.day);
    expect(bound(filters, 'vacations', 'lte', 'start_date'), label(c)).toBe(c.horizonEnd);
    // The one timestamptz column is bounded by instants — local midnight of the
    // family's today, and local midnight after the horizon's last family day.
    expect(bound(filters, 'calendar_events', 'gte', 'starts_at'), label(c)).toBe(c.midnightIso);
    expect(typeof bound(filters, 'calendar_events', 'lt', 'starts_at')).toBe('string');
  });

  it.each(CASES)('hands the brain the family day, so the forecast starts on the family week ($tz, $week)', async (c) => {
    const supabase = fakeSupabase({
      financial_accounts: { data: [{ balance: 5_000, type: 'checking' }], error: null },
      // Due on the family's today — inside the forecast in every zone.
      bills: { data: [{ name: 'Rent', amount: 1_000, due_date: c.day, is_recurring: false, recurrence: null, status: 'upcoming', category: null, autopay: false }], error: null },
      // Happening at this very instant, wherever the family is.
      calendar_events: { data: [{ title: 'Soccer final', starts_at: c.now.toISOString() }], error: null },
    });

    const input = await loadMoneyTimelineInput(supabase, 'fam-1', c.tz, c.now);
    expect(input.now?.getTime(), label(c)).toBe(Date.parse(`${c.day}T00:00:00Z`));

    const timeline = await loadMoneyTimeline(supabase, 'fam-1', c.tz, c.now);
    expect(timeline.weeks[0].weekStart, label(c)).toBe(c.week);
    // A bill due today is money this family still has to find; it must be in
    // the forecast, in the week the family is living in.
    expect(timeline.weeks[0].moments.map((m) => m.label), label(c)).toEqual(['Rent']);
    expect(timeline.totalOutflow, label(c)).toBe(1_000);
    // …and an event happening now is overlaid on that same week, not on the
    // week Greenwich's clock would put it in.
    expect(timeline.weeks[0].events, label(c)).toEqual(['Soccer final']);
  });
});

describe("and the answer does not depend on the host's clock", () => {
  const original = process.env.TZ;
  afterEach(() => { process.env.TZ = original; });

  // Every zone above is explicit, so the machine running the suite must not be
  // able to change a single one of these answers. A host zone is not a family
  // zone, and a test that reads one for the other proves nothing off this box.
  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati'])('is the same under a host in %s', async (host) => {
    process.env.TZ = host;
    for (const c of CASES) {
      const filters: Filter[] = [];
      const supabase = fakeSupabase({
        financial_accounts: { data: [{ balance: 5_000, type: 'checking' }], error: null },
        bills: { data: [{ name: 'Rent', amount: 1_000, due_date: c.day, is_recurring: false, recurrence: null, status: 'upcoming', category: null, autopay: false }], error: null },
      }, filters);
      const timeline = await loadMoneyTimeline(supabase, 'fam-1', c.tz, c.now);
      expect(bound(filters, 'vacations', 'gte', 'start_date'), `${label(c)} on a host in ${host}`).toBe(c.day);
      expect(bound(filters, 'vacations', 'lte', 'start_date'), `${label(c)} on a host in ${host}`).toBe(c.horizonEnd);
      expect(timeline.weeks[0].weekStart, `${label(c)} on a host in ${host}`).toBe(c.week);
      expect(timeline.weeks[0].moments.map((m) => m.label), `${label(c)} on a host in ${host}`).toEqual(['Rent']);
    }
  });
});

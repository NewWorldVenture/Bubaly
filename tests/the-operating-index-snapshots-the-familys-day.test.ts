// The Family Operating Index snapshots a DAY, and the day belongs to the family.
//
// `family_operating_index.as_of_date` is a DATE column — 0125_family_operating_index.sql:19
// calls it "the local day this snapshot represents" — and `lib/operating-index/server.ts`
// used to fill it with `now.toISOString().slice(0, 10)`: the day at GREENWICH.
// Three things rode on that one key and all three were wrong together, which is
// why the defect was invisible from inside the module:
//
//   1. the upsert key, so a family in Los Angeles opening the page at 18:30
//      wrote the snapshot under TOMORROW, and the next morning's visit found
//      that row already there and overwrote it — one of the two days simply
//      never existed;
//   2. the `.lt('as_of_date', today)` anchor the "since yesterday" recap reads
//      the prior snapshot with, which therefore skipped a day;
//   3. the DATE horizons in the snapshot build — `bills.due_date` (+14),
//      `documents.expires_at` (+30) and `goals.target_date` (+30) — all
//      compared against a Greenwich key, and all of those columns already hold
//      the family's day.
//
// The orchestrator had the same defect in its other spelling: "tomorrow" was
// `setUTCHours(0, 0, 0, 0)` plus one day, so "what's most likely to go wrong
// tomorrow?" was answered over 17:00-to-17:00 in Los Angeles — it missed
// tomorrow's morning entirely and counted the following evening as tomorrow.
//
// EVERY case below names its zone and pins its instant. Nothing here reads the
// host's zone, so the assertions hold identically under TZ=UTC,
// TZ=America/Los_Angeles and TZ=Asia/Tokyo — which is the point: the previous
// code's answer depended on where the server happened to be standing.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { asOfDate, loadOperatingIndex } from '@/lib/operating-index/server';

const LOS_ANGELES = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';
const GREENWICH = 'UTC';

type Call = {
  table: string;
  kind: 'select' | 'upsert';
  filters: Record<string, unknown>;
  payload?: Record<string, unknown>;
};

/**
 * Enough PostgREST to let the whole snapshot build run against empty tables,
 * recording every filter and the upserted row. Empty tables are a real state (a
 * brand-new family), so the index still computes and every query still runs.
 */
function makeDb() {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    const reply = { data: [] as unknown[], error: null };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, in: chain, is: chain, or: chain, ilike: chain, not: chain,
      // A paged read stops at an empty page, so `.range()` has to slice.
      range: (start: number, end: number) => ({
        then: (resolve: (value: typeof reply) => void) => resolve({ ...reply, data: reply.data.slice(start, end + 1) }),
      }),
      eq: filter, neq: filter,
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      lte: (c: string, v: unknown) => filter(`lte:${c}`, v),
      gt: (c: string, v: unknown) => filter(`gt:${c}`, v),
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      upsert: (row: Record<string, unknown>) => { call.kind = 'upsert'; call.payload = row; return b; },
      single: () => Promise.resolve({ data: null, error: null }),
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      then: (resolve: (value: typeof reply) => void) => resolve(reply),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

/** Run the loader for one family zone and hand back what it asked the database. */
async function run(tz: string, now: Date) {
  const { db, calls } = makeDb();
  const result = await loadOperatingIndex(db, 'fam-1', tz, now);
  const snapshotRow = calls.find((c) => c.table === 'family_operating_index' && c.kind === 'upsert');
  const anchor = calls.find((c) => c.table === 'family_operating_index' && c.kind === 'select');
  return {
    asOf: result.asOf,
    upsertedDay: snapshotRow?.payload?.as_of_date,
    anchoredBefore: anchor?.filters['lt:as_of_date'],
    billsHorizon: calls.find((c) => c.table === 'bills')?.filters['lte:due_date'],
    docsHorizon: calls.find((c) => c.table === 'documents')?.filters['lte:expires_at'],
    expensesFloor: calls.find((c) => c.table === 'transactions')?.filters['gte:date'],
    // Only the orchestrator's "tomorrow" read bounds starts_at with `.lt()`;
    // every other calendar read uses `.lte()`.
    tomorrowFrom: calls.find((c) => c.table === 'calendar_events' && 'lt:starts_at' in c.filters)?.filters['gte:starts_at'],
    tomorrowUntil: calls.find((c) => c.table === 'calendar_events' && 'lt:starts_at' in c.filters)?.filters['lt:starts_at'],
  };
}

describe("the operating index snapshots the family's day, not Greenwich's", () => {
  // 05:30 UTC on the 21st. In Los Angeles it is 22:30 on the 20th — the seven
  // evening hours a day when the two calendars disagree, and the hours a family
  // is most likely to be looking at this page.
  const EVENING_IN_CALIFORNIA = new Date('2026-09-21T05:30:00Z');

  it('keys the snapshot on the day the family is living, and Greenwich is a different day', async () => {
    const california = await run(LOS_ANGELES, EVENING_IN_CALIFORNIA);
    expect(california.upsertedDay).toBe('2026-09-20');
    // The whole defect in one line: the key this used to write.
    expect(california.upsertedDay).not.toBe('2026-09-21');

    const tokyo = await run(TOKYO, EVENING_IN_CALIFORNIA);
    expect(tokyo.upsertedDay).toBe('2026-09-21');

    // Same instant, two households, two different — and both correct — days.
    expect(california.upsertedDay).not.toBe(tokyo.upsertedDay);
  });

  it('uses that one key for the anchor, the upsert and what it returns', async () => {
    // These three disagreeing is the half-conversion that breaks a recap: the
    // anchor would skip a day, or the upsert would land beside the row the
    // anchor looks for.
    for (const tz of [LOS_ANGELES, TOKYO, GREENWICH]) {
      const out = await run(tz, EVENING_IN_CALIFORNIA);
      expect(out.anchoredBefore, tz).toBe(out.upsertedDay);
      expect(out.asOf, tz).toBe(out.upsertedDay);
      expect(out.asOf, tz).toBe(asOfDate(EVENING_IN_CALIFORNIA, tz));
    }
  });

  it('bounds the DATE columns with calendar days counted from the family today', async () => {
    // bills.due_date (0006:98), documents.expires_at (0002:349) and
    // goals.target_date (0002:375) are DATE columns: they already hold the
    // family's day, so the horizon compared against them has to be one too.
    const california = await run(LOS_ANGELES, EVENING_IN_CALIFORNIA);
    expect(california.billsHorizon).toBe('2026-10-04');   // 2026-09-20 + 14 days
    expect(california.docsHorizon).toBe('2026-10-20');    // 2026-09-20 + 30 days

    const tokyo = await run(TOKYO, EVENING_IN_CALIFORNIA);
    expect(tokyo.billsHorizon).toBe('2026-10-05');        // 2026-09-21 + 14 days
    expect(tokyo.docsHorizon).toBe('2026-10-21');         // 2026-09-21 + 30 days
  });

  it('counts those horizons in days, not in fixed milliseconds, across a DST change', async () => {
    // 22:30 on 15 October in Los Angeles. Thirty days later is 14 November, and
    // the clocks go back on 1 November — so the local span is 30 days and ONE
    // HOUR. `new Date(midnight + 30 * 86_400_000)` lands at 23:00 on the 13th
    // and formats as 2026-11-13: a whole day of expiring documents dropped,
    // twice a year, in exactly the zones this conversion is for.
    const california = await run(LOS_ANGELES, new Date('2026-10-16T05:30:00Z'));
    expect(california.upsertedDay).toBe('2026-10-15');
    expect(california.billsHorizon).toBe('2026-10-29');
    expect(california.docsHorizon).toBe('2026-11-14');
  });
});

describe("the orchestrator's tomorrow is the family's tomorrow", () => {
  // 12:00 on Saturday 13 March 2027 in Los Angeles, where tomorrow — Sunday the
  // 14th — is the 23-hour spring-forward day. In Tokyo the same instant is
  // already 05:00 on Sunday the 14th, so its tomorrow is Monday the 15th.
  const SATURDAY_MIDDAY_IN_CALIFORNIA = new Date('2027-03-13T20:00:00Z');

  it('asks for the local day, from local midnight to local midnight', async () => {
    const california = await run(LOS_ANGELES, SATURDAY_MIDDAY_IN_CALIFORNIA);
    // Midnight on the 14th is still PST (UTC-8); midnight on the 15th is PDT
    // (UTC-7), because the clocks went forward in between.
    expect(california.tomorrowFrom).toBe('2027-03-14T08:00:00.000Z');
    expect(california.tomorrowUntil).toBe('2027-03-15T07:00:00.000Z');

    // Japan is nine hours AHEAD, so midnight on its 15th is 15:00 UTC on the
    // 14th — the same instant California is still calling Saturday afternoon.
    const tokyo = await run(TOKYO, SATURDAY_MIDDAY_IN_CALIFORNIA);
    expect(tokyo.tomorrowFrom).toBe('2027-03-14T15:00:00.000Z');
    expect(tokyo.tomorrowUntil).toBe('2027-03-15T15:00:00.000Z');
  });

  it('spans exactly one local day — 23 hours on the day the clocks go forward', async () => {
    const hours = async (tz: string) => {
      const out = await run(tz, SATURDAY_MIDDAY_IN_CALIFORNIA);
      return (Date.parse(String(out.tomorrowUntil)) - Date.parse(String(out.tomorrowFrom))) / 3_600_000;
    };
    // `startOfTomorrow + 86_400_000` would say 24 here, and would ask for the
    // first hour of the day after as if it were tomorrow.
    expect(await hours(LOS_ANGELES)).toBe(23);
    // Japan keeps no DST, so the same code has to produce a plain 24 there.
    expect(await hours(TOKYO)).toBe(24);
  });
});

describe('the one bound that is deliberately still UTC', () => {
  it('floors the expense fetch where inputs.ts starts its budget periods', async () => {
    // `countOverspentBudgets` gets its period starts from
    // lib/operating-index/inputs.ts, which resolves them in UTC. This floor is
    // the fetch bound for exactly those windows, so it is UTC too: a floor
    // LATER than the window it feeds silently undercounts a budget.
    //
    // If this assertion fails because inputs.ts learned about the family's
    // zone, the fix is to convert this floor IN THE SAME CHANGE, not to relax
    // the expectation — the two have to move together or not at all.
    const california = await run(LOS_ANGELES, new Date('2026-09-21T05:30:00Z'));
    expect(california.expensesFloor).toBe('2026-01-01');
  });
});

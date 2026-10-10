import { describe, it, expect } from 'vitest';
import {
  busyIntervals, mergeIntervals, freeGaps, findFreeSlots, isCalendarContext, CONTEXTS,
} from '@/lib/calendar/scheduling';

const H = (n: number) => n * 60 * 60 * 1000;

// A fixed base day, anchored to an EXPLICIT zone rather than the host's.
//
// This was `new Date(2030, 0, 7, 0, 0, 0, 0)` — the host's midnight — and the
// assertions read the result back with `getHours()`, also the host's. That was
// self-consistent while `findFreeSlots` used `setHours`, and it stopped being
// self-consistent the moment the function took a `tz`: passing 'UTC' to a
// fixture built in the host's zone makes the two halves of the test mean
// different days. Under TZ=UTC they agree and it passes; CI's second run under
// TZ=America/Los_Angeles is what caught it, which is exactly why that run
// exists.
//
// So both ends are pinned to one named zone now, and nothing here consults the
// host clock at all.
const ZONE = 'UTC';
const base = Date.parse('2030-01-07T00:00:00Z'); // Mon Jan 7 2030, 00:00 UTC
const at = (hour: number, min = 0) => new Date(base + H(hour) + min * 60 * 1000).toISOString();
/** The wall-clock hour of an instant in a named zone — never `getHours()`. */
const hourIn = (ms: number, tz: string) =>
  Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(new Date(ms))) % 24;

describe('isCalendarContext / CONTEXTS', () => {
  it('validates the three contexts', () => {
    expect(CONTEXTS).toEqual(['family', 'personal', 'work']);
    expect(isCalendarContext('work')).toBe(true);
    expect(isCalendarContext('nope')).toBe(false);
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping and adjacent intervals', () => {
    const m = mergeIntervals([{ start: 0, end: 10 }, { start: 5, end: 15 }, { start: 15, end: 20 }, { start: 30, end: 40 }]);
    expect(m).toEqual([{ start: 0, end: 20 }, { start: 30, end: 40 }]);
  });
});

describe('busyIntervals', () => {
  it('does not turn saved points into occupied intervals or split a continuous free gap', () => {
    const points = [8, 9, 10].map(hour => ({ starts_at: at(hour), ends_at: at(hour), context: 'family' as const }));
    expect(busyIntervals(points, undefined, ZONE)).toEqual([]);
    const slots = findFreeSlots(points, {
      tz: ZONE, windowStart: base + H(8), windowEnd: base + H(10), durationMin: 120,
      workingHours: { startHour: 8, endHour: 10 }, maxSuggestions: 1,
    });
    expect(slots).toEqual([{ start: base + H(8), end: base + H(10) }]);
  });
  it('defaults a no-end event to 30 minutes and filters by context', () => {
    const events = [
      { starts_at: at(9), ends_at: at(10), context: 'work' as const },
      { starts_at: at(11), context: 'personal' as const },
    ];
    const workOnly = busyIntervals(events, ['work'], ZONE);
    expect(workOnly).toHaveLength(1);
    expect(workOnly[0].end - workOnly[0].start).toBe(H(1));

    const personalOnly = busyIntervals(events, ['personal'], ZONE);
    expect(personalOnly[0].end - personalOnly[0].start).toBe(30 * 60 * 1000);
  });

  it('all-day events block the whole day', () => {
    const [iv] = busyIntervals([{ starts_at: at(0), all_day: true, context: 'family' }], undefined, ZONE);
    expect(iv.end - iv.start).toBe(H(24));
  });
});

describe('freeGaps', () => {
  it('inverts busy time inside a window', () => {
    const gaps = freeGaps([{ start: base + H(9), end: base + H(10) }], base + H(8), base + H(12));
    expect(gaps).toEqual([
      { start: base + H(8), end: base + H(9) },
      { start: base + H(10), end: base + H(12) },
    ]);
  });
});

describe('findFreeSlots', () => {
  it('finds a 60-min slot everyone shares, within working hours', () => {
    // Two members: one busy 9–10, the other busy 11–12. Window 8–17, work hours 9–17.
    const events = [
      { starts_at: at(9), ends_at: at(10), context: 'work' as const, assignee_id: 'a' },
      { starts_at: at(11), ends_at: at(12), context: 'work' as const, assignee_id: 'b' },
    ];
    const slots = findFreeSlots(events, {
      tz: ZONE,
      windowStart: base, windowEnd: base + H(24),
      durationMin: 60, workingHours: { startHour: 9, endHour: 17 },
      maxSuggestions: 3, granularityMin: 30,
    });
    expect(slots.length).toBeGreaterThan(0);
    // First slot should be at 10:00 (after the 9–10 block, before 11) — in the
    // zone the search was told to use, not in whichever one the runner is set to.
    expect(hourIn(slots[0].start, ZONE)).toBe(10);
    expect(slots[0].end - slots[0].start).toBe(H(1));
  });

  it('respects context filtering — a personal block does not occupy a work search', () => {
    const events = [{ starts_at: at(10), ends_at: at(16), context: 'personal' as const }];
    const slots = findFreeSlots(events, {
      tz: ZONE,
      windowStart: base, windowEnd: base + H(24),
      durationMin: 60, workingHours: { startHour: 9, endHour: 17 },
      contexts: ['work'], maxSuggestions: 1, granularityMin: 60,
    });
    // No work events → the whole working day is free → a slot exists at/after 9.
    expect(slots.length).toBe(1);
  });
});

// ── The family's zone, not the host's ───────────────────────────────────────
//
// `WorkingHours` is documented as "local hours, e.g. 9–17" and was applied with
// `setHours(hours.startHour, …)` — the HOST's hours. On a UTC host a Californian
// family's 9–17 window was proposed as 09:00–17:00 UTC, which is 01:00–09:00 for
// them: the AI schedule route suggested meetings in the middle of their night and
// treated their actual working day as unavailable. All-day blocking had the same
// defect, one function up.
//
// These run under the suite's pinned TZ (UTC by default, America/Los_Angeles in
// the second CI job), and they assert the same answer either way, because the
// answer no longer depends on the host.
describe('a working day belongs to the family, not the host', () => {
  const LA = 'America/Los_Angeles';
  // 2030-01-07 is a Monday; PST is UTC-8 in January.
  const windowStart = Date.parse('2030-01-07T00:00:00Z');
  const windowEnd = Date.parse('2030-01-10T00:00:00Z');

  it('opens the working window at 9am where the family lives', () => {
    const slots = findFreeSlots([], {
      tz: LA,
      windowStart,
      windowEnd,
      durationMin: 60,
      workingHours: { startHour: 9, endHour: 17 },
      maxSuggestions: 3,
      granularityMin: 60,
    });
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const local = hourIn(slot.start, LA);
      expect(local, `a slot started at ${local}:00 local`).toBeGreaterThanOrEqual(9);
      expect(local).toBeLessThan(17);
    }
    // And the same instants are NOT 9–17 on a UTC host, which is the whole
    // point: before the fix these came back at 09:00 UTC = 01:00 local.
    expect(hourIn(slots[0].start, 'UTC')).toBe((hourIn(slots[0].start, LA) + 8) % 24);
  });

  it("blocks an all-day event over the family's own day", () => {
    // Midnight UTC on the 7th is 16:00 on the 6th in Los Angeles, so the day
    // this event belongs to differs between the two zones — which is exactly the
    // case that used to come out wrong.
    const startsAt = new Date(windowStart).toISOString();
    const [utc] = busyIntervals([{ starts_at: startsAt, all_day: true, context: 'family' }], undefined, 'UTC');
    const [la] = busyIntervals([{ starts_at: startsAt, all_day: true, context: 'family' }], undefined, LA);

    expect(hourIn(utc.start, 'UTC')).toBe(0);
    expect(hourIn(la.start, LA)).toBe(0);
    expect(la.start).not.toBe(utc.start);
    for (const iv of [utc, la]) expect(iv.end - iv.start).toBe(H(24));
  });

  it('keeps each day a real local day across a DST change', () => {
    // 2030-03-10 is the US spring-forward Sunday: a 23-hour local day. Adding
    // 24h per day lands an hour past local midnight and drags every later day
    // with it, so the window would open at 10am for the rest of the search.
    const slots = findFreeSlots([], {
      tz: LA,
      windowStart: Date.parse('2030-03-08T12:00:00Z'),
      windowEnd: Date.parse('2030-03-13T12:00:00Z'),
      durationMin: 60,
      workingHours: { startHour: 9, endHour: 17 },
      maxSuggestions: 40,
      granularityMin: 60,
    });
    expect(slots.length).toBeGreaterThan(0);
    const openings = new Set(slots.map((s) => hourIn(s.start, LA)));
    for (const hour of openings) {
      expect(hour, `a slot started at ${hour}:00 local`).toBeGreaterThanOrEqual(9);
      expect(hour).toBeLessThan(17);
    }
    expect(Math.min(...openings), 'no slot opens at 9am after the clocks change').toBe(9);
  });
});


import { vi, beforeEach as fractionalBeforeEach, afterEach as fractionalAfterEach } from 'vitest';
import { parseExactInstant } from '@/lib/calendar/exact-instant';

describe('fractional scheduling inputs retain exact decimal units', () => {
  fractionalBeforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-08T08:00:00Z')); });
  fractionalAfterEach(() => { vi.restoreAllMocks(); });




const options={windowStart:Date.parse('2026-10-08T09:00:00Z'),windowEnd:Date.parse('2026-10-08T11:00:00Z'),durationMin:15,tz:'UTC',maxSuggestions:1};
const precise=[{starts_at:'2026-10-08T09:00:00.000001Z',ends_at:'2026-10-08T09:01:00.000001Z',all_day:false}];
for(const rows of [[],precise]) {
 it(`preserves decimal fractional minutes with ${rows.length} precise busy rows`,()=>{
  const [slot]=findFreeSlots(rows,{...options,durationMin:15.000001});
  expect(slot.exactInterval).toBeDefined();
  expect(parseExactInstant(slot.exactInterval!.end)-parseExactInstant(slot.exactInterval!.start)).toBe(900000060000n);
 });
 it(`preserves scientific minutes with ${rows.length} precise busy rows`,()=>{
  const [slot]=findFreeSlots(rows,{...options,durationMin:1e-7});
  expect(parseExactInstant(slot.exactInterval!.end)-parseExactInstant(slot.exactInterval!.start)).toBe(6000n);
 });
 for(const value of [1e-12,Number.NaN,Infinity,0,-1]) {
  it(`refuses unsupported duration ${String(value)} with ${rows.length} busy rows`,()=>expect(findFreeSlots(rows,{...options,durationMin:value})).toEqual([]));
  it(`refuses unsupported granularity ${String(value)} with ${rows.length} busy rows`,()=>expect(findFreeSlots(rows,{...options,granularityMin:value})).toEqual([]));
 }
 it(`preserves fractional granularity with ${rows.length} busy rows`,()=>{
  const [slot]=findFreeSlots(rows,{...options,granularityMin:1.000001});
  expect(slot.exactInterval).toBeDefined();
  expect(parseExactInstant(slot.exactInterval!.start)%60000060000n).toBe(0n);
 });
}
it('integer output remains original numeric-only shape',()=>expect(findFreeSlots([],{...options})).toEqual([{start:Date.parse('2026-10-08T09:00:00Z'),end:Date.parse('2026-10-08T09:15:00Z')}]));
it('integer-ms decimal duration uses exact rational ticks without multiplication noise',()=>{
 const [slot]=findFreeSlots([],{...options,durationMin:1.001});
 expect(slot).toEqual({start:Date.parse('2026-10-08T09:00:00Z'),end:Date.parse('2026-10-08T09:00:00Z')+60060});
});
it('integer-ms decimal grid uses exact rational ticks without multiplication noise',()=>{
 const [slot]=findFreeSlots([],{...options,granularityMin:1.001});
 expect(slot.start%60060).toBe(0);
 expect(Number.isSafeInteger(slot.start)).toBe(true);
 expect(slot.end-slot.start).toBe(900000);
 expect(slot.exactInterval).toBeUndefined();
});
});

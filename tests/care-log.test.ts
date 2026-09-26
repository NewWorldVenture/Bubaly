import { describe, it, expect } from 'vitest';
import {
  sortByRecent, lastContact, hoursSinceLastContact, isContactOverdue,
  averageWellbeing, groupByDay, entriesInLastDays, type CareEntryLike,
} from '@/lib/care/log';

const now = new Date('2026-06-21T12:00:00Z');
const e = (over: Partial<CareEntryLike>): CareEntryLike => ({
  id: Math.random().toString(36).slice(2), occurred_at: '2026-06-21T08:00:00Z',
  wellbeing: null, log_type: 'check_in', ...over,
});

describe('sortByRecent', () => {
  it('orders newest first', () => {
    const out = sortByRecent([
      e({ id: 'a', occurred_at: '2026-06-19T08:00:00Z' }),
      e({ id: 'b', occurred_at: '2026-06-21T08:00:00Z' }),
      e({ id: 'c', occurred_at: '2026-06-20T08:00:00Z' }),
    ]);
    expect(out.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('lastContact', () => {
  it('returns the most recent or null', () => {
    expect(lastContact([])).toBeNull();
    expect(lastContact([e({ id: 'x', occurred_at: '2026-06-10T08:00:00Z' }), e({ id: 'y', occurred_at: '2026-06-20T08:00:00Z' })])!.id).toBe('y');
  });
});

describe('hoursSinceLastContact', () => {
  it('floors whole hours since the latest entry', () => {
    expect(hoursSinceLastContact([e({ occurred_at: '2026-06-21T09:30:00Z' })], now)).toBe(2);
  });
  it('null when empty, never negative', () => {
    expect(hoursSinceLastContact([], now)).toBeNull();
    expect(hoursSinceLastContact([e({ occurred_at: '2026-06-21T20:00:00Z' })], now)).toBe(0);
  });
});

describe('isContactOverdue', () => {
  it('true when last contact older than threshold or none', () => {
    expect(isContactOverdue([], now)).toBe(true);
    expect(isContactOverdue([e({ occurred_at: '2026-06-19T08:00:00Z' })], now, 24)).toBe(true);
    expect(isContactOverdue([e({ occurred_at: '2026-06-21T08:00:00Z' })], now, 24)).toBe(false);
  });
});

describe('averageWellbeing', () => {
  it('averages rated entries to one decimal, null when none rated', () => {
    expect(averageWellbeing([e({ wellbeing: 4 }), e({ wellbeing: 5 }), e({ wellbeing: null })])).toBe(4.5);
    expect(averageWellbeing([e({ wellbeing: null })])).toBeNull();
  });
});

// `groupByDay` keys by the READER's local day: it reads
// `getFullYear/getMonth/getDate`, the same shape as `localDayKey` in
// lib/time/local-day.ts, and its only caller — components/modules/care-module.tsx:91,
// a client component whose runtime IS the reader — renders the key back through
// `new Date(`${key}T00:00:00`)` (local midnight) at line 144. Local is the
// contract, and the module honours it.
//
// The fixtures were what was wrong. They were fixed UTC instants
// ('2026-06-21T18:00:00Z') asserted against the literal '2026-06-21'. 18:00Z is
// the 21st only on a host at or west of Greenwich; in Asia/Tokyo (UTC+9) it is
// already 03:00 on the 22nd, and in Etc/GMT+12 the 08:00Z and 18:00Z entries
// land on two different local days instead of sharing one bucket. That literal
// was asserting the CI host's offset, not the code's contract.
//
// Built from LOCAL parts, 00:30 and 23:30 on 21 June are the 21st in every zone,
// so the literals below now state the contract itself. They also straddle local
// midnight, so a Greenwich-keyed implementation (`toISOString().slice(0, 10)`)
// splits them apart on any host with a non-zero offset, east or west.
describe('groupByDay', () => {
  const localIso = (y: number, m: number, d: number, h: number, min: number) =>
    new Date(y, m - 1, d, h, min, 0, 0).toISOString();

  it('buckets by day, newest day first', () => {
    const groups = groupByDay([
      e({ id: 'a', occurred_at: localIso(2026, 6, 21, 0, 30) }),
      e({ id: 'b', occurred_at: localIso(2026, 6, 20, 9, 0) }),
      e({ id: 'c', occurred_at: localIso(2026, 6, 21, 23, 30) }),
    ]);
    // Two days went by, so there are exactly two buckets, newest first.
    expect(groups.map(([day]) => day)).toEqual(['2026-06-21', '2026-06-20']);
    expect(groups[0][0]).toBe('2026-06-21');
    expect(groups[0][1].map((x) => x.id)).toEqual(['c', 'a']);
    expect(groups[1][0]).toBe('2026-06-20');
  });
});

describe('entriesInLastDays', () => {
  it('counts entries within the trailing window', () => {
    const list = [
      e({ occurred_at: '2026-06-21T08:00:00Z' }),
      e({ occurred_at: '2026-06-16T08:00:00Z' }),
      e({ occurred_at: '2026-06-01T08:00:00Z' }),
    ];
    expect(entriesInLastDays(list, now, 7)).toBe(2);
  });
});

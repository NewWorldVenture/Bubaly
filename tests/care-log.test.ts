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

describe('groupByDay', () => {
  it('buckets by day, newest day first', () => {
    const groups = groupByDay([
      e({ id: 'a', occurred_at: '2026-06-21T08:00:00Z' }),
      e({ id: 'b', occurred_at: '2026-06-20T09:00:00Z' }),
      e({ id: 'c', occurred_at: '2026-06-21T18:00:00Z' }),
    ]);
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

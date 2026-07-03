import { describe, it, expect } from 'vitest';
import { momentBucket, groupMoments, BUCKET_ORDER } from '@/lib/moments/grouping';

const now = new Date('2026-07-04T12:00:00');

describe('momentBucket', () => {
  it('buckets by whole-day distance from now', () => {
    expect(momentBucket('2026-07-04T18:00:00', now)).toBe('today');
    expect(momentBucket('2026-07-04T06:00:00', now)).toBe('today'); // earlier today (all-day)
    expect(momentBucket('2026-07-05T09:00:00', now)).toBe('tomorrow');
    expect(momentBucket('2026-07-09T09:00:00', now)).toBe('this-week'); // +5 days
    expect(momentBucket('2026-07-20T09:00:00', now)).toBe('later');
  });
  it('treats 7 days out as this-week, 8 as later (boundary)', () => {
    expect(momentBucket('2026-07-11T09:00:00', now)).toBe('this-week');
    expect(momentBucket('2026-07-12T09:00:00', now)).toBe('later');
  });
  it('sends junk to later', () => {
    expect(momentBucket('nope', now)).toBe('later');
  });
});

describe('groupMoments', () => {
  it('returns only non-empty buckets in fixed order, preserving item order', () => {
    const items = [
      { id: 'a', at: '2026-07-20T09:00:00' }, // later
      { id: 'b', at: '2026-07-04T18:00:00' }, // today
      { id: 'c', at: '2026-07-05T09:00:00' }, // tomorrow
      { id: 'd', at: '2026-07-04T20:00:00' }, // today
    ];
    const groups = groupMoments(items, (i) => i.at, now);
    expect(groups.map((g) => g.bucket)).toEqual(['today', 'tomorrow', 'later']); // 'this-week' skipped
    expect(groups[0].items.map((i) => i.id)).toEqual(['b', 'd']); // input order kept
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Tomorrow', 'Later']);
  });
  it('empty input → no sections', () => {
    expect(groupMoments([], (x: { at: string }) => x.at, now)).toEqual([]);
  });
  it('BUCKET_ORDER is the canonical soonest-first order', () => {
    expect(BUCKET_ORDER).toEqual(['today', 'tomorrow', 'this-week', 'later']);
  });
});

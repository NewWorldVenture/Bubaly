import { describe, expect, it } from 'vitest';
import {
  kindMeta,
  balanceScore,
  summarizeMember,
  trendByWeek,
  positiveStreakDays,
  type BehaviorLogLike,
} from '@/lib/behavior/insights';

const log = (kind: string, category: string, occurred_at: string, points = 0): BehaviorLogLike =>
  ({ member_id: 'm1', kind, category, points, occurred_at });

describe('kindMeta / balanceScore', () => {
  it('maps kinds', () => {
    expect(kindMeta('positive').sign).toBe(1);
    expect(kindMeta('concern').tone).toBe('danger');
    expect(kindMeta('neutral').sign).toBe(0);
  });
  it('balance score', () => {
    expect(balanceScore(0, 0)).toBe(100);
    expect(balanceScore(3, 1)).toBe(75);
    expect(balanceScore(0, 2)).toBe(0);
  });
});

describe('summarizeMember', () => {
  it('counts kinds, points and top categories', () => {
    const s = summarizeMember([
      log('positive', 'kindness', '2026-06-20T10:00:00Z', 2),
      log('positive', 'kindness', '2026-06-21T10:00:00Z', 1),
      log('concern', 'focus', '2026-06-21T11:00:00Z', -1),
      log('neutral', 'mood', '2026-06-21T12:00:00Z'),
    ]);
    expect(s.positive).toBe(2);
    expect(s.concern).toBe(1);
    expect(s.neutral).toBe(1);
    expect(s.total).toBe(4);
    expect(s.netPoints).toBe(2);
    expect(s.balanceScore).toBe(67);
    expect(s.topCategories[0]).toEqual({ category: 'kindness', count: 2 });
  });
});

describe('trendByWeek', () => {
  it('buckets logs into weeks', () => {
    const now = new Date('2026-06-24T00:00:00Z'); // Wednesday
    const trend = trendByWeek([
      log('positive', 'x', '2026-06-23T10:00:00Z'), // this week
      log('concern', 'x', '2026-06-16T10:00:00Z'),  // last week
    ], 3, now);
    expect(trend).toHaveLength(3);
    expect(trend[2].positive).toBe(1); // newest = current week
    expect(trend[1].concern).toBe(1);
  });
});

describe('positiveStreakDays', () => {
  it('counts consecutive positive, concern-free days ending today', () => {
    const now = new Date('2026-06-24T12:00:00Z');
    expect(positiveStreakDays([
      log('positive', 'x', '2026-06-24T09:00:00Z'),
      log('positive', 'x', '2026-06-23T09:00:00Z'),
      log('positive', 'x', '2026-06-22T09:00:00Z'),
    ], now)).toBe(3);
  });
  it('breaks on a concern day', () => {
    const now = new Date('2026-06-24T12:00:00Z');
    expect(positiveStreakDays([
      log('positive', 'x', '2026-06-24T09:00:00Z'),
      log('concern', 'x', '2026-06-23T09:00:00Z'),
    ], now)).toBe(1);
  });
});

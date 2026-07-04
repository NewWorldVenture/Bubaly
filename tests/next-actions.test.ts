import { describe, it, expect } from 'vitest';
import {
  daysBetween, rankNextActions, attentionCount, BUCKET_ORDER, type ActionInput,
} from '@/lib/opportunities/next-actions';

const TODAY = '2026-07-04';

const mk = (over: Partial<ActionInput> & { id: string }): ActionInput => ({
  source: 'task', title: 'Thing', whenKey: TODAY, href: '/x', ...over,
});

describe('daysBetween', () => {
  it('computes signed whole days, tz-safe', () => {
    expect(daysBetween('2026-07-04', '2026-07-04')).toBe(0);
    expect(daysBetween('2026-07-04', '2026-07-05')).toBe(1);
    expect(daysBetween('2026-07-04', '2026-07-01')).toBe(-3);
    expect(daysBetween('2026-06-28', '2026-07-04')).toBe(6);
  });
});

describe('rankNextActions', () => {
  it('buckets by urgency and orders overdue→someday', () => {
    const rows = [
      mk({ id: 'later', whenKey: '2026-07-20' }),
      mk({ id: 'someday', whenKey: null }),
      mk({ id: 'today', whenKey: TODAY }),
      mk({ id: 'overdue', whenKey: '2026-07-01' }),
      mk({ id: 'tomorrow', whenKey: '2026-07-05' }),
      mk({ id: 'thisweek', whenKey: '2026-07-08' }),
    ];
    const order = rankNextActions(rows, TODAY).map((a) => a.id);
    expect(order).toEqual(['overdue', 'today', 'tomorrow', 'thisweek', 'later', 'someday']);
  });

  it('within a bucket, higher priority wins, then earlier date', () => {
    const rows = [
      mk({ id: 'lowtoday', whenKey: TODAY, priority: 'low' }),
      mk({ id: 'hightoday', whenKey: TODAY, priority: 'high' }),
      mk({ id: 'medtoday', whenKey: TODAY, priority: 'medium' }),
    ];
    expect(rankNextActions(rows, TODAY).map((a) => a.id)).toEqual(['hightoday', 'medtoday', 'lowtoday']);
  });

  it('produces human reasons', () => {
    const out = rankNextActions([
      mk({ id: 'a', whenKey: '2026-07-02' }),   // overdue by 2
      mk({ id: 'b', whenKey: TODAY }),           // today
      mk({ id: 'c', whenKey: '2026-07-05' }),    // tomorrow
      mk({ id: 'd', whenKey: null }),            // someday
    ], TODAY);
    const byId = Object.fromEntries(out.map((a) => [a.id, a.reason]));
    expect(byId.a).toBe('Overdue by 2 days');
    expect(byId.b).toBe('Due today');
    expect(byId.c).toBe('Due tomorrow');
    expect(byId.d).toBe('No due date');
  });

  it('singular overdue day', () => {
    const [a] = rankNextActions([mk({ id: 'a', whenKey: '2026-07-03' })], TODAY);
    expect(a.reason).toBe('Overdue by 1 day');
  });

  it('attentionCount = overdue + today only', () => {
    const ranked = rankNextActions([
      mk({ id: 'o', whenKey: '2026-07-01' }),
      mk({ id: 't', whenKey: TODAY }),
      mk({ id: 'tm', whenKey: '2026-07-05' }),
      mk({ id: 's', whenKey: null }),
    ], TODAY);
    expect(attentionCount(ranked)).toBe(2);
  });

  it('BUCKET_ORDER has all six buckets', () => {
    expect(BUCKET_ORDER).toHaveLength(6);
  });
});

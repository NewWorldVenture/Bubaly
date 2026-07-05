import { describe, it, expect } from 'vitest';
import {
  buildCalmInbox, calmDigest, noiseReduced, type CalmItem,
} from '@/lib/calm/inbox';

const mk = (over: Partial<CalmItem> & { id: string; severity: CalmItem['severity'] }): CalmItem => ({
  source: 'agent', title: `Item ${over.id}`, ...over,
});

describe('buildCalmInbox', () => {
  it('splits into needsYou (action), today (attention), quieted (info)', () => {
    const inbox = buildCalmInbox([
      mk({ id: '1', severity: 'action', title: 'Pay bill' }),
      mk({ id: '2', severity: 'attention', title: 'Plan dinner' }),
      mk({ id: '3', severity: 'info', title: 'New photo' }),
      mk({ id: '4', severity: 'info', title: 'Subscription review' }),
    ]);
    expect(inbox.needsYou.map((i) => i.title)).toEqual(['Pay bill']);
    expect(inbox.today.map((i) => i.title)).toEqual(['Plan dinner']);
    expect(inbox.quieted).toBe(2);
    expect(inbox.total).toBe(4);
  });

  it('dedupes near-identical titles, keeping the most severe', () => {
    const inbox = buildCalmInbox([
      mk({ id: '1', severity: 'attention', title: 'Dentist tomorrow' }),
      mk({ id: '2', severity: 'action', title: 'dentist tomorrow' }), // same title, more severe
    ]);
    expect(inbox.total).toBe(1);
    expect(inbox.needsYou).toHaveLength(1);
    expect(inbox.needsYou[0].severity).toBe('action');
  });

  it('caps urgent + today and rolls the rest into quieted', () => {
    const many: CalmItem[] = [];
    for (let i = 0; i < 10; i++) many.push(mk({ id: `a${i}`, severity: 'action', title: `A${i}` }));
    for (let i = 0; i < 12; i++) many.push(mk({ id: `t${i}`, severity: 'attention', title: `T${i}` }));
    const inbox = buildCalmInbox(many, { urgentCap: 5, todayCap: 8 });
    expect(inbox.needsYou).toHaveLength(5);
    expect(inbox.today).toHaveLength(8);
    expect(inbox.quieted).toBe(22 - 5 - 8);
  });

  it('sorts action items by soonest time first', () => {
    const inbox = buildCalmInbox([
      mk({ id: '1', severity: 'action', title: 'Later', at: '2026-07-10T00:00:00Z' }),
      mk({ id: '2', severity: 'action', title: 'Sooner', at: '2026-07-06T00:00:00Z' }),
      mk({ id: '3', severity: 'action', title: 'Undated', at: null }),
    ]);
    expect(inbox.needsYou.map((i) => i.title)).toEqual(['Sooner', 'Later', 'Undated']);
  });
});

describe('calmDigest', () => {
  it('all clear', () => {
    expect(calmDigest(0, 0, 0)).toMatch(/all caught up/i);
    expect(calmDigest(0, 0, 3)).toMatch(/handled in the background/i);
  });
  it('urgent + today + quieted reads calmly', () => {
    expect(calmDigest(2, 3, 5)).toBe('2 things need you, 3 more for today. Everything else (5) is handled.');
    expect(calmDigest(1, 0, 0)).toBe('1 thing needs you.');
  });
});

describe('noiseReduced', () => {
  it('counts what the calm view kept out of the way', () => {
    const inbox = buildCalmInbox([
      mk({ id: '1', severity: 'action' }),
      mk({ id: '2', severity: 'info' }),
      mk({ id: '3', severity: 'info' }),
    ]);
    expect(noiseReduced(inbox)).toBe(2);
  });
});

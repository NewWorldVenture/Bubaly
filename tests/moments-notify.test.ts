import { describe, it, expect } from 'vitest';
import { imminentMomentNotices } from '@/lib/moments/notify';
import type { MomentEvent } from '@/lib/moments/prep';

const now = new Date('2026-07-04T10:00:00');

function ev(over: Partial<MomentEvent>): MomentEvent {
  return {
    id: 'e1', title: 'Soccer game', category: null, location: 'City Field',
    starts_at: '2026-07-04T15:00:00', all_day: false, description: null,
    ...over,
  };
}

describe('imminentMomentNotices', () => {
  it('notices a classified moment inside the horizon with leave-by + top steps', () => {
    const [n] = imminentMomentNotices([ev({})], [], now);
    expect(n.relatedId).toBe('moment:e1:2026-07-04');
    expect(n.title).toContain('Get ready: Soccer game');
    expect(n.body).toMatch(/^Leave by /);
    expect(n.body).toContain(' — ');
  });

  it('skips general events (plain calendar notifications already cover them)', () => {
    expect(imminentMomentNotices([ev({ title: 'Sync up', location: null })], [], now)).toEqual([]);
  });

  it('skips moments beyond the horizon and already-started timed moments', () => {
    expect(imminentMomentNotices([ev({ starts_at: '2026-07-07T15:00:00' })], [], now)).toEqual([]);
    expect(imminentMomentNotices([ev({ starts_at: '2026-07-04T09:00:00' })], [], now)).toEqual([]);
  });

  it('keeps an all-day moment live through its day', () => {
    const [n] = imminentMomentNotices([ev({ title: 'Beach picnic', starts_at: '2026-07-04T00:00:00', all_day: true })], [], now);
    expect(n).toBeTruthy();
    expect(n.title).toContain('Beach picnic');
  });

  it('merges an imminent birthday as a celebration moment', () => {
    const [n] = imminentMomentNotices([], [{ id: 'm1', display_name: 'Mia Smith', birthday: '2018-07-05' }], now);
    expect(n.relatedId).toMatch(/^moment:birthday:m1:2026-07-05$/);
    expect(n.title).toContain('Mia turns 8');
  });

  it('sorts soonest first and caps at 6', () => {
    const events = Array.from({ length: 8 }, (_, i) =>
      ev({ id: `e${i}`, starts_at: `2026-07-04T${String(22 - i).padStart(2, '0')}:00:00` }));
    const notices = imminentMomentNotices(events, [], now);
    expect(notices).toHaveLength(6);
    expect(notices[0].relatedId).toBe('moment:e7:2026-07-04');
  });

  it('dedup key embeds the calendar date so a future occurrence pings again', () => {
    const [a] = imminentMomentNotices([ev({ starts_at: '2026-07-04T15:00:00' })], [], now);
    const [b] = imminentMomentNotices([ev({ starts_at: '2026-07-05T15:00:00' })], [], now);
    expect(a.relatedId).not.toBe(b.relatedId);
  });
});

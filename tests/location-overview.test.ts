import { describe, it, expect } from 'vitest';
import {
  projectPoints, groupHistoryByDay, arrivalAlerts, batteryTone, sinceLabel,
  type HistoryEventLike,
} from '@/lib/location/overview';

describe('projectPoints', () => {
  it('maps the bounding box corners to padded extremes with latitude flipped', () => {
    const pts = [
      { id: 'nw', latitude: 40, longitude: -74 }, // max lat, min lng → top-left
      { id: 'se', latitude: 39, longitude: -73 }, // min lat, max lng → bottom-right
    ];
    const [nw, se] = projectPoints(pts, 10);
    expect(nw.xPct).toBeCloseTo(10);   // min lng → left pad
    expect(nw.yPct).toBeCloseTo(10);   // max lat → top pad
    expect(se.xPct).toBeCloseTo(90);   // max lng → right
    expect(se.yPct).toBeCloseTo(90);   // min lat → bottom
  });
  it('drops points with null coordinates', () => {
    expect(projectPoints([{ id: 'a', latitude: null, longitude: 1 }])).toEqual([]);
  });
  it('centers a single point (degenerate box)', () => {
    const [p] = projectPoints([{ id: 'x', latitude: 30, longitude: 20 }], 12);
    expect(p.xPct).toBeCloseTo(12);
    expect(p.yPct).toBeCloseTo(12);
  });
});

describe('groupHistoryByDay', () => {
  const now = new Date('2026-05-12T18:00:00');
  function ev(over: Partial<HistoryEventLike>): HistoryEventLike {
    return { id: Math.random().toString(36), member_id: 'm', place_name: 'Home', event_type: 'arrived', occurred_at: '2026-05-12T08:00:00', ...over };
  }
  it('buckets into Today / Yesterday and counts distinct arrival places', () => {
    const days = groupHistoryByDay([
      ev({ place_name: 'Home', occurred_at: '2026-05-12T07:45:00' }),
      ev({ place_name: 'School', occurred_at: '2026-05-12T08:15:00' }),
      ev({ place_name: 'School', occurred_at: '2026-05-12T09:00:00' }), // dup place
      ev({ place_name: 'Mall', event_type: 'left', occurred_at: '2026-05-12T10:00:00' }), // not arrival
      ev({ place_name: 'Gym', occurred_at: '2026-05-11T17:00:00' }),
    ], now);
    expect(days[0].label).toBe('Today');
    expect(days[0].count).toBe(2); // Home + School
    expect(days[1].label).toBe('Yesterday');
    expect(days[1].count).toBe(1);
  });
});

describe('arrivalAlerts', () => {
  it('keeps only arrivals, limited', () => {
    const evs = [
      { id: '1', event_type: 'arrived' }, { id: '2', event_type: 'left' },
      { id: '3', event_type: 'arrived' }, { id: '4', event_type: 'arrived' },
    ];
    const a = arrivalAlerts(evs, 2);
    expect(a.map((x) => x.id)).toEqual(['1', '3']);
  });
});

describe('batteryTone', () => {
  it('bands by percentage', () => {
    expect(batteryTone(90)).toBe('ok');
    expect(batteryTone(30)).toBe('low');
    expect(batteryTone(10)).toBe('critical');
    expect(batteryTone(null)).toBe('unknown');
  });
});

describe('sinceLabel', () => {
  const now = new Date('2026-05-12T18:00:00');
  it('returns Now for very recent and a clock time otherwise', () => {
    expect(sinceLabel('2026-05-12T17:59:00', now)).toBe('Now');
    expect(sinceLabel('2026-05-12T08:15:00', now)).toMatch(/Since 8:15/);
    expect(sinceLabel(null, now)).toBe('—');
  });
});

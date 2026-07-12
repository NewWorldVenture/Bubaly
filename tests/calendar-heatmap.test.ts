import { describe, it, expect } from 'vitest';
import { buildHeatmap, type HeatEvent } from '@/lib/calendar/heatmap';

const TODAY = new Date('2026-07-12T12:00:00Z');   // a Sunday

function ev(startsAt: string, minutes = 60, allDay = false): HeatEvent {
  const s = new Date(startsAt);
  return { startsAt, endsAt: allDay ? null : new Date(s.getTime() + minutes * 60000).toISOString(), allDay };
}

describe('buildHeatmap', () => {
  it('returns exactly weeks×7 days, oldest first, ending today', () => {
    const r = buildHeatmap([], TODAY, 8);
    expect(r.days).toHaveLength(56);
    expect(r.days[55].date).toBe('2026-07-12');
    expect(r.days[0].date).toBe('2026-05-18');
    expect(r.advice).toContain('quiet');
  });

  it('levels scale with scheduled minutes and event count', () => {
    const r = buildHeatmap([
      ev('2026-07-10T09:00:00Z', 30),                        // 1 short → level 1
      ev('2026-07-11T09:00:00Z', 90), ev('2026-07-11T14:00:00Z', 60),  // 150m/2 → level 2
      ev('2026-07-12T08:00:00Z', 120), ev('2026-07-12T11:00:00Z', 120),
      ev('2026-07-12T15:00:00Z', 120), ev('2026-07-12T18:00:00Z', 60),  // 420m/4 → level 4
    ], TODAY, 2);
    const byDate = new Map(r.days.map(d => [d.date, d]));
    expect(byDate.get('2026-07-10')!.level).toBe(1);
    expect(byDate.get('2026-07-11')!.level).toBe(2);
    expect(byDate.get('2026-07-12')!.level).toBe(4);
    expect(r.overloadedDates).toContain('2026-07-12');
  });

  it('all-day events count as a heavy block; junk dates are ignored', () => {
    const r = buildHeatmap([
      ev('2026-07-12T00:00:00Z', 0, true),
      { startsAt: 'garbage', endsAt: null, allDay: false },
      ev('2000-01-01T00:00:00Z'),           // outside window
    ], TODAY, 2);
    const today = r.days[r.days.length - 1];
    expect(today.minutes).toBe(480);
    expect(today.level).toBe(4);
    expect(r.days.reduce((s, d) => s + d.count, 0)).toBe(1);
  });

  it('names the chronically heaviest weekday and offers a calmer one', () => {
    const events: HeatEvent[] = [];
    for (let w = 0; w < 6; w++) {
      // Thursdays loaded (2026-07-09 is a Thursday)
      const thu = new Date(Date.UTC(2026, 6, 9) - w * 7 * 86400_000);
      events.push(ev(thu.toISOString(), 180), ev(new Date(thu.getTime() + 3600_000).toISOString(), 120));
    }
    const r = buildHeatmap(events, TODAY, 8);
    expect(r.busiestWeekday).toBe('Thursday');
    expect(r.advice).toMatch(/Thursday/);
  });
});

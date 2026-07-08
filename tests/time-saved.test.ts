import { describe, it, expect } from 'vitest';
import { computeTimeSaved, humanizeSaved } from '@/lib/metric/time-saved';

describe('humanizeSaved', () => {
  it('renders minutes under an hour, hours above', () => {
    expect(humanizeSaved(40)).toBe('about 40 minutes');
    expect(humanizeSaved(1)).toBe('about 1 minute');
    expect(humanizeSaved(90)).toBe('about 1.5 hours');
    expect(humanizeSaved(60)).toBe('about 1 hour');
  });
});

describe('computeTimeSaved', () => {
  it('weights each kind and totals minutes + actions', () => {
    const t = computeTimeSaved([
      { kind: 'autopilot', count: 10 }, // 10*5 = 50
      { kind: 'assistant', count: 5 },  // 5*4  = 20
      { kind: 'reminder', count: 20 },  // 20*2 = 40
    ]);
    expect(t.minutes).toBe(110);
    expect(t.hours).toBe(1.8);
    expect(t.actions).toBe(35);
    expect(t.show).toBe(true);
    expect(t.headline).toContain('about 1.8 hours');
    expect(t.headline).toContain('35 things');
  });

  it('drops zero-count kinds from the breakdown', () => {
    const t = computeTimeSaved([{ kind: 'autopilot', count: 3 }, { kind: 'reminder', count: 0 }]);
    expect(t.rows.map((r) => r.kind)).toEqual(['autopilot']);
  });

  it('hides and gives an encouraging headline when nothing was handled', () => {
    const t = computeTimeSaved([{ kind: 'autopilot', count: 0 }]);
    expect(t.show).toBe(false);
    expect(t.actions).toBe(0);
    expect(t.headline).toContain('start saving you time');
  });
});

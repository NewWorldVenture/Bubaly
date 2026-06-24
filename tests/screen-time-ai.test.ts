import { describe, expect, it } from 'vitest';
import {
  analyzeScreenTime,
  buildScreenTimePrompt,
  parseScreenTimeResponse,
  type ScreenTimeEntryLike,
} from '@/lib/screen-time/screen-time-ai';

function entry(overrides: Partial<ScreenTimeEntryLike> = {}): ScreenTimeEntryLike {
  return { entry_date: '2024-06-01', minutes: 60, category: 'entertainment', device: null, ...overrides };
}

describe('analyzeScreenTime', () => {
  it('summarizes entries', () => {
    const r = analyzeScreenTime([
      entry({ minutes: 30, category: 'education' }),
      entry({ minutes: 45, category: 'entertainment' }),
      entry({ entry_date: '2024-06-02', minutes: 20 }),
    ]);
    expect(r.totalEntries).toBe(3);
    expect(r.totalMinutes).toBe(95);
    expect(r.avgMinutesPerDay).toBe(48);
    expect(r.summary).toContain('3 entries');
  });

  it('tracks category breakdown', () => {
    const r = analyzeScreenTime([
      entry({ category: 'gaming', minutes: 30 }),
      entry({ category: 'gaming', minutes: 20 }),
      entry({ category: 'education', minutes: 40 }),
    ]);
    expect(r.categoryBreakdown['gaming']).toBe(50);
    expect(r.categoryBreakdown['education']).toBe(40);
  });

  it('handles empty list', () => {
    const r = analyzeScreenTime([]);
    expect(r.totalEntries).toBe(0);
    expect(r.totalMinutes).toBe(0);
    expect(r.avgMinutesPerDay).toBe(0);
  });
});

describe('buildScreenTimePrompt', () => {
  it('builds prompt with entry details', () => {
    const { system, user } = buildScreenTimePrompt([entry({ category: 'gaming', device: 'iPad' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('gaming');
    expect(user).toContain('iPad');
  });
});

describe('parseScreenTimeResponse', () => {
  it('parses valid JSON', () => {
    const r = parseScreenTimeResponse('{"suggestions":["set timers"],"balanceTips":["outdoor time"],"limitAdvice":"2 hours max"}');
    expect(r.suggestions).toEqual(['set timers']);
    expect(r.balanceTips).toEqual(['outdoor time']);
    expect(r.limitAdvice).toBe('2 hours max');
  });

  it('handles malformed input', () => {
    const r = parseScreenTimeResponse('not json');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseScreenTimeResponse('```json\n{"suggestions":["x"],"balanceTips":["y"],"limitAdvice":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});

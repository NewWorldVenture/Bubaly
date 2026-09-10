import { describe, it, expect } from 'vitest';
import {
  analyzeOnboarding, ttvSeconds, percentile, furthestStep, formatDuration,
  type OnboardingRow,
} from '@/lib/onboarding/ttv-audit';

const row = (over: Partial<OnboardingRow>): OnboardingRow => ({
  created_at: '2026-07-01T00:00:00Z', completed_at: null, status: 'in_progress',
  value_engaged: false, steps_completed: [], ...over,
});

describe('ttvSeconds', () => {
  it('is the completed_at − created_at gap in seconds', () => {
    expect(ttvSeconds(row({ created_at: '2026-07-01T00:00:00Z', completed_at: '2026-07-01T00:01:12Z', status: 'completed' }))).toBe(72);
  });
  it('is null for an unfinished run', () => {
    expect(ttvSeconds(row({}))).toBeNull();
  });
  it('rejects a negative gap rather than recording instant completion', () => {
    expect(ttvSeconds(row({ created_at: '2026-07-01T00:01:00Z', completed_at: '2026-07-01T00:00:00Z', status: 'completed' }))).toBeNull();
  });
});

describe('percentile', () => {
  it('is null on empty, nearest-rank otherwise', () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([10, 20, 30, 40], 90)).toBe(40);
  });
});

describe('furthestStep', () => {
  it('returns the furthest step in canonical order regardless of input order', () => {
    expect(furthestStep(['pin', 'profile', 'family'])).toBe('pin');
    expect(furthestStep(['profile'])).toBe('profile');
    expect(furthestStep([])).toBeNull();
  });
});

describe('analyzeOnboarding', () => {
  const rows: OnboardingRow[] = [
    row({ created_at: '2026-07-01T00:00:00Z', completed_at: '2026-07-01T00:00:45Z', status: 'completed', value_engaged: true, steps_completed: ['profile', 'family', 'value', 'about', 'members', 'pin'] }), // 45s
    row({ created_at: '2026-07-01T00:00:00Z', completed_at: '2026-07-01T00:02:00Z', status: 'completed', value_engaged: true, steps_completed: ['profile', 'family', 'value', 'about', 'members', 'pin'] }), // 120s
    row({ status: 'in_progress', value_engaged: true, steps_completed: ['profile', 'family', 'value'] }), // stalled at value
    row({ status: 'in_progress', steps_completed: [] }), // never started
  ];
  const a = analyzeOnboarding(rows);

  it('computes completion + activation rates', () => {
    expect(a.total).toBe(4);
    expect(a.completed).toBe(2);
    expect(a.completionRate).toBe(50);
    expect(a.valueEngagedRate).toBe(75); // 3 of 4
  });

  it('computes TTV stats + the under-90s share of completed', () => {
    expect(a.medianTtvSec).toBe(45);   // [45,120] nearest-rank p50 → 45
    expect(a.p90TtvSec).toBe(120);
    expect(a.under90Rate).toBe(50);    // 1 of 2 completed ≤ 90s
  });

  it('builds the step funnel', () => {
    const value = a.stepFunnel.find((s) => s.key === 'value')!;
    const pin = a.stepFunnel.find((s) => s.key === 'pin')!;
    expect(value.count).toBe(3); // 3 rows reached 'value'
    expect(pin.count).toBe(2);
    expect(pin.pct).toBe(50);
  });

  it('reports where incomplete runs stalled, most common first', () => {
    expect(a.stalls[0]).toMatchObject({ count: 1 });
    const keys = a.stalls.map((s) => s.key);
    expect(keys).toContain('value');
    expect(keys).toContain('not_started');
  });

  it('handles an empty dataset without dividing by zero', () => {
    const z = analyzeOnboarding([]);
    expect(z).toMatchObject({ total: 0, completionRate: 0, valueEngagedRate: 0, medianTtvSec: null, under90Rate: null });
  });

  it('counts the inclusive 30-minute threshold without rounding late completions into success', () => {
    const a = analyzeOnboarding([
      row({ status: 'completed', completed_at: '2026-07-01T00:00:00Z' }),
      row({ status: 'completed', completed_at: '2026-07-01T00:30:00Z' }),
      row({ status: 'completed', completed_at: '2026-07-01T00:30:00.001Z' }),
      row({ status: 'completed', completed_at: '2026-06-30T23:59:59Z' }),
      row({ status: 'completed', completed_at: 'invalid' }),
      row({ status: 'completed' }), row({}),
    ]);
    expect(a).toMatchObject({ completed: 6, timedCompletions: 3, untimedCompletions: 3, under30MinCount: 2, under30MinRate: 66.7 });
    expect(analyzeOnboarding([row({ status: 'completed' })]).under30MinRate).toBeNull();
    expect(analyzeOnboarding([row({ completed_at: '2026-07-01T01:00:00Z' })]).under30MinRate).toBe(0);
  });
});

describe('formatDuration', () => {
  it('formats seconds/minutes compactly', () => {
    expect(formatDuration(48)).toBe('48s');
    expect(formatDuration(72)).toBe('1m 12s');
    expect(formatDuration(120)).toBe('2m');
    expect(formatDuration(null)).toBe('—');
  });
});

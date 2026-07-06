import { describe, it, expect } from 'vitest';
import {
  visibleInsights, isSuppressed, isContributing, K_ANONYMITY_FLOOR,
  type InsightCandidate, type ConsentState,
} from '@/lib/network/insights';

const cands: InsightCandidate[] = [
  { id: 'a', scope: 'timing', title: 'Passport lead time', detail: '~6 months', cohortSize: 120 },
  { id: 'b', scope: 'benchmarks', title: 'Load benchmark', detail: 'you’re typical', cohortSize: 40 },
  { id: 'c', scope: 'timing', title: 'Rare pattern', detail: 'niche', cohortSize: 5 }, // below floor
  { id: 'd', scope: 'recommendations', title: 'Top recipe', detail: 'highly rated', cohortSize: 300 },
];

const on = (scopes: ConsentState['scopes']): ConsentState => ({ enabled: true, scopes });

describe('isSuppressed', () => {
  it('suppresses cohorts below the floor', () => {
    expect(isSuppressed(K_ANONYMITY_FLOOR - 1)).toBe(true);
    expect(isSuppressed(K_ANONYMITY_FLOOR)).toBe(false);
  });
});

describe('visibleInsights', () => {
  it('returns nothing when consent is disabled', () => {
    expect(visibleInsights(cands, { enabled: false, scopes: { timing: true } })).toEqual([]);
  });

  it('shows only opted-in scopes', () => {
    const out = visibleInsights(cands, on({ timing: true }));
    expect(out.every((i) => i.scope === 'timing')).toBe(true);
    expect(out.some((i) => i.id === 'b')).toBe(false); // benchmarks not opted in
  });

  it('suppresses insights below the k-anonymity floor even when opted in', () => {
    const out = visibleInsights(cands, on({ timing: true }));
    expect(out.some((i) => i.id === 'c')).toBe(false); // cohort 5 < 20
    expect(out.some((i) => i.id === 'a')).toBe(true);  // cohort 120
  });

  it('marks confidence high past 3x the floor', () => {
    const out = visibleInsights(cands, on({ timing: true, recommendations: true }));
    expect(out.find((i) => i.id === 'd')!.confidence).toBe('high'); // 300 >= 60
    expect(out.find((i) => i.id === 'a')!.confidence).toBe('high'); // 120 >= 60
  });

  it('marks confidence medium between the floor and 3x', () => {
    const out = visibleInsights(cands, on({ benchmarks: true }));
    expect(out.find((i) => i.id === 'b')!.confidence).toBe('medium'); // 40 in [20,60)
  });

  it('sorts by cohort size descending', () => {
    const out = visibleInsights(cands, on({ timing: true, benchmarks: true, recommendations: true }));
    for (let i = 1; i < out.length; i++) expect(out[i - 1].cohortSize >= out[i].cohortSize).toBe(true);
  });
});

describe('isContributing', () => {
  it('is false when disabled or no scope selected', () => {
    expect(isContributing({ enabled: false, scopes: { timing: true } })).toBe(false);
    expect(isContributing({ enabled: true, scopes: {} })).toBe(false);
  });
  it('is true when enabled with a scope', () => {
    expect(isContributing(on({ timing: true }))).toBe(true);
  });
});

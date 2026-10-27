import { describe, it, expect } from 'vitest';
import {
  visibleInsights, publishableInsights, consentedInsights, isSuppressed, isContributing, K_ANONYMITY_FLOOR,
  type InsightCandidate, type ConsentState,
} from '@/lib/network/insights';

// `count` is the DP-noised figure a person reads; `cohortSize` the true one the
// floor is checked on. They differ here so a test can tell which one was used.
const cands: InsightCandidate[] = [
  { id: 'a', scope: 'timing', title: 'Passport lead time', detail: '~6 months', count: 118, cohortSize: 120 },
  { id: 'b', scope: 'benchmarks', title: 'Load benchmark', detail: 'you’re typical', count: 41, cohortSize: 40 },
  { id: 'c', scope: 'timing', title: 'Rare pattern', detail: 'niche', count: 6, cohortSize: 5 }, // below floor
  { id: 'd', scope: 'recommendations', title: 'Top recipe', detail: 'highly rated', count: 302, cohortSize: 300 },
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

  // The order a family sees is the noised count's, the only family count it is
  // shown; ranked on the true size, the list told which of two close bands
  // really held more families.
  it('sorts by the noised count descending', () => {
    const out = visibleInsights(cands, on({ timing: true, benchmarks: true, recommendations: true }));
    expect(out.map((i) => i.id)).toEqual(['d', 'a', 'b']);
    for (let i = 1; i < out.length; i++) expect(out[i - 1].count >= out[i].count).toBe(true);
  });
});

describe('publishableInsights — the server half, and what reaches a browser', () => {
  const close: InsightCandidate[] = [
    { id: 'truly-bigger', scope: 'benchmarks', title: 'x', detail: 'x', count: 57, cohortSize: 59 },
    { id: 'noised-bigger', scope: 'benchmarks', title: 'y', detail: 'y', count: 62, cohortSize: 58 },
  ];

  it('applies the floor to the TRUE size and then drops it', () => {
    const out = publishableInsights([...cands, ...close]);
    expect(out.some((i) => i.id === 'c')).toBe(false); // true size 5 < 20, whatever its noised count
    for (const i of out) expect(Object.keys(i).sort()).toEqual(['confidence', 'count', 'detail', 'id', 'scope', 'title']);
    expect(JSON.stringify(out)).not.toContain('cohortSize');
  });

  it('grades and ranks on the noised count, so neither the order nor the label reveals a true size', () => {
    const out = publishableInsights(close);
    expect(out.map((i) => i.id)).toEqual(['noised-bigger', 'truly-bigger']);
    // 59 true families is under 3 × 20; the label follows the 62 a reader is shown
    expect(out.find((i) => i.id === 'noised-bigger')!.confidence).toBe('high');
    expect(out.find((i) => i.id === 'truly-bigger')!.confidence).toBe('medium');
  });

  it('consentedInsights re-applies consent on the client without needing the true size', () => {
    const published = publishableInsights(cands);
    expect(consentedInsights(published, { enabled: false, scopes: { timing: true } })).toEqual([]);
    expect(consentedInsights(published, on({ benchmarks: true })).map((i) => i.id)).toEqual(['b']);
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

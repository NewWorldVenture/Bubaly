import { describe, it, expect } from 'vitest';
import { hashString, assignVariant, computeABResults, leadingVariant } from '@/lib/marketing/ab';

const variants = [{ key: 'control', label: 'Control' }, { key: 'b', label: 'Variant B' }];

describe('assignVariant', () => {
  it('is deterministic / sticky for the same visitor', () => {
    const a = assignVariant('exp1', 'visitor-123', variants);
    const b = assignVariant('exp1', 'visitor-123', variants);
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
  });

  it('returns null with no variants', () => {
    expect(assignVariant('exp1', 'v', [])).toBeNull();
  });

  it('splits roughly evenly across many visitors', () => {
    const counts: Record<string, number> = { control: 0, b: 0 };
    for (let i = 0; i < 2000; i++) counts[assignVariant('exp1', `v${i}`, variants)!.key]++;
    // Within 15% of a 50/50 split.
    expect(Math.abs(counts.control - counts.b)).toBeLessThan(300);
  });

  it('hashString is stable', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('computeABResults', () => {
  it('computes rate, lift, and flags a clear winner as significant', () => {
    const res = computeABResults([
      { key: 'control', label: 'Control', exposures: 1000, conversions: 100 }, // 10%
      { key: 'b', label: 'B', exposures: 1000, conversions: 160 },             // 16%
    ]);
    expect(res[0].isControl).toBe(true);
    expect(res[0].rate).toBeCloseTo(0.1, 5);
    expect(res[1].rate).toBeCloseTo(0.16, 5);
    expect(res[1].lift).toBeCloseTo(0.6, 2);
    expect(res[1].significant).toBe(true);
    expect(res[1].pValue! ).toBeLessThan(0.05);
  });

  it('does not flag tiny samples as significant', () => {
    const res = computeABResults([
      { key: 'control', label: 'Control', exposures: 10, conversions: 1 },
      { key: 'b', label: 'B', exposures: 10, conversions: 2 },
    ]);
    expect(res[1].significant).toBe(false);
  });

  it('handles empty + zero-exposure gracefully', () => {
    expect(computeABResults([])).toEqual([]);
    const res = computeABResults([{ key: 'c', label: 'C', exposures: 0, conversions: 0 }]);
    expect(res[0].rate).toBe(0);
  });
});

describe('leadingVariant', () => {
  it('returns the significant leader, else null', () => {
    const res = computeABResults([
      { key: 'control', label: 'Control', exposures: 1000, conversions: 100 },
      { key: 'b', label: 'B', exposures: 1000, conversions: 160 },
    ]);
    expect(leadingVariant(res)?.key).toBe('b');
    expect(leadingVariant(computeABResults([{ key: 'control', label: 'C', exposures: 5, conversions: 1 }]))).toBeNull();
  });
});

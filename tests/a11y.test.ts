import { describe, it, expect } from 'vitest';
import { progressBarA11y } from '@/lib/ui/a11y';

describe('progressBarA11y', () => {
  it('sets progressbar role and bounds', () => {
    const p = progressBarA11y(42, 'Savings goal');
    expect(p.role).toBe('progressbar');
    expect(p['aria-valuemin']).toBe(0);
    expect(p['aria-valuemax']).toBe(100);
    expect(p['aria-valuenow']).toBe(42);
    expect(p['aria-label']).toBe('Savings goal');
  });
  it('rounds and clamps to [0,100]', () => {
    expect(progressBarA11y(42.6, 'x')['aria-valuenow']).toBe(43);
    expect(progressBarA11y(-10, 'x')['aria-valuenow']).toBe(0);
    expect(progressBarA11y(180, 'x')['aria-valuenow']).toBe(100);
  });
  it('treats non-finite values as 0', () => {
    expect(progressBarA11y(NaN, 'x')['aria-valuenow']).toBe(0);
    expect(progressBarA11y(Infinity, 'x')['aria-valuenow']).toBe(0);
  });
});

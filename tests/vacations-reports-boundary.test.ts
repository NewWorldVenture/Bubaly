import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync('components/vacations/vacations-reports.tsx', 'utf8');

describe('vacation reports read boundary', () => {
  it('tracks every report source loading and error state', () => {
    expect(source).toContain('tripsLoading');
    expect(source).toContain('expensesLoading');
    expect(source).toContain('budgetsLoading');
    expect(source).toContain('scoresLoading');
    expect(source).toContain('tripsError');
    expect(source).toContain('expensesError');
    expect(source).toContain('budgetsError');
    expect(source).toContain('scoresError');
  });

  it('fails closed instead of rendering partial financial reports', () => {
    expect(source).toContain('Could not load complete vacation reports. Refresh and try again.');
    expect(source).toContain('onRetry={refreshAll}');
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const shared = readFileSync('components/vacations/shared.tsx', 'utf8');
const budget = readFileSync('components/vacations/trip-budget.tsx', 'utf8');

describe('vacation CRUD read boundaries', () => {
  it('surfaces generic CRUD list failures with a retry action', () => {
    expect(shared).toContain('error, refresh } = useRealtimeQuery');
    expect(shared).toContain('Could not load ${title.toLowerCase()}. Refresh and try again.');
    expect(shared).toContain('onRetry={refresh}');
  });

  it('fails closed on budget and expense summary failures', () => {
    expect(budget).toContain('budgetsLoading');
    expect(budget).toContain('expensesLoading');
    expect(budget).toContain('budgetsError');
    expect(budget).toContain('expensesError');
    expect(budget).toContain('Could not load this trip budget. Refresh and try again.');
    expect(budget).toContain('onRetry={refreshAll}');
  });
});

import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import { readFileSync } from 'node:fs';

const shared = readFileSync('components/vacations/shared.tsx', 'utf8');
const budget = readFileSync('components/vacations/trip-budget.tsx', 'utf8');

describe('vacation CRUD read boundaries', () => {
  it('surfaces generic CRUD list failures with a retry action', () => {
    // The section's read is its own, or the page's (`source`, the Budget tab); either way its error and retry are surfaced.
    expect(shared).toContain('const own = useRealtimeQuery');
    expect(shared).toContain('const { data, loading, error, refresh } = source ?? own;');
    expectSays(shared, 'shared.sectionLoadFailed', 'This section could not be loaded. Refresh and try again.');
    expect(shared).toContain('onRetry={refresh}');
  });

  it('fails closed on budget and expense summary failures', () => {
    expect(budget).toContain('budgetsLoading');
    expect(budget).toContain('expensesLoading');
    expect(budget).toContain('budgetsError');
    expect(budget).toContain('expensesError');
    expectSays(budget, 'tripBudget.couldNotLoadThisTrip', 'Could not load this trip budget. Refresh and try again.');
    expect(budget).toContain('onRetry={refreshAll}');
  });
});


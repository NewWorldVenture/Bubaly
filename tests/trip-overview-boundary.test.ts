import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import { readFileSync } from 'node:fs';

const source = readFileSync('components/vacations/trip-overview.tsx', 'utf8');

describe('trip overview read boundary', () => {
  it('tracks the complete overview query set before deriving readiness', () => {
    expect(source).toContain('const readQueries = [');
    expect(source).toContain('const loading = readQueries.some((query) => query.loading);');
    expect(source).toContain('const readError = readQueries.some((query) => query.error);');
  });

  it('renders a retryable failure state instead of partial trip summaries', () => {
    expectSays(source, 'tripOverview.couldNotLoadThisTrip', 'Could not load this trip overview. Refresh and try again.');
    expect(source).toContain('onRetry={refreshAll}');
  });
});


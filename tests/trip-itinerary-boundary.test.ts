import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import { readFileSync } from 'node:fs';

const source = readFileSync('components/vacations/trip-itinerary.tsx', 'utf8');

describe('trip itinerary read boundary', () => {
  it('waits for trip, day, and item reads before rendering the schedule', () => {
    expect(source).toContain('const readQueries = [tripQuery, daysQuery, itemsQuery];');
    expect(source).toContain('const loading = readQueries.some((query) => query.loading);');
    expect(source).toContain('const readError = readQueries.some((query) => query.error);');
  });

  it('renders a retryable failure state instead of an empty itinerary', () => {
    expectSays(source, 'tripItinerary.couldNotLoadThisItinerary', 'Could not load this itinerary. Refresh and try again.');
    expect(source).toContain('onRetry={refreshAll}');
  });
});


import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import { readFileSync } from 'node:fs';

const weather = readFileSync('components/vacations/trip-weather.tsx', 'utf8');
const packing = readFileSync('components/vacations/trip-packing.tsx', 'utf8');

describe('trip weather and packing read boundaries', () => {
  it('fails closed when weather inputs or snapshots cannot be read', () => {
    expect(weather).toContain('const loading = tripQuery.loading || snapshotsQuery.loading;');
    expect(weather).toContain('const readError = tripQuery.error || snapshotsQuery.error;');
    expectSays(weather, 'tripWeather.couldNotLoadTripWeather', 'Could not load trip weather. Refresh and try again.');
    expect(weather).toContain('onRetry={refreshAll}');
  });

  it('fails closed when packing dependencies cannot be read', () => {
    expect(packing).toContain('const readQueries = [tripQuery, listsQuery, itemsQuery, weatherQuery, activitiesQuery];');
    expect(packing).toContain('const loading = readQueries.some((query) => query.loading);');
    expect(packing).toContain('const readError = readQueries.some((query) => query.error);');
    expectSays(packing, 'tripPacking.couldNotLoadThePacking', 'Could not load the packing plan. Refresh and try again.');
  });
});


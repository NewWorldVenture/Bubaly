import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const drivingSource = readFileSync('components/family/driving-safety-view.tsx', 'utf8');
const phoneSource = readFileSync('components/family/find-phone-view.tsx', 'utf8');

describe('family safety read boundaries', () => {
  it('surfaces driving trip read failures before the empty state', () => {
    expect(drivingSource).toContain('error, refresh } = useRealtimeQuery');
    expect(drivingSource).toContain('Could not load driving trips. Refresh and try again.');
    expect(drivingSource).toContain('onRetry={refresh}');
  });

  it('surfaces location and saved-place read failures before the phone view', () => {
    expect(phoneSource).toContain('error: locationsError, refresh: refreshLocations');
    expect(phoneSource).toContain('error: placesError, refresh: refreshPlaces');
    expect(phoneSource).toContain('Could not load phone locations. Refresh and try again.');
    expect(phoneSource).toContain('Promise.all([refreshLocations(), refreshPlaces()])');
  });
});


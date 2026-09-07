import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import { readFileSync } from 'node:fs';

const drivingSource = readFileSync('components/family/driving-safety-view.tsx', 'utf8');
const phoneSource = readFileSync('components/family/find-phone-view.tsx', 'utf8');
const playDatesSource = readFileSync('components/family/play-dates-view.tsx', 'utf8');

describe('family safety read boundaries', () => {
  it('surfaces driving trip read failures before the empty state', () => {
    expect(drivingSource).toContain('error, refresh } = useRealtimeQuery');
    expectSays(drivingSource, 'drivingSafetyView.couldNotLoadDrivingTrips', 'Could not load driving trips. Refresh and try again.');
    expect(drivingSource).toContain('onRetry={refresh}');
  });

  it('surfaces location and saved-place read failures before the phone view', () => {
    expect(phoneSource).toContain('error: locationsError, refresh: refreshLocations');
    expect(phoneSource).toContain('error: placesError, refresh: refreshPlaces');
    expectSays(phoneSource, 'findPhoneView.couldNotLoadPhoneLocations', 'Could not load phone locations. Refresh and try again.');
    expect(phoneSource).toContain('Promise.all([refreshLocations(), refreshPlaces()])');
  });

  it('surfaces play-date read failures before the empty state', () => {
    expect(playDatesSource).toContain('error, refresh } = useRealtimeQuery');
    expectSays(playDatesSource, 'playDatesView.couldNotLoadPlayDates', 'Could not load play dates. Refresh and try again.');
    expect(playDatesSource).toContain('onRetry={refresh}');
  });
});


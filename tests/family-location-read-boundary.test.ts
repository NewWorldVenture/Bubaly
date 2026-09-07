import { describe, expect, it } from 'vitest';
import { expectSays } from './helpers/translated';
import { readFileSync } from 'node:fs';

const source = readFileSync('components/modules/locator-module.tsx', 'utf8');

describe('family location read boundary', () => {
  it('coordinates location, place, and history reads before rendering the map', () => {
    expect(source).toContain('error: locationsError, refresh: refreshLocations');
    expect(source).toContain('error: placesError, refresh: refreshPlaces');
    expect(source).toContain('error: eventsError, refresh: refreshEvents');
    expectSays(source, 'locatorModule.couldNotLoadFamilyLocation', 'Could not load family location data. Refresh and try again.');
    expect(source).toContain('void refreshLocations(); void refreshPlaces(); void refreshEvents();');
  });
});


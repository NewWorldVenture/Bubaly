import { describe, it, expect } from 'vitest';
import { categoryMeta, priceRange, isValidZip, RADIUS_OPTIONS } from '@/lib/weekend/meta';
import { discoveryWindow, normalizeTicketmaster, normalizeTicketmasterResponse } from '@/lib/weekend/normalize';

describe('weekend meta', () => {
  it('maps categories and validates zip', () => {
    expect(categoryMeta('Music').emoji).toBe('🎵');
    expect(categoryMeta('Sports').label).toBe('Sports');
    expect(categoryMeta(null).label).toBe('Event');
    expect(isValidZip('90210')).toBe(true);
    expect(isValidZip('9021')).toBe(false);
    expect(isValidZip('abcde')).toBe(false);
    expect(RADIUS_OPTIONS).toContain(25);
  });
  it('formats price ranges', () => {
    expect(priceRange(1000, 4500)).toBe('$10–$45');
    expect(priceRange(1000, 1000)).toBe('$10');
    expect(priceRange(1000, null)).toBe('from $10');
    expect(priceRange(null, null)).toBe('');
  });
});

describe('discoveryWindow', () => {
  it('spans now..+days', () => {
    const { startISO, endISO } = discoveryWindow(6, new Date('2026-06-23T12:00:00Z'));
    expect(startISO.startsWith('2026-06-23')).toBe(true);
    expect(endISO.startsWith('2026-06-29')).toBe(true);
    expect(endISO.endsWith('Z')).toBe(true);
  });
});

describe('normalizeTicketmaster', () => {
  const sample = {
    _embedded: {
      events: [{
        id: 'G5v', name: 'Summer Fair', url: 'https://tm/e/G5v', info: 'Family fun',
        images: [{ url: 'https://img/16x9.jpg', ratio: '16_9' }, { url: 'https://img/sq.jpg', ratio: '1_1' }],
        dates: { start: { dateTime: '2026-06-25T23:00:00Z' } },
        classifications: [{ segment: { name: 'Arts & Theatre' }, genre: { name: 'Family' }, family: true }],
        priceRanges: [{ min: 15, max: 45, currency: 'USD' }],
        distance: 12.4, units: 'miles',
        _embedded: { venues: [{ name: 'City Park', city: { name: 'Austin' }, state: { stateCode: 'TX' }, postalCode: '78701', address: { line1: '1 Park Rd' }, location: { latitude: '30.27', longitude: '-97.74' } }] },
      }],
    },
  };
  it('maps fields, price→cents, image 16:9, distance, family flag', () => {
    const [e] = normalizeTicketmasterResponse(sample);
    expect(e.title).toBe('Summer Fair');
    expect(e.external_id).toBe('G5v');
    expect(e.category).toBe('Family');
    expect(e.venue_name).toBe('City Park');
    expect(e.city).toBe('Austin');
    expect(e.region).toBe('TX');
    expect(e.latitude).toBeCloseTo(30.27);
    expect(e.price_min_cents).toBe(1500);
    expect(e.price_max_cents).toBe(4500);
    expect(e.image_url).toBe('https://img/16x9.jpg');
    expect(e.distance_miles).toBe(12.4);
    expect(e.is_family_friendly).toBe(true);
    expect(e.starts_at).toBe('2026-06-25T23:00:00Z');
  });
  it('converts km distance to miles and handles sparse events', () => {
    const e = normalizeTicketmaster({ id: 'x', name: 'Show', distance: 10, units: 'km' });
    expect(e.distance_miles).toBeCloseTo(6.2, 1);
    expect(e.venue_name).toBeNull();
    expect(e.price_min_cents).toBeNull();
    expect(normalizeTicketmasterResponse({})).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import { categoryMeta, priceRange, isValidZip, RADIUS_OPTIONS } from '@/lib/weekend/meta';
import { discoveryWindow, normalizeTicketmaster, normalizeTicketmasterResponse } from '@/lib/weekend/normalize';
import { normalizeSeatGeekResponse, parseICS, parseICSDate, parseRSS, withinWindow, dedupeEvents } from '@/lib/weekend/sources';

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

describe('seatgeek', () => {
  it('normalizes events with venue + price stats', () => {
    const [e] = normalizeSeatGeekResponse({ events: [{ id: 42, title: 'Rockets vs Spurs', url: 'https://sg/e/42', type: 'nba', datetime_local: '2026-06-25T19:00:00', venue: { name: 'Arena', city: 'Houston', state: 'TX', postal_code: '77002', location: { lat: 29.7, lon: -95.4 } }, stats: { lowest_price: 25, highest_price: 0 } }] });
    expect(e.source).toBe('seatgeek');
    expect(e.external_id).toBe('42');
    expect(e.category).toBe('nba');
    expect(e.city).toBe('Houston');
    expect(e.price_min_cents).toBe(2500);
    expect(e.price_max_cents).toBeNull(); // 0 → null
    expect(normalizeSeatGeekResponse({})).toEqual([]);
  });
});

describe('ICS parsing', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:abc@city', 'SUMMARY:Farmers Market',
    'DTSTART;TZID=America/Chicago:20260625T090000', 'DTEND:20260625T130000',
    'LOCATION:Downtown Plaza', 'DESCRIPTION:Fresh produce\\, crafts', 'CATEGORIES:Family',
    'URL:https://city/market', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:All Day Fair', 'DTSTART;VALUE=DATE:20260627', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  it('parses VEVENTs incl. params, folding, escapes, all-day', () => {
    const out = parseICS(ics, 'cityfeed');
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('Farmers Market');
    expect(out[0].starts_at).toBe('2026-06-25T09:00:00');
    expect(out[0].venue_name).toBe('Downtown Plaza');
    expect(out[0].description).toContain('produce, crafts');
    expect(out[0].is_family_friendly).toBe(true);
    expect(out[1].starts_at).toBe('2026-06-27T00:00:00');
    expect(parseICSDate('20260625T180000Z')).toBe('2026-06-25T18:00:00Z');
  });
});

describe('RSS parsing', () => {
  it('parses items with title/link/date/category', () => {
    const rss = `<rss><channel>
      <item><title>Library Story Time</title><link>https://lib/e1</link><pubDate>Thu, 25 Jun 2026 15:00:00 GMT</pubDate><category>Kids</category><description><![CDATA[<p>Ages 3-5</p>]]></description></item>
      <item><title>No Date Event</title><link>https://lib/e2</link></item>
    </channel></rss>`;
    const out = parseRSS(rss, 'library');
    expect(out).toHaveLength(2);
    expect(out[0].title).toBe('Library Story Time');
    expect(out[0].url).toBe('https://lib/e1');
    expect(out[0].starts_at?.startsWith('2026-06-25')).toBe(true);
    expect(out[0].description).toContain('Ages 3-5');
    expect(out[1].starts_at).toBeNull();
  });
});

describe('aggregation helpers', () => {
  const now = new Date('2026-06-23T12:00:00Z');
  it('withinWindow keeps events inside the horizon', () => {
    const evs = [
      { starts_at: '2026-06-25T10:00:00Z' }, { starts_at: '2026-07-30T10:00:00Z' }, { starts_at: null },
    ] as never[];
    expect(withinWindow(evs, 6, now)).toHaveLength(1);
  });
  it('dedupeEvents removes id-dupes and title+day dupes', () => {
    const a = [{ source: 'tm', external_id: '1', title: 'Fair', starts_at: '2026-06-25T10:00:00Z' }];
    const b = [{ source: 'tm', external_id: '1', title: 'Fair', starts_at: '2026-06-25T10:00:00Z' }, { source: 'sg', external_id: '9', title: 'Fair', starts_at: '2026-06-25T20:00:00Z' }];
    expect(dedupeEvents([a as never, b as never])).toHaveLength(1);
  });
});

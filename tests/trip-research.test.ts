import { describe, it, expect } from 'vitest';
import {
  buildTripResearchPrompt, parseTripResearch, fallbackTripResearch,
} from '@/lib/trips/research';

describe('buildTripResearchPrompt', () => {
  it('grounds the prompt in destination, members, and interests', () => {
    const { system, user } = buildTripResearchPrompt({
      destination: 'Savannah, GA', members: ['Daniel', 'Leigha'], interests: 'history and seafood',
      startDate: '2026-07-01', endDate: '2026-07-03', weatherSummary: 'warm, 88°F, chance of rain',
    });
    expect(system).toContain('Bubaly');
    expect(user).toContain('Savannah, GA');
    expect(user).toContain('Daniel and Leigha');
    expect(user).toContain('history and seafood');
    expect(user).toContain('2026-07-01');
    expect(user).toContain('warm, 88');
  });
  it('handles missing optional fields', () => {
    const { user } = buildTripResearchPrompt({ destination: 'Austin, TX' });
    expect(user).toContain('Austin, TX');
    expect(user).toContain('the family');
  });
});

describe('parseTripResearch', () => {
  it('parses a valid JSON payload', () => {
    const text = JSON.stringify({
      overview: 'A charming coastal city.',
      restaurants: [{ name: 'The Grey', cuisine: 'Southern', why: 'Iconic.', priceLevel: '$$$' }],
      activities: [{ name: 'Forsyth Park', category: 'outdoors', why: 'Beautiful.' }],
      tips: ['Book ahead.'],
    });
    const r = parseTripResearch(text);
    expect(r).not.toBeNull();
    expect(r!.restaurants[0].name).toBe('The Grey');
    expect(r!.activities[0].category).toBe('outdoors');
    expect(r!.tips).toContain('Book ahead.');
  });
  it('extracts JSON wrapped in prose/markdown', () => {
    const text = 'Sure!\n```json\n{"overview":"x","restaurants":[{"name":"A","cuisine":"B","why":"C"}],"activities":[],"tips":[]}\n```';
    const r = parseTripResearch(text);
    expect(r!.restaurants[0].name).toBe('A');
  });
  it('returns null for junk or empty payloads', () => {
    expect(parseTripResearch('not json')).toBeNull();
    expect(parseTripResearch(JSON.stringify({ restaurants: [], activities: [], tips: [] }))).toBeNull();
  });
  it('drops entries without a name', () => {
    const text = JSON.stringify({ overview: 'x', restaurants: [{ cuisine: 'B', why: 'C' }], activities: [], tips: ['t'] });
    const r = parseTripResearch(text);
    expect(r!.restaurants).toHaveLength(0);
  });
});

describe('fallbackTripResearch', () => {
  it('always returns usable, non-empty guidance', () => {
    const r = fallbackTripResearch({ destination: 'Savannah, GA' });
    expect(r.restaurants.length).toBeGreaterThan(0);
    expect(r.activities.length).toBeGreaterThan(0);
    expect(r.tips.length).toBeGreaterThan(0);
    expect(r.overview).toContain('Savannah, GA');
  });
  it('tilts toward stated interests', () => {
    const hist = fallbackTripResearch({ destination: 'Rome', interests: 'history and museums' });
    expect(hist.activities.some((a) => a.category === 'culture')).toBe(true);
    const food = fallbackTripResearch({ destination: 'Lyon', interests: 'foodie dining' });
    expect(food.restaurants[0].why.toLowerCase()).toContain('food');
  });
});

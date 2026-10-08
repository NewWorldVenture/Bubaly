import { describe, expect, it } from 'vitest';
import {
  annotateAllergens, buildPantryChefPrompt, normalizeAllergies, normalizePlanDate, parsePantryRecipes,
} from '@/lib/meals/pantry-chef';

// PLA-0835: "Fridge Chef" — snap the fridge → allergy-aware dinner ideas →
// grocery list (the one competitor headline Bubaly lacked). These lock the
// pure engine (prompt/parse/allergen-flag) behind /api/ai/pantry-chef.
describe('normalizeAllergies', () => {
  it('splits free-text allergy fields into distinct lowercase terms', () => {
    expect(normalizeAllergies('Peanuts, Tree nuts; Shellfish')).toEqual(['peanuts', 'tree nuts', 'shellfish']);
    expect(normalizeAllergies('Eggs and Dairy')).toEqual(['eggs', 'dairy']);
  });
  it('drops empty/none markers and de-duplicates across members', () => {
    expect(normalizeAllergies('None', null, 'N/A', 'NKA')).toEqual([]);
    expect(normalizeAllergies('peanuts', 'Peanuts, gluten')).toEqual(['peanuts', 'gluten']);
  });
});

describe('buildPantryChefPrompt', () => {
  const now = new Date('2026-07-18T12:00:00Z');
  it('injects the allergy guard when the family has allergies', () => {
    const p = buildPantryChefPrompt(['peanuts', 'shellfish'], now, 'UTC');
    expect(p).toContain('NEVER suggest a recipe containing them');
    expect(p).toContain('peanuts, shellfish');
    expect(p).toContain('Return ONLY a JSON array');
  });
  it('states no-known-allergies when none provided', () => {
    expect(buildPantryChefPrompt([], now, 'UTC')).toContain('No known family allergies');
  });
});

describe('parsePantryRecipes', () => {
  it('parses a fenced JSON array and coerces fields', () => {
    const text = '```json\n[{"title":"Veggie Stir-Fry","have":["rice","peppers"],"need":["soy sauce"],"steps":"Fry it.","minutes":20}]\n```';
    const [r] = parsePantryRecipes(text);
    expect(r.title).toBe('Veggie Stir-Fry');
    expect(r.have).toEqual(['rice', 'peppers']);
    expect(r.need).toEqual(['soy sauce']);
    expect(r.minutes).toBe(20);
    expect(r.allergenConflict).toBeNull();
  });
  it('parses a bare array wrapped in prose and tolerates junk', () => {
    expect(parsePantryRecipes('Here you go: [{"title":"Pasta","minutes":"fast"}] enjoy!')[0]).toMatchObject({ title: 'Pasta', minutes: null, have: [], need: [] });
    expect(parsePantryRecipes('no json here')).toEqual([]);
    expect(parsePantryRecipes('[not valid json')).toEqual([]);
    expect(parsePantryRecipes('')).toEqual([]);
  });
  it('drops entries without a title', () => {
    expect(parsePantryRecipes('[{"have":["x"]},{"title":"OK"}]')).toHaveLength(1);
  });
});

describe('normalizePlanDate (add-to-plan phase)', () => {
  const now = new Date('2026-07-18T12:00:00Z');
  it('accepts a real YYYY-MM-DD date', () => {
    expect(normalizePlanDate('2026-07-20', 'UTC', now)).toBe('2026-07-20');
  });
  it('falls back to today for junk, wrong formats, and impossible dates', () => {
    expect(normalizePlanDate('tomorrow', 'UTC', now)).toBe('2026-07-18');
    expect(normalizePlanDate('2026-02-30', 'UTC', now)).toBe('2026-07-18'); // not a real day
    expect(normalizePlanDate('2026-7-2', 'UTC', now)).toBe('2026-07-18');
    expect(normalizePlanDate(null, 'UTC', now)).toBe('2026-07-18');
    expect(normalizePlanDate(20260720, 'UTC', now)).toBe('2026-07-18');
  });
  it('uses the required household clock for fallback, preserving valid civil dates', () => {
    const evening = new Date('2026-10-09T02:30:00Z');
    expect(normalizePlanDate(undefined, 'America/Los_Angeles', evening)).toBe('2026-10-08');
    expect(normalizePlanDate(undefined, 'Pacific/Kiritimati', new Date('2026-10-08T12:30:00Z'))).toBe('2026-10-09');
    expect(normalizePlanDate('2028-02-29', 'America/Los_Angeles', evening)).toBe('2028-02-29');
  });
  it('refuses an unknown clock rather than implicitly choosing the host or UTC', () => {
    for (const timezone of ['', 'Invalid/Zone']) expect(() => normalizePlanDate(undefined, timezone, now)).toThrow(RangeError);
    expect(() => normalizePlanDate(undefined, 'UTC', new Date('invalid'))).toThrow(RangeError);
  });
});

describe('annotateAllergens (defense-in-depth)', () => {
  it('flags a recipe whose ingredients hit a family allergen', () => {
    const recipes = parsePantryRecipes('[{"title":"Peanut Noodles","have":["noodles"],"need":["peanut butter"]}]');
    const [r] = annotateAllergens(recipes, ['peanut']);
    expect(r.allergenConflict).toBe('peanut');
  });
  it('leaves clean recipes unflagged and is a no-op without allergies', () => {
    const recipes = parsePantryRecipes('[{"title":"Rice Bowl","have":["rice"],"need":["broccoli"]}]');
    expect(annotateAllergens(recipes, ['peanut'])[0].allergenConflict).toBeNull();
    expect(annotateAllergens(recipes, [])[0].allergenConflict).toBeNull();
  });
});

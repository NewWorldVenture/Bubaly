import { describe, expect, it } from 'vitest';
import {
  buildCandidates, buildPlannerUser, weekDates, parsePlan, refParts,
  type PlannerRequest,
} from '@/lib/meals/planner';

describe('buildCandidates', () => {
  it('merges meals + recipes and sorts by votes then name', () => {
    const got = buildCandidates(
      [{ id: 'm1', name: 'Ziti', meal_type: 'dinner' }],
      [{ id: 'r1', name: 'Apple Pie', category: 'dessert', allergy_flags: ['Nut-free'] }],
      { 'recipe:r1': 3 },
    );
    expect(got[0].ref).toBe('recipe:r1');         // most votes first
    expect(got[0].flags).toEqual(['Nut-free']);
    expect(got[1].ref).toBe('meal:m1');
  });
});

describe('weekDates', () => {
  it('returns 7 consecutive ISO dates', () => {
    const d = weekDates('2026-06-22');
    expect(d).toHaveLength(7);
    expect(d[0]).toBe('2026-06-22');
    expect(d[6]).toBe('2026-06-28');
  });
});

describe('buildPlannerUser', () => {
  const base: PlannerRequest = {
    weekStart: '2026-06-22', mealTypes: ['dinner'],
    candidates: [{ ref: 'meal:m1', name: 'Tacos', type: 'dinner', flags: [], votes: 2 }],
    dietary: ['Vegetarian'], expiring: ['spinach'],
  };
  it('includes constraints, expiring items, and candidates', () => {
    const u = buildPlannerUser(base);
    expect(u).toContain('Vegetarian');
    expect(u).toContain('spinach');
    expect(u).toContain('meal:m1 | Tacos');
  });
  it('handles an empty library', () => {
    expect(buildPlannerUser({ ...base, candidates: [] })).toContain('none saved yet');
  });
});

describe('parsePlan', () => {
  const req: PlannerRequest = {
    weekStart: '2026-06-22', mealTypes: ['dinner'],
    candidates: [{ ref: 'meal:m1', name: 'Tacos', type: 'dinner', flags: [], votes: 0 }],
  };
  it('keeps valid slots and maps refs', () => {
    const text = JSON.stringify({ assignments: [
      { date: '2026-06-22', meal_type: 'dinner', ref: 'meal:m1', name: 'Tacos' },
      { date: '2026-06-23', meal_type: 'dinner', ref: 'new', name: 'Stir Fry' },
    ] });
    const got = parsePlan(text, req);
    expect(got).toHaveLength(2);
    expect(got[0].ref).toBe('meal:m1');
    expect(got[1].ref).toBeNull();          // "new" → null
  });
  it('drops out-of-range dates, wrong slots, and unknown refs become new', () => {
    const text = JSON.stringify({ assignments: [
      { date: '2030-01-01', meal_type: 'dinner', name: 'Nope' },
      { date: '2026-06-22', meal_type: 'breakfast', name: 'Wrong slot' },
      { date: '2026-06-24', meal_type: 'dinner', ref: 'recipe:ghost', name: 'Ghost' },
    ] });
    const got = parsePlan(text, req);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ date: '2026-06-24', ref: null, name: 'Ghost' });
  });
  it('enforces one dish per slot', () => {
    const text = JSON.stringify({ assignments: [
      { date: '2026-06-22', meal_type: 'dinner', ref: 'meal:m1', name: 'Tacos' },
      { date: '2026-06-22', meal_type: 'dinner', ref: 'new', name: 'Duplicate' },
    ] });
    expect(parsePlan(text, req)).toHaveLength(1);
  });
  it('returns [] on garbage', () => {
    expect(parsePlan('not json', req)).toEqual([]);
  });
});

describe('refParts', () => {
  it('splits refs into table + id', () => {
    expect(refParts('meal:abc')).toEqual({ table: 'meals', id: 'abc' });
    expect(refParts('recipe:xyz')).toEqual({ table: 'recipes', id: 'xyz' });
    expect(refParts('new')).toBeNull();
    expect(refParts(null)).toBeNull();
  });
});

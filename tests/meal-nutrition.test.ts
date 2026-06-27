import { describe, expect, it } from 'vitest';
import {
  coerceNutrition, parseModelJSON, sumNutrition, perDay, dailyValuePct, fmtAmount,
  type Nutrition,
} from '@/lib/meals/nutrition';

const N = (p: Partial<Nutrition>): Nutrition => ({
  calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 0, ...p,
});

describe('coerceNutrition', () => {
  it('coerces strings, rounds, and zero-fills', () => {
    const got = coerceNutrition({ calories: '650.4', protein_g: 30.25, sodium_mg: -5 });
    expect(got.calories).toBe(650);
    expect(got.protein_g).toBe(30.3);
    expect(got.sodium_mg).toBe(0);
    expect(got.fiber_g).toBe(0);
  });
});

describe('parseModelJSON', () => {
  it('extracts JSON from a fenced block', () => {
    expect(parseModelJSON('```json\n{"calories": 500}\n```')).toEqual({ calories: 500 });
  });
  it('extracts JSON embedded in prose', () => {
    expect(parseModelJSON('Here you go: {"a":1} thanks')).toEqual({ a: 1 });
  });
  it('returns null when unparseable', () => {
    expect(parseModelJSON('no json here')).toBeNull();
    expect(parseModelJSON('')).toBeNull();
  });
});

describe('aggregation', () => {
  it('sums and averages per day', () => {
    const total = sumNutrition([N({ calories: 700, protein_g: 40 }), N({ calories: 300, protein_g: 10 })]);
    expect(total.calories).toBe(1000);
    expect(total.protein_g).toBe(50);
    const avg = perDay(total, 2);
    expect(avg.calories).toBe(500);
    expect(avg.protein_g).toBe(25);
  });
  it('perDay guards divide-by-zero', () => {
    expect(perDay(N({ calories: 100 }), 0).calories).toBe(100);
  });
});

describe('display', () => {
  it('daily value percent caps at 999', () => {
    expect(dailyValuePct('protein_g', 25)).toBe(50);
    expect(dailyValuePct('sodium_mg', 99999)).toBe(999);
  });
  it('formats units', () => {
    expect(fmtAmount('calories', 650)).toBe('650 kcal');
    expect(fmtAmount('sodium_mg', 400)).toBe('400 mg');
    expect(fmtAmount('protein_g', 30)).toBe('30 g');
  });
});

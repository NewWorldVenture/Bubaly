import { describe, it, expect } from 'vitest';
import { computeFoodScore, nutritionBalanceScore, gradeFor, type FoodScoreInput } from '@/lib/food/score';
import type { Nutrition } from '@/lib/meals/nutrition';

const goodNutrition: Nutrition = { calories: 1900, protein_g: 60, carbs_g: 230, fat_g: 65, fiber_g: 30, sugar_g: 40, sodium_mg: 2000 };
const poorNutrition: Nutrition = { calories: 2600, protein_g: 20, carbs_g: 320, fat_g: 110, fiber_g: 8, sugar_g: 95, sodium_mg: 3800 };

function base(over: Partial<FoodScoreInput> = {}): FoodScoreInput {
  return {
    plannedSlots: 7, totalSlots: 7, distinctDishes: 7,
    perDayNutrition: goodNutrition,
    pantryTotal: 20, pantryExpired: 0, pantryExpiringSoon: 0, plannedUsingExpiring: 0,
    plannedCostCents: 12000, weeklyBudgetCents: 15000, avgRating: 4.5,
    ...over,
  };
}

describe('nutritionBalanceScore', () => {
  it('rewards balanced nutrition', () => {
    expect(nutritionBalanceScore(goodNutrition)!).toBeGreaterThan(85);
  });
  it('penalizes low protein/fiber + high sodium/sugar', () => {
    expect(nutritionBalanceScore(poorNutrition)!).toBeLessThan(55);
  });
  it('returns null without an estimate', () => {
    expect(nutritionBalanceScore(null)).toBeNull();
  });
});

describe('computeFoodScore', () => {
  it('scores a great week high with an A grade', () => {
    const r = computeFoodScore(base());
    expect(r.overall).toBeGreaterThan(88);
    expect(r.grade.startsWith('A')).toBe(true);
    expect(r.subScores.length).toBe(6); // no pantry-efficiency sub (nothing expiring)
  });

  it('scores a neglected week low', () => {
    const r = computeFoodScore(base({
      plannedSlots: 2, totalSlots: 7, distinctDishes: 1,
      perDayNutrition: poorNutrition,
      pantryExpired: 6, pantryExpiringSoon: 5, plannedUsingExpiring: 0,
      plannedCostCents: 21000, weeklyBudgetCents: 15000, avgRating: 2,
    }));
    expect(r.overall).toBeLessThan(55);
    expect(r.grade === 'D' || r.grade === 'F').toBe(true);
    expect(r.coaching.length).toBeGreaterThan(1);
  });

  it('only includes sub-scores it has data for', () => {
    const r = computeFoodScore({
      plannedSlots: 0, totalSlots: 7, distinctDishes: 0,
      perDayNutrition: null, pantryTotal: 0, pantryExpired: 0, pantryExpiringSoon: 0, plannedUsingExpiring: 0,
    });
    // Only planning (totalSlots>0). No variety (0 planned), nutrition, waste, pantry, budget, satisfaction.
    expect(r.subScores.map((s) => s.key)).toEqual(['planning']);
  });

  it('rewards using up expiring items (pantry efficiency)', () => {
    const using = computeFoodScore(base({ pantryExpiringSoon: 4, plannedUsingExpiring: 4 }));
    const notUsing = computeFoodScore(base({ pantryExpiringSoon: 4, plannedUsingExpiring: 0 }));
    const u = using.subScores.find((s) => s.key === 'pantry')!.score;
    const n = notUsing.subScores.find((s) => s.key === 'pantry')!.score;
    expect(u).toBeGreaterThan(n);
    expect(u).toBe(100);
  });

  it('penalizes going over budget', () => {
    const under = computeFoodScore(base({ plannedCostCents: 10000, weeklyBudgetCents: 15000 }));
    const over = computeFoodScore(base({ plannedCostCents: 22500, weeklyBudgetCents: 15000 }));
    const uB = under.subScores.find((s) => s.key === 'budget')!.score;
    const oB = over.subScores.find((s) => s.key === 'budget')!.score;
    expect(uB).toBe(100);
    expect(oB).toBeLessThan(60);
  });

  it('surfaces an expired-items coaching tip', () => {
    const r = computeFoodScore(base({ pantryExpired: 3 }));
    expect(r.coaching.some((t) => t.includes('expired'))).toBe(true);
  });

  it('congratulates a clean week', () => {
    const r = computeFoodScore(base());
    expect(r.coaching[0]).toContain('eating well');
  });
});

describe('gradeFor', () => {
  it('maps scores to letter grades', () => {
    expect(gradeFor(98)).toBe('A+');
    expect(gradeFor(85)).toBe('B');
    expect(gradeFor(72)).toBe('C−');
    expect(gradeFor(50)).toBe('F');
  });
});

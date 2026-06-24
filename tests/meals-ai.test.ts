import { describe, expect, it } from 'vitest';
import { analyzeMeals, buildMealsPrompt, parseMealsResponse, type MealForAI } from '@/lib/meals/meals-ai';

function meal(overrides: Partial<MealForAI> = {}): MealForAI {
  return { name: 'Pasta Primavera', meal_type: 'dinner', notes: null, ...overrides };
}

describe('analyzeMeals', () => {
  it('summarizes meals', () => {
    const r = analyzeMeals([meal(), meal({ meal_type: 'lunch' })]);
    expect(r.totalMeals).toBe(2);
    expect(Object.keys(r.mealTypeCounts)).toHaveLength(2);
  });
  it('handles empty', () => {
    expect(analyzeMeals([]).summary).toContain('No meals');
  });
});

describe('buildMealsPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildMealsPrompt([meal()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Pasta Primavera');
  });
});

describe('parseMealsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseMealsResponse('{"suggestions":["try new cuisines"],"mealIdeas":["taco night"],"nutritionTip":"add more vegetables"}');
    expect(r.suggestions).toEqual(['try new cuisines']);
    expect(r.nutritionTip).toBe('add more vegetables');
  });
  it('handles malformed', () => {
    expect(parseMealsResponse('bad').suggestions).toEqual([]);
  });
});

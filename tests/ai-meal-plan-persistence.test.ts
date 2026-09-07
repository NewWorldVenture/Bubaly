import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('app/api/ai/meals/plan/route.ts', 'utf8');

describe('AI meal planner persistence boundaries', () => {
  it('fails closed when candidates or expiring pantry data cannot be read', () => {
    expect(source).toContain('const candidateError = candidateResults.find((result) => result.error)?.error;');
    expect(source).toContain('const { data: pantry, error: pantryError }');
    expect(source).toContain("return databaseUnavailable(t('plan.mealPlanningDataIsTemporarily'))");
  });

  it('tracks generated meals and compensates unresolved plans', () => {
    expect(source).toContain('const createdMealIds: string[] = [];');
    expect(source).toContain('const cleanupCreatedMeals = async () =>');
    expect(source).toContain('if (persistenceError || rows.length !== assignments.length)');
    expect(source).toContain('await cleanupCreatedMeals();');
  });

  it('preserves targeted slots when replacement persistence fails', () => {
    expect(source).toContain(".select('family_id,meal_id,plan_date,meal_type,created_by')");
    expect(source).toContain('const restorePreviousPlans = async () =>');
    expect(source).toContain('const { error: deleteError }');
    expect(source).toContain(".insert(rows).select('id')");
    expect(source).toContain('inserted.length !== rows.length');
  });
});

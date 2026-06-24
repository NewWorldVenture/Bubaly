import { describe, expect, it } from 'vitest';
import { analyzeRecipes, buildRecipesPrompt, parseRecipesResponse, type RecipeForAI } from '@/lib/recipes/recipes-ai';

function recipe(overrides: Partial<RecipeForAI> = {}): RecipeForAI {
  return { name: 'Pasta Carbonara', category: 'dinner', cuisine: 'Italian', difficulty: 'medium', prep_time_mins: 15, cook_time_mins: 20, is_favorite: true, ...overrides };
}

describe('analyzeRecipes', () => {
  it('summarizes recipes', () => {
    const r = analyzeRecipes([recipe(), recipe({ category: 'lunch', is_favorite: false })]);
    expect(r.totalRecipes).toBe(2);
    expect(r.favoriteCount).toBe(1);
  });
  it('handles empty', () => { expect(analyzeRecipes([]).summary).toContain('No recipes'); });
});

describe('buildRecipesPrompt', () => {
  it('builds prompt', () => {
    const { system, user } = buildRecipesPrompt([recipe()]);
    expect(system).toContain('JSON');
    expect(user).toContain('Pasta Carbonara');
  });
});

describe('parseRecipesResponse', () => {
  it('parses valid JSON', () => {
    const r = parseRecipesResponse('{"suggestions":["try soups"],"cookingTips":["toast spices"],"varietyTip":"explore Asian cuisine"}');
    expect(r.suggestions).toEqual(['try soups']);
  });
  it('handles malformed', () => { expect(parseRecipesResponse('bad').suggestions).toEqual([]); });
});

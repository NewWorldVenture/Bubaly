import { describe, it, expect } from 'vitest';
import { normalizeThemealdb, normalizeInstructions, normalizeMeasure } from '@/lib/recipes/normalize';

describe('normalizeMeasure', () => {
  it('splits quantity from unit/name', () => {
    expect(normalizeMeasure('1 cup')).toEqual({ quantity: '1', unit: 'cup' });
    expect(normalizeMeasure('1 1/2 tbsp')).toEqual({ quantity: '1 1/2', unit: 'tbsp' });
    expect(normalizeMeasure('to taste')).toEqual({ quantity: 'to taste', unit: '' });
    expect(normalizeMeasure('')).toEqual({ quantity: '', unit: '' });
  });
});

describe('normalizeInstructions', () => {
  it('splits newline steps and strips leading numbers', () => {
    const steps = normalizeInstructions('1. Boil water\n2. Add pasta\n3. Drain');
    expect(steps).toEqual([
      { step: 1, text: 'Boil water' },
      { step: 2, text: 'Add pasta' },
      { step: 3, text: 'Drain' },
    ]);
  });
  it('falls back to sentence splitting for a single blob', () => {
    const steps = normalizeInstructions('Boil the water. Add the pasta. Serve hot.');
    expect(steps.length).toBe(3);
    expect(steps[0].text).toBe('Boil the water.');
  });
  it('returns [] for empty', () => {
    expect(normalizeInstructions(null)).toEqual([]);
  });
});

describe('normalizeThemealdb', () => {
  const meal = {
    idMeal: '52772', strMeal: 'Teriyaki Chicken', strCategory: 'Chicken', strArea: 'Japanese',
    strInstructions: 'Preheat oven.\nMix sauce.\nBake chicken.',
    strMealThumb: 'https://img/teriyaki.jpg', strTags: 'Meat,Asian', strSource: 'https://example.com/r',
    strIngredient1: 'Chicken', strMeasure1: '2 pieces',
    strIngredient2: 'Soy sauce', strMeasure2: '1/2 cup',
    strIngredient3: '', strMeasure3: '',
  };

  it('maps fields, ingredients, and steps into the vault shape', () => {
    const r = normalizeThemealdb(meal);
    expect(r.sourceProvider).toBe('themealdb');
    expect(r.sourceRecipeId).toBe('52772');
    expect(r.name).toBe('Teriyaki Chicken');
    expect(r.cuisine).toBe('Japanese');
    expect(r.category).toBe('chicken');
    expect(r.photoUrl).toBe('https://img/teriyaki.jpg');
    expect(r.tags).toEqual(['Meat', 'Asian']);
    expect(r.sourceUrl).toBe('https://example.com/r');
    expect(r.attribution).toMatch(/TheMealDB/);
    expect(r.ingredients).toEqual([
      { name: 'Chicken', quantity: '2', unit: 'pieces' },
      { name: 'Soy sauce', quantity: '1/2', unit: 'cup' },
    ]);
    expect(r.instructions).toHaveLength(3);
    expect(r.raw).toBe(meal);
  });

  it('falls back to a themealdb URL when no source given', () => {
    const r = normalizeThemealdb({ idMeal: '1', strMeal: 'X', strInstructions: 'Do it.' });
    expect(r.sourceUrl).toBe('https://www.themealdb.com/meal/1');
    expect(r.ingredients).toEqual([]);
  });
});

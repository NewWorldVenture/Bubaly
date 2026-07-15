import { describe, it, expect } from 'vitest';
import {
  recipeImage, mealImage, RECIPE_KEYWORD_IMAGES, RECIPE_CATEGORY_IMAGES,
  MEAL_TYPE_IMAGES, AMBIENT_FALLBACK_PHOTOS, DEFAULT_FOOD_IMAGE,
} from '@/lib/display/imagery';

const UNSPLASH = /^https:\/\/images\.unsplash\.com\/photo-[\w-]+\?auto=format&fit=crop&w=1600&q=80$/;

describe('imagery URL hygiene', () => {
  it('every curated URL is a well-formed Unsplash CDN image', () => {
    const all = [
      ...RECIPE_KEYWORD_IMAGES.map(([, u]) => u),
      ...Object.values(RECIPE_CATEGORY_IMAGES),
      ...Object.values(MEAL_TYPE_IMAGES),
      ...AMBIENT_FALLBACK_PHOTOS,
      DEFAULT_FOOD_IMAGE,
    ];
    expect(all.length).toBeGreaterThan(20);
    for (const url of all) expect(url).toMatch(UNSPLASH);
  });
  it('ambient fallback set is big enough to rotate', () => {
    expect(AMBIENT_FALLBACK_PHOTOS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(AMBIENT_FALLBACK_PHOTOS).size).toBe(AMBIENT_FALLBACK_PHOTOS.length);
  });
});

describe('recipeImage', () => {
  it('the recipe’s own photo always wins', () => {
    expect(recipeImage('Cheesecake', 'dessert', 'https://example.com/mine.jpg')).toBe('https://example.com/mine.jpg');
  });
  it('matches the dish by name (the live-family cases)', () => {
    expect(recipeImage('Cheesecake', 'dessert')).toContain('photo-1533134242443');
    expect(recipeImage('Chicken Tacos', 'dinner')).toContain('photo-1565299585323'); // tacos beat chicken (specific first)
    expect(recipeImage('Sunday Pancakes', 'breakfast')).toContain('photo-1567620905732');
    expect(recipeImage('One-Pot Mac & Cheese', 'dinner')).toContain('photo-1621996346565');
  });
  it('falls back to the category, then the default plate', () => {
    expect(recipeImage('Grandma’s Mystery Casserole', 'dinner')).toBe(RECIPE_CATEGORY_IMAGES.dinner);
    expect(recipeImage('Zort', 'weird-category')).toBe(DEFAULT_FOOD_IMAGE);
    expect(recipeImage(null, null)).toBe(DEFAULT_FOOD_IMAGE);
  });
});

describe('mealImage', () => {
  it('dish name first, meal type second, default last', () => {
    expect(mealImage('Homemade Pizza', 'dinner')).toContain('photo-1513104890138');
    expect(mealImage('Something New', 'breakfast')).toBe(MEAL_TYPE_IMAGES.breakfast);
    expect(mealImage(null, 'brunch')).toBe(DEFAULT_FOOD_IMAGE);
  });
});

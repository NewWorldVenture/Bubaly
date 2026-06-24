import { describe, expect, it } from 'vitest';
import {
  analyzeGroceryList,
  buildGroceryPrompt,
  parseGroceryResponse,
  type GroceryItemLike,
} from '@/lib/grocery/grocery-ai';

function item(overrides: Partial<GroceryItemLike> = {}): GroceryItemLike {
  return { name: 'Milk', category: 'Dairy & Eggs', is_checked: false, ...overrides };
}

describe('analyzeGroceryList', () => {
  it('summarizes items', () => {
    const r = analyzeGroceryList([
      item({ name: 'Milk' }),
      item({ name: 'Bread', category: 'Pantry', is_checked: true }),
      item({ name: 'Apples', category: 'Produce' }),
    ]);
    expect(r.totalItems).toBe(3);
    expect(r.checkedItems).toBe(1);
    expect(r.uncheckedItems).toBe(2);
    expect(r.categoryCounts['Dairy & Eggs']).toBe(1);
    expect(r.categoryCounts['Pantry']).toBe(1);
    expect(r.categoryCounts['Produce']).toBe(1);
    expect(r.summary).toContain('3 items');
  });

  it('handles empty list', () => {
    const r = analyzeGroceryList([]);
    expect(r.totalItems).toBe(0);
    expect(r.summary).toContain('0 items');
  });

  it('groups null category as Other', () => {
    const r = analyzeGroceryList([item({ category: null })]);
    expect(r.categoryCounts['Other']).toBe(1);
  });
});

describe('buildGroceryPrompt', () => {
  it('builds prompt with item info', () => {
    const { system, user } = buildGroceryPrompt([
      item({ name: 'Bananas', category: 'Produce' }),
      item({ name: 'Cheese', is_checked: true }),
    ]);
    expect(system).toContain('JSON');
    expect(user).toContain('Bananas');
    expect(user).toContain('1 remaining');
  });
});

describe('parseGroceryResponse', () => {
  it('parses valid JSON', () => {
    const r = parseGroceryResponse('{"suggestions":["buy in bulk"],"mealIdeas":["stir fry"],"shoppingTip":"make a list"}');
    expect(r.suggestions).toEqual(['buy in bulk']);
    expect(r.mealIdeas).toEqual(['stir fry']);
    expect(r.shoppingTip).toBe('make a list');
  });

  it('handles malformed input', () => {
    const r = parseGroceryResponse('garbage');
    expect(r.suggestions).toEqual([]);
    expect(r.mealIdeas).toEqual([]);
    expect(r.shoppingTip).toBe('');
  });

  it('handles code fences', () => {
    const r = parseGroceryResponse('```json\n{"suggestions":["x"],"mealIdeas":["y"],"shoppingTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });

  it('caps arrays at limits', () => {
    const r = parseGroceryResponse(JSON.stringify({
      suggestions: ['a', 'b', 'c', 'd', 'e'],
      mealIdeas: ['1', '2', '3', '4'],
      shoppingTip: 'tip',
    }));
    expect(r.suggestions).toHaveLength(4);
    expect(r.mealIdeas).toHaveLength(3);
  });
});

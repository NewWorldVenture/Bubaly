import { describe, expect, it } from 'vitest';
import {
  analyzeShoppingLists,
  buildShoppingPrompt,
  parseShoppingResponse,
  type ShoppingItemLike,
} from '@/lib/shopping/shopping-ai';

function item(overrides: Partial<ShoppingItemLike> = {}): ShoppingItemLike {
  return { name: 'Shoes', category: 'Clothing', is_checked: false, ...overrides };
}

describe('analyzeShoppingLists', () => {
  it('summarizes shopping', () => {
    const r = analyzeShoppingLists(2, [
      item({ is_checked: false }),
      item({ name: 'Hat', is_checked: true }),
    ]);
    expect(r.totalLists).toBe(2);
    expect(r.totalItems).toBe(2);
    expect(r.completedItems).toBe(1);
    expect(r.remainingItems).toBe(1);
    expect(r.summary).toContain('2 lists');
  });

  it('handles empty', () => {
    const r = analyzeShoppingLists(0, []);
    expect(r.totalItems).toBe(0);
  });
});

describe('buildShoppingPrompt', () => {
  it('builds prompt with item info', () => {
    const { system, user } = buildShoppingPrompt([item({ name: 'Sneakers' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Sneakers');
  });
});

describe('parseShoppingResponse', () => {
  it('parses valid JSON', () => {
    const r = parseShoppingResponse('{"suggestions":["compare prices"],"dealTips":["use coupons"],"organizationTip":"group by store"}');
    expect(r.suggestions).toEqual(['compare prices']);
    expect(r.dealTips).toEqual(['use coupons']);
    expect(r.organizationTip).toBe('group by store');
  });

  it('handles malformed input', () => {
    const r = parseShoppingResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });
});

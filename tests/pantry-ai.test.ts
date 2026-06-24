import { describe, expect, it } from 'vitest';
import {
  analyzePantry,
  buildPantryPrompt,
  parsePantryResponse,
  type PantryItemLike,
} from '@/lib/pantry/pantry-ai';

function item(overrides: Partial<PantryItemLike> = {}): PantryItemLike {
  return { name: 'Rice', category: 'Pantry', location: 'pantry', quantity: 5, expires_at: null, low_threshold: null, ...overrides };
}

describe('analyzePantry', () => {
  it('summarizes pantry', () => {
    const r = analyzePantry([
      item({ name: 'Rice', location: 'pantry' }),
      item({ name: 'Milk', location: 'fridge', quantity: 1, low_threshold: 2 }),
    ]);
    expect(r.totalItems).toBe(2);
    expect(r.lowStockCount).toBe(1);
    expect(r.summary).toContain('2 items');
  });

  it('detects expiring items', () => {
    const soon = new Date();
    soon.setDate(soon.getDate() + 3);
    const r = analyzePantry([item({ expires_at: soon.toISOString().slice(0, 10) })]);
    expect(r.expiringCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzePantry([]);
    expect(r.totalItems).toBe(0);
  });
});

describe('buildPantryPrompt', () => {
  it('builds prompt with item info', () => {
    const { system, user } = buildPantryPrompt([item({ name: 'Flour' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Flour');
  });
});

describe('parsePantryResponse', () => {
  it('parses valid JSON', () => {
    const r = parsePantryResponse('{"suggestions":["rotate stock"],"restockItems":["eggs"],"organizationTip":"label shelves"}');
    expect(r.suggestions).toEqual(['rotate stock']);
    expect(r.restockItems).toEqual(['eggs']);
    expect(r.organizationTip).toBe('label shelves');
  });

  it('handles malformed input', () => {
    const r = parsePantryResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });
});

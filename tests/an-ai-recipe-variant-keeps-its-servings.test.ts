// An AI recipe variant is saved for the servings its amounts were written for.
//
// /api/recipes/transform tells the model "Servings: N" and the model writes its
// amounts for N, but the variant's insert left `servings` out, so the column's
// default of 4 applied. An 8-serving lasagna's "healthier" variant was stored
// as serving 4 with 8-serving amounts: setting it to 8 in the viewer doubled
// everything, and "add to grocery" wrote the doubled quantities to the list.
//
// The real route against an in-memory database; only the model is a fixture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';
const h = vi.hoisted(() => ({ db: null as unknown, complete: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: async () => true, resolveProvider: async () => ({ complete: h.complete }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
// The Free plan's AI allowance has its own cases in
// tests/the-free-plans-ai-allowance-holds-on-every-helper.test.ts; it admits here.
vi.mock('@/lib/server/ai-access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/ai-access')>()),
  assertAIAllowance: async () => ({ ok: true, planLevel: 1, monthlyUsed: null, monthlyAllowance: null }),
  refuseOverAIAllowance: async () => null,
  withinAIAllowance: async () => true,
}));
// The Recipes plan gate is covered by tests/the-meal-and-recipe-model-endpoints-refuse-like-their-pages.test.ts.
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }) }));

import { POST } from '@/app/api/recipes/transform/route';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => {
  // 0014 gives family_recipes.servings a default of 4; the fake applies it the
  // way the migration does when an insert leaves the column out.
  db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: { family_recipes: { servings: 4 } } });
  h.db = db;
  h.complete.mockReset().mockResolvedValue({ text: JSON.stringify({
    name: 'Lighter lasagna', description: 'Less cheese.',
    ingredients: [{ name: 'lasagna sheets', quantity: '24', unit: '' }, { name: 'ricotta', quantity: '4', unit: 'cups' }],
    instructions: [{ step: 1, text: 'Layer and bake.' }], notes: '', tags: ['lighter'],
  }) });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const remix = (recipeId: string) => POST(new NextRequest('https://fixture.invalid/api/recipes/transform', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ recipeId, actionId: 'healthier' }),
}));

describe('an AI variant keeps its source recipe\'s servings', () => {
  it.each([8, 2])('a %i-serving recipe\'s variant is saved as serving that many', async (servings) => {
    db.seed('family_recipes', [{ id: 'lasagna', family_id: FAMILY, name: 'Lasagna', category: 'dinner', cuisine: 'Italian', servings,
      ingredients: [{ name: 'lasagna sheets', quantity: '24', unit: '' }], instructions: [], allergy_flags: [], photo_url: null }]);

    const response = await remix('lasagna');

    expect(response.status).toBe(200);
    const { id } = await response.json();
    expect(db.table('family_recipes').find((row) => row.id === id)).toMatchObject({ name: 'Lighter lasagna', servings, source_recipe_id: 'lasagna' });
    // The model was told the same number.
    expect(String(h.complete.mock.calls[0][0].messages[0].content)).toContain(`Servings: ${servings}`);
  });
});

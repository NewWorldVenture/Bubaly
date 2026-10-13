// Fridge Chef's allergen guard recognises the allergies families actually
// write, and keeps the allergen off the shopping list.
//
// The guard looked for each whole lower-cased allergy entry as a raw substring
// of title + have + need. "Peanuts" (the profile form's own placeholder spells
// it that way) is not a substring of "peanut butter"; "Tree nuts" names no
// almond; "Severe peanut allergy (EpiPen)" is a substring of nothing; and the
// method was never looked at. Such a recipe came back with no "May contain"
// warning, and "Add to grocery" put the peanut butter itself on the list —
// that path never ran the allergy swap the meal plan's list gets.
//
// The real route, Phase 1 (photo) and Phase 2 (add to grocery), against an
// in-memory database; the model's reply is the fixture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-one';
const h = vi.hoisted(() => ({ db: null as unknown, fetch: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-one' }, active: { familyId: 'family-one', role: 'parent', member: { id: 'member-one' }, family: { timezone: 'UTC', name: 'Fixture' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/ai-access', () => ({ assertAIAccess: async () => ({ ok: true }), accessDeniedResponse: () => null }));
vi.mock('@/lib/ai/settings', () => ({ getAIConfig: async () => ({ openaiKey: 'sk-fixture', model: 'gpt-4o' }) }));
vi.mock('@/lib/ai/observability', () => ({
  withAiRequest: (_s: unknown, _f: unknown, run: (o: { used: () => void; failed: () => void }) => unknown) => run({ used: () => {}, failed: () => {} }),
}));

import { POST } from '@/app/api/ai/pantry-chef/route';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

function household(allergies: string) {
  db.seed('family_members', [{ id: 'member-one', family_id: FAMILY, display_name: 'Dana', role: 'parent', is_active: true, user_id: 'user-one', created_at: '2026-01-01T00:00:00Z' }]);
  db.seed('medical_profiles', [{ id: 'mp-1', family_id: FAMILY, member_id: 'member-one', allergies }]);
}

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({ defaults: {
    grocery_lists: { is_archived: false, archived_at: null },
    grocery_items: { is_checked: false, quantity: null, category: null, source_meal_id: null },
  } });
  h.db = db;
  h.fetch.mockReset();
  vi.stubGlobal('fetch', h.fetch);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const post = (body: unknown) => POST(new NextRequest('https://fixture.invalid/api/ai/pantry-chef', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}));
async function recipeFlag(recipe: Record<string, unknown>) {
  h.fetch.mockResolvedValue(Response.json({ choices: [{ message: { content: JSON.stringify([{ have: [], need: [], steps: '', ...recipe }]) } }] }));
  const response = await post({ data: 'aGVsbG8=', mediaType: 'image/png' });
  expect(response.status).toBe(200);
  return ((await response.json()).recipes as { allergenConflict: string | null }[])[0].allergenConflict;
}

describe('Phase 1: the "May contain" flag', () => {
  it.each([
    ['Penicillin, peanuts', { title: 'Noodle bowl', need: ['peanut butter'] }, 'peanuts'],
    ['Tree nuts', { title: 'Pesto pasta', have: ['basil'], need: ['pine nuts', 'almonds'] }, 'tree nuts'],
    ['Severe peanut allergy (EpiPen)', { title: 'Trail mix', have: ['peanuts'] }, 'peanut'],
    ['Shellfish', { title: 'Garlic stir-fry', need: ['shrimp'] }, 'shellfish'],
    ['cashews', { title: 'Veggie curry', have: ['rice'], steps: 'Simmer, then finish with a handful of cashews.' }, 'cashews'],
  ])('a "%s" allergy flags %j', async (allergies, recipe, expected) => {
    household(allergies);

    expect(await recipeFlag(recipe)).toBe(expected);
  });

  it.each([
    ['Peanuts', { title: 'Oat milk pancakes', have: ['oats', 'oat milk'] }],
    ['Dairy', { title: 'Peanut-free noodles', have: ['oat milk', 'noodles'] }],
    ['Tree nuts', { title: 'Peanut noodles', need: ['peanut butter'] }],
  ])('control: a "%s" allergy does not flag %j', async (allergies, recipe) => {
    household(allergies);

    expect(await recipeFlag(recipe)).toBeNull();
  });
});

describe('Phase 2: "Add to grocery"', () => {
  it('swaps the allergen for its safe stand-in, and says so', async () => {
    household('Peanuts');

    const response = await post({ addToGrocery: ['peanut butter', 'bread'] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ added: 2, skipped: 0, swapped: [{ from: 'peanut butter', to: 'sunflower seed butter' }] });
    expect(db.table('grocery_items').map((row) => row.name)).toEqual(['sunflower seed butter', 'bread']);
  });

  it('leaves off an allergen with no safe swap', async () => {
    household('Shellfish');

    const response = await post({ addToGrocery: ['shrimp', 'limes'] });

    expect(await response.json()).toMatchObject({ added: 1, swapped: [{ from: 'shrimp', to: null }] });
    expect(db.table('grocery_items').map((row) => row.name)).toEqual(['limes']);
  });

  it('adds nothing when the allergies cannot be read', async () => {
    household('Peanuts');
    h.db = new Proxy(db, { get: (target, key) => (key === 'rpc' ? async () => ({ data: null, error: { code: 'XX000', message: 'refused' } }) : Reflect.get(target, key)) });

    const response = await post({ addToGrocery: ['peanut butter'] });

    expect(response.status).toBe(503);
    expect(db.table('grocery_items')).toEqual([]);
  });
});

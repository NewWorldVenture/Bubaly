// `family_recipes.category` is CHECK-constrained by the migration that created
// the table: it must be one of breakfast|lunch|dinner|snack|dessert|drink|side|
// appetizer|other (supabase/migrations/0014_core_platform.sql). Recipe providers
// speak their own vocabulary — TheMealDB's `strCategory` is Chicken, Beef,
// Seafood, Pasta, Vegan, Starter, Miscellaneous… — and `normalizeThemealdb`
// lowercases it without mapping it onto the vault's set.
//
// The discover save used to insert that word raw, so Postgres rejected the row
// with 23514 and "Save to vault" failed, deterministically and forever, for
// roughly two thirds of the library: only Breakfast, Dessert and Side happen to
// lowercase into a legal value. The sibling write, `createRecipe` in
// lib/services/meals/index.ts, has always clamped to the same allow-list before
// inserting; this path must too.
//
// The fake below enforces the CHECK read out of the migration itself, so this
// test fails the way the real database fails rather than the way a fake
// imagines it might.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeThemealdb } from '@/lib/recipes/normalize';

const mocks = vi.hoisted(() => ({ requireUserContext: vi.fn(), createServer: vi.fn(), getProvider: vi.fn(), revalidatePath: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/recipes/providers', () => ({ getProvider: mocks.getProvider }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { saveDiscoveredRecipe } from '@/app/(app)/dashboard/recipes/discover/actions';

/** The allowed categories, taken from the migration's CHECK rather than from memory. */
function allowedCategoriesFromMigration(): string[] {
  const sql = readFileSync('supabase/migrations/0014_core_platform.sql', 'utf8');
  const start = sql.indexOf('create table if not exists public.family_recipes');
  expect(start, 'family_recipes must still be created in 0014').toBeGreaterThan(-1);
  const block = sql.slice(start, sql.indexOf('create table', start + 1));
  const match = /check \(category in \(([^)]*)\)\)/.exec(block);
  expect(match, 'family_recipes.category must still carry its CHECK').not.toBeNull();
  return (match![1].match(/'([^']*)'/g) ?? []).map((q) => q.slice(1, -1));
}

const ALLOWED = allowedCategoriesFromMigration();

type Row = Record<string, unknown>;

/** A family_recipes table that refuses an illegal category exactly like Postgres does. */
function createVault() {
  const rows: Row[] = [];
  const db = {
    from(table: string) {
      expect(table).toBe('family_recipes');
      return {
        select() {
          const q = {
            eq: () => q,
            maybeSingle: async () => ({ data: null, error: null }),
          };
          return q;
        },
        insert(row: Row) {
          return {
            select: () => ({
              single: async () => {
                if (typeof row.category !== 'string' || !ALLOWED.includes(row.category)) {
                  return {
                    data: null,
                    error: {
                      code: '23514',
                      message: 'new row for relation "family_recipes" violates check constraint "family_recipes_category_check"',
                      details: null, hint: null,
                    },
                  };
                }
                const saved = { id: `recipe-${rows.length + 1}`, ...row };
                rows.push(saved);
                return { data: { id: saved.id }, error: null };
              },
            }),
          };
        },
      };
    },
  };
  return { db, rows };
}

/** A TheMealDB meal payload, the shape `lookup` really hands back. */
function meal(id: string, name: string, strCategory: string) {
  return {
    idMeal: id, strMeal: name, strCategory, strArea: 'Japanese',
    strInstructions: 'Preheat oven.\nMix sauce.\nBake.',
    strMealThumb: 'https://img/x.jpg', strTags: 'Meat', strSource: 'https://example.com/r',
    strIngredient1: 'Chicken', strMeasure1: '2 pieces',
  };
}

let vault: ReturnType<typeof createVault>;

function serveMeal(payload: ReturnType<typeof meal>) {
  mocks.getProvider.mockReturnValue({
    id: 'themealdb',
    label: 'TheMealDB',
    isEnabled: () => true,
    search: async () => [],
    lookup: async () => normalizeThemealdb(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vault = createVault();
  mocks.createServer.mockResolvedValue(vault.db);
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1' }, active: { familyId: 'family-1' } });
});
afterEach(() => vi.restoreAllMocks());

describe('saving a discovered recipe into the vault', () => {
  it('saves a TheMealDB "Chicken" recipe instead of dying on the category CHECK', async () => {
    serveMeal(meal('52772', 'Teriyaki Chicken', 'Chicken'));
    // What the normalizer hands the insert, unmapped: 'chicken', which is not a
    // legal family_recipes.category.
    expect(ALLOWED).not.toContain('chicken');

    const result = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: '52772' });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(vault.rows).toHaveLength(1);
    expect(ALLOWED).toContain(vault.rows[0]!.category);
  });

  it('saves every category TheMealDB actually publishes', async () => {
    // TheMealDB's live category list. Only Breakfast, Dessert and Side lowercase
    // into a legal value on their own; the other eleven are the bug's blast radius.
    const categories = ['Beef', 'Breakfast', 'Chicken', 'Dessert', 'Goat', 'Lamb', 'Miscellaneous',
      'Pasta', 'Pork', 'Seafood', 'Side', 'Starter', 'Vegan', 'Vegetarian'];

    for (const [i, category] of categories.entries()) {
      serveMeal(meal(String(1000 + i), `${category} dish`, category));
      const result = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: String(1000 + i) });
      expect(result.ok, `${category} should save, got: ${result.ok ? '' : result.error}`).toBe(true);
    }

    expect(vault.rows).toHaveLength(categories.length);
    for (const row of vault.rows) expect(ALLOWED).toContain(row.category);
  });

  it('keeps a category the vault already understands rather than flattening it', async () => {
    serveMeal(meal('52893', 'Apple Frangipan Tart', 'Dessert'));
    const result = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: '52893' });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(vault.rows[0]!.category).toBe('dessert');
  });

  it('does not lose the provider\'s own word — it survives in raw_payload', async () => {
    serveMeal(meal('52772', 'Teriyaki Chicken', 'Chicken'));
    await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: '52772' });

    expect(vault.rows).toHaveLength(1);
    expect((vault.rows[0]!.raw_payload as { strCategory?: string }).strCategory).toBe('Chicken');
  });

  it('still reports a refused insert rather than claiming a save', async () => {
    serveMeal(meal('52772', 'Teriyaki Chicken', 'Chicken'));
    mocks.createServer.mockResolvedValue({
      from: () => ({
        select: () => { const q = { eq: () => q, maybeSingle: async () => ({ data: null, error: null }) }; return q; },
        insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: '42501', message: 'permission denied', details: null, hint: null } }) }) }),
      }),
    });

    const result = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: '52772' });
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.error).toContain('permission denied');
  });
});

// saveDiscoveredRecipe, called the way the Discover page calls it, by every
// household role, against two households.
//
// THE POLICY, from the sources rather than from the action:
//   - `family_recipes` carries one `for all` policy, `is_family_member(family_id)`
//     on both halves (supabase/migrations/0426_a_policy_should_say_what_it_checks.sql:65,
//     re-asserting 0014's; 0107's per-command policies say the same), and no
//     guest guard trigger (0464 and 0481 do not list it). Recipes is a Free
//     feature (lib/constants/feature-catalog.ts:82) at minLevel 0 with no
//     `manage` flag, and the Discover page offers "Save to vault" with no role
//     check (discover-client.tsx). So every member but a guest is pinned as
//     allowed. A guest is reported for an owner decision: the database lets a
//     guest write the vault, while lib/constants/roles.ts describes a guest as
//     viewing and 0464's header says every model has a guest look and not write.
//   - The family is the session's: the duplicate probe and the insert are both
//     scoped to it, so another family having saved the same provider recipe is
//     not "already in your vault", and their copy is never returned or touched.
//
// The provider is the one seam: `getProvider` answers a fake provider whose
// lookup returns a fixed recipe, with no network. Mocked as well: the session,
// the server client factory, next/cache and the translator (the real en-US
// source catalogue).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { CALLERS, FAMILY_A, FAMILY_B, userIdOf, type Caller } from './helpers/role-callers';

const harness = vi.hoisted(() => ({
  caller: 'parent' as string | null,
  db: null as unknown,
  revalidatePath: [] as string[],
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { harness.revalidatePath.push(path); } }));
vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller)
      : callers.signedOut()),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/recipes/providers', () => {
  const recipe = {
    sourceProvider: 'testkitchen', sourceRecipeId: '52772', sourceUrl: 'https://recipes.example.com/52772',
    attribution: 'Test Kitchen', licenseNotes: 'Example licence', name: 'Teriyaki Chicken', description: null,
    // A provider's own word, which the vault's CHECK constraint does not allow.
    category: 'Chicken', cuisine: 'Japanese', photoUrl: null, tags: ['quick'],
    ingredients: [{ name: 'Chicken', quantity: '2', unit: 'pieces' }],
    instructions: [{ step: 1, text: 'Cook it.' }], raw: { idMeal: '52772' },
  };
  const provider = { id: 'testkitchen', label: 'Test Kitchen', isEnabled: () => true, search: async () => [recipe], lookup: async (id: string) => (id === '52772' ? recipe : null) };
  return { getProvider: (id: string) => (id === 'testkitchen' ? provider : undefined) };
});

const { saveDiscoveredRecipe } = await import('@/app/(app)/dashboard/recipes/discover/actions');

const THEIR_COPY = 'b0000000-0000-4000-8000-0000000f0001';
const INPUT = { provider: 'testkitchen', sourceRecipeId: '52772' };

/** Every caller pinned as allowed; a guest is the owner's decision and is left out. */
const SAVERS: Caller[] = CALLERS.filter((c) => c !== 'guest');

let db: InMemorySupabase;
const recipes = () => db.table('family_recipes');
const familyB = () => structuredClone(recipes().filter((row) => row.family_id === FAMILY_B));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { family_recipes: [['family_id', 'source_provider', 'source_recipe_id']] } });
  harness.db = db;
  harness.caller = 'parent';
  harness.revalidatePath = [];
  // Family B already saved the same provider recipe.
  db.seed('family_recipes', [{
    id: THEIR_COPY, family_id: FAMILY_B, name: 'Teriyaki Chicken', category: 'dinner',
    source_provider: 'testkitchen', source_recipe_id: '52772', created_by: userIdOf('parent', FAMILY_B),
  }]);
});

const as = (caller: Caller | null) => { harness.caller = caller; };

describe('saveDiscoveredRecipe (ACTION-A027C4B03998)', () => {
  it.each(SAVERS)('ACTION-A027C4B03998 a %s saves the recipe into their own vault, once, attributed to them', async (caller) => {
    as(caller);
    const first = await saveDiscoveredRecipe(INPUT);

    const ours = recipes().filter((row) => row.family_id === FAMILY_A);
    expect(ours).toEqual([expect.objectContaining({
      name: 'Teriyaki Chicken', category: 'dinner', source_provider: 'testkitchen', source_recipe_id: '52772',
      attribution: 'Test Kitchen', created_by: userIdOf(caller),
    })]);
    expect(first).toEqual({ ok: true, id: ours[0].id });
    expect(harness.revalidatePath).toEqual(['/dashboard/recipes']);

    // Saving again finds the family's own copy rather than writing a second.
    expect(await saveDiscoveredRecipe(INPUT)).toEqual({ ok: true, id: ours[0].id, already: true });
    expect(recipes().filter((row) => row.family_id === FAMILY_A)).toHaveLength(1);
  });

  it("ACTION-A027C4B03998 another family's saved copy is not this family's: neither returned nor touched", async () => {
    const before = familyB();
    const result = await saveDiscoveredRecipe(INPUT);

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(result).not.toEqual(expect.objectContaining({ id: THEIR_COPY }));
    expect(result).not.toHaveProperty('already');
    expect(recipes().filter((row) => row.family_id === FAMILY_A)).toHaveLength(1);
    expect(familyB()).toEqual(before);
  });

  it('ACTION-A027C4B03998 a source that is not offered, or a recipe it does not have, writes nothing', async () => {
    const before = structuredClone(recipes());
    expect(await saveDiscoveredRecipe({ provider: 'nowhere', sourceRecipeId: '52772' }))
      .toEqual({ ok: false, error: 'That recipe source is unavailable.' });
    expect(await saveDiscoveredRecipe({ provider: 'testkitchen', sourceRecipeId: '1' }))
      .toEqual({ ok: false, error: 'Could not load that recipe.' });
    expect(recipes()).toEqual(before);
  });

  it('ACTION-A027C4B03998 a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    const before = structuredClone(recipes());
    await expect(saveDiscoveredRecipe(INPUT)).rejects.toThrow('NEXT_REDIRECT');
    expect(recipes()).toEqual(before);
  });
});

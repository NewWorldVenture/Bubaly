// Turning a won meal vote into groceries must never spell a failed read as a
// fact about the family's food.
//
// `addWinnerToGrocery` made four reads and destructured only `data` from every
// one of them:
//
//     const { data: vote }   = ...from('meal_votes')...maybeSingle();
//     if (!vote?.winner_option_id) return { ok: false, error: t('actions.noWinnerYetCloseThe') };
//     const { data: option } = ...from('meal_vote_options')...maybeSingle();
//     if (!option?.recipe_id)      return { ok: false, error: t('actions.theWinningOptionIsNot') };
//     const { data: recipe } = ...from('family_recipes')...maybeSingle();
//     const ingredients = (recipe?.ingredients as ...) ?? [];
//     if (ingredients.length === 0) return { ok: false, error: t('actions.thatRecipeHasNoIngredients') };
//     const { data: list }   = ...from('grocery_lists')...maybeSingle();
//     let listId = list?.id;
//     if (!listId) { ...insert({ name: 'Groceries' })... }
//
// A refused read arrives as `data: null` — the same value as the benign absence
// each guard was written for — so the family is told a confident, false thing
// about their own data:
//
//   1. meal_votes refused   -> "No winner yet — close the vote first." about a
//      vote where tacos beat pizza 3-0. The button that says this ONLY renders on
//      a closed vote (vote-client.tsx:69-71), so the instruction is impossible to
//      follow; obeying it means reopening, and `reopenMealVote` nulls
//      `winner_option_id`, erasing the verdict the action was wrong about.
//   2. meal_vote_options refused -> "The winning option is not a saved recipe."
//      about an option that is linked to one.
//   3. family_recipes refused -> "That recipe has no ingredients." about a recipe
//      with eight, because `?? []` launders the failure into an empty list.
//   4. grocery_lists refused -> the worst, and the one that PERSISTS. The action
//      concludes the family has no list, creates a second "Groceries", drops taco
//      night's tortillas and ground beef into it, and returns { ok: true } so
//      vote-client toasts "Added to grocery list". The shopping page auto-selects
//      the oldest list (shopping-module.tsx) and so do `ensureDefaultList` and
//      `listOpen`, so every other surface keeps writing to the original: whoever
//      shops that night buys from the old list and comes home without the
//      ingredients Bubaly said it had added.
//
// The identical bug on the identical `grocery_lists` query was already fixed in
// components/modules/recipes-module.tsx ("A failed read is not 'you have no
// list'... The difference between 'no list' and 'could not check' is a write.")
// and `closeMealVote`, directly above this action, refuses on
// `describeReadError`. This action was left behind.
//
// These drive the real action with one read failing at a time and require a
// failed read to produce a DIFFERENT outcome than the benign absence it used to
// be indistinguishable from — and, for the grocery list, to write nothing at all.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The REAL en-US catalogue, not `(key) => key`. An identity mock turns a key the
// catalogue does not hold into a string that differs from every other key, so
// "not the old refusal" passed while the family would have been toasted the raw
// text "actions.couldNotCheckThisVote" (lib/i18n/translate.ts falls back to the
// key). The refusals below are asserted as the ENGLISH SENTENCE. Two of them,
// `actions.couldNotCheckThisVote` (scratchpad/i18n-asks/m32.json) and
// `actions.couldNotConfirmWhetherTheWinning` (i18n-asks/m33+m34.json), are
// merged into all seven locales by the audit's i18n pass; until that merge
// lands, the cases asserting them are RED on purpose.
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const say = (key: string) => MESSAGES[key] ?? key;
const CHECK_FAILED = 'Could not check this vote and its winning recipe, so nothing was added to your grocery list. Please try again.';
const NOT_CONFIRMED = "Could not confirm whether the winning recipe's ingredients reached your grocery list. Check the list before trying again — anything already on it will not be added twice.";

type ReadResult = { data: unknown; error: unknown } | 'reject';

const reads = vi.hoisted(() => ({
  values: {} as Record<string, ReadResult>,
  /** Tables whose INSERT is written and then never answered: the rows land, the response is lost. */
  insertLostAfterWrite: new Set<string>(),
}));

/** Every INSERT the action actually issued, in order. */
const inserts: { table: string; values: unknown }[] = [];

/**
 * The grocery_items rows as the database would hold them. The action adds
 * through the grocery service, which reads the inserted rows back and checks
 * them before it reports success, so the fake has to answer with what was
 * written rather than with nothing.
 */
const savedItems: Record<string, unknown>[] = [];

function insertAnswer(table: string, values: unknown) {
  if (table === 'grocery_lists') return { data: { id: 'list-forked' }, error: null, count: null };
  if (table === 'grocery_items') {
    const rows = (Array.isArray(values) ? values : [values]).map((row, i) => ({
      id: `item-${savedItems.length + i + 1}`, is_checked: false, source_meal_id: null, ...(row as object),
    }));
    savedItems.push(...rows);
    return { data: rows, error: null, count: null };
  }
  return { data: null, error: null, count: null };
}

function fakeClient() {
  const builder = (table: string) => {
    let mode: 'read' | 'insert' = 'read';
    let values: unknown;
    const chain: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'is', 'order', 'limit', 'in']) chain[method] = () => chain;
    chain.insert = (rows: unknown) => {
      mode = 'insert';
      values = rows;
      inserts.push({ table, values: rows });
      return chain;
    };
    const settled = (): Promise<unknown> => {
      if (mode === 'insert') {
        const answer = insertAnswer(table, values);
        if (reads.insertLostAfterWrite.has(table)) return Promise.reject(new Error('CONNECT_TIMEOUT'));
        return Promise.resolve(answer);
      }
      const result = reads.values[table];
      if (result === 'reject') return Promise.reject(new Error('CONNECT_TIMEOUT'));
      if (result === undefined && table === 'grocery_items') return Promise.resolve({ data: [...savedItems], error: null, count: null });
      return Promise.resolve({ ...(result ?? { data: null, error: null }), count: null });
    };
    chain.maybeSingle = settled;
    chain.single = settled;
    chain.then = (...args: unknown[]) => settled().then(...(args as [never, never]));
    return chain;
  };
  /**
   * 0443's `ensure_default_grocery_list`, which the grocery service now calls
   * before it falls back to read-then-insert (DATA-007). It does the same list
   * read under the caller's RLS and the same insert, inside one lock, so it is
   * modelled over the SAME state the `grocery_lists` read above answers from: a
   * refused read comes back as the function's error and creates nothing, a read
   * that never completed rejects, an existing list is returned, and only a
   * family that genuinely has none gets one — recorded in `inserts` because the
   * function's INSERT is a write this action caused.
   */
  const rpc = (fn: string, args: Record<string, unknown>) => {
    if (fn !== 'ensure_default_grocery_list') {
      return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } });
    }
    const result = reads.values.grocery_lists;
    if (result === 'reject') return Promise.reject(new Error('CONNECT_TIMEOUT'));
    if (result?.error) return Promise.resolve({ data: null, error: result.error });
    const existing = (result?.data as { id?: string } | null | undefined)?.id;
    if (existing) return Promise.resolve({ data: existing, error: null });
    const values = { family_id: args.p_family_id, name: args.p_name, created_by: args.p_created_by };
    inserts.push({ table: 'grocery_lists', values });
    return Promise.resolve({ data: (insertAnswer('grocery_lists', values).data as { id: string }).id, error: null });
  };
  return { from: builder, rpc };
}

vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'mem-1' }, family: { timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => fakeClient() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => say }));

const { addWinnerToGrocery } = await import('@/app/(app)/dashboard/recipes/vote/actions');

// Tacos won, they are a saved recipe, the recipe has ingredients, and the family
// already keeps one "Groceries" list.
const HEALTHY: Record<string, ReadResult> = {
  meal_votes: { data: { winner_option_id: 'opt-tacos' }, error: null },
  meal_vote_options: { data: { recipe_id: 'rec-tacos', label: 'Tacos' }, error: null },
  family_recipes: {
    data: { ingredients: [{ name: 'tortillas' }, { name: 'ground beef', quantity: '1', unit: 'lb' }] },
    error: null,
  },
  grocery_lists: { data: { id: 'list-the-family-already-has' }, error: null },
};

const REFUSED = { data: null, error: { message: 'canceling statement due to statement timeout' } };
/** What a policy denial or a genuinely absent row looks like: no rows, no error. */
const ABSENT = { data: null, error: null };

const listsCreated = () => inserts.filter((i) => i.table === 'grocery_lists');
const itemsAdded = () => inserts.filter((i) => i.table === 'grocery_items');

beforeEach(() => {
  inserts.length = 0;
  savedItems.length = 0;
  reads.values = { ...HEALTHY };
  reads.insertLostAfterWrite.clear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('adding a won meal vote to the groceries when the grocery list read fails', () => {
  // The headline: the only one of the four that used to persist a false state.
  it('does not fork a second "Groceries" list, and adds nothing', async () => {
    reads.values.grocery_lists = REFUSED;
    const result = await addWinnerToGrocery('vote-1');
    expect(result.ok).toBe(false);
    expect(listsCreated()).toEqual([]);
    expect(itemsAdded()).toEqual([]);
  });

  it('never claims the ingredients were added when it could not read the list', async () => {
    reads.values.grocery_lists = REFUSED;
    const result = await addWinnerToGrocery('vote-1');
    // vote-client toasts an "Added …" line on ok:true, and the refusal otherwise.
    expect(result.ok, 'a refused read must not report success').toBe(false);
  });

  it('does not do to a refused list read what it does to a family with no list', async () => {
    reads.values.grocery_lists = REFUSED;
    const failed = await addWinnerToGrocery('vote-1');
    const afterFailed = [...inserts];

    inserts.length = 0;
    reads.values.grocery_lists = ABSENT;
    const absent = await addWinnerToGrocery('vote-1');

    expect({ result: failed, writes: afterFailed }).not.toEqual({ result: absent, writes: [...inserts] });
  });

  // A transport failure REJECTS rather than resolving with { error }, which is
  // how an overloaded database fails. Unwrapped it threw out of the server
  // action, so the client's transition never got a result to toast.
  it('refuses, rather than throwing, when the list read never completed', async () => {
    reads.values.grocery_lists = 'reject';
    const result = await addWinnerToGrocery('vote-1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe(NOT_CONFIRMED);
    expect(listsCreated()).toEqual([]);
    expect(itemsAdded()).toEqual([]);
  });
});

// A rejection is not proof that nothing was written: the request can die after
// the database took the rows and before the answer came back. The action cannot
// tell those apart, so it must not tell the family "Could not add those items."
describe('adding a won meal vote to the groceries when the add itself never answers', () => {
  it('does not say "could not add" about rows that are on the list', async () => {
    reads.insertLostAfterWrite.add('grocery_items');
    const result = await addWinnerToGrocery('vote-1');
    expect(savedItems.map((row) => row.name), 'the rows did land').toEqual(['tortillas', 'ground beef']);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toBe(say('actions.couldNotAddThoseItems'));
    expect(result.ok === false && result.error).toBe(NOT_CONFIRMED);
  });
});

describe('adding a won meal vote to the groceries when a source read fails', () => {
  it('does not answer "no winner yet — close the vote first" about a closed, won vote', async () => {
    reads.values.meal_votes = REFUSED;
    const result = await addWinnerToGrocery('vote-1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toBe(say('actions.noWinnerYetCloseThe'));
    expect(result.ok === false && result.error).toBe(CHECK_FAILED);
    expect(itemsAdded()).toEqual([]);
  });

  it('does not answer "the winning option is not a saved recipe" about one that is', async () => {
    reads.values.meal_vote_options = REFUSED;
    const result = await addWinnerToGrocery('vote-1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toBe(say('actions.theWinningOptionIsNot'));
    expect(result.ok === false && result.error).toBe(CHECK_FAILED);
    expect(itemsAdded()).toEqual([]);
  });

  it('does not answer "that recipe has no ingredients" about a recipe that has two', async () => {
    reads.values.family_recipes = REFUSED;
    const result = await addWinnerToGrocery('vote-1');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).not.toBe(say('actions.thatRecipeHasNoIngredients'));
    expect(result.ok === false && result.error).toBe(CHECK_FAILED);
    expect(itemsAdded()).toEqual([]);
  });

  it.each(['meal_votes', 'meal_vote_options', 'family_recipes'] as const)(
    'tells a refused %s read apart from the absence it used to be confused with',
    async (table) => {
      reads.values[table] = REFUSED;
      const failed = await addWinnerToGrocery('vote-1');
      reads.values[table] = ABSENT;
      const absent = await addWinnerToGrocery('vote-1');
      expect(failed).not.toEqual(absent);
    },
  );
});

// Negative controls. Without these, every assertion above would also pass on an
// action that refuses to build a grocery list under any circumstances at all.
describe('adding a won meal vote to the groceries when every read succeeds', () => {
  it('adds the winning recipe to the list the family already has', async () => {
    const result = await addWinnerToGrocery('vote-1');
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(listsCreated(), 'must not create a list the family already has').toEqual([]);
    expect(itemsAdded()).toHaveLength(1);
    // Filed by aisle, because the add goes through the grocery service now.
    expect(itemsAdded()[0].values).toEqual([
      { family_id: 'fam-1', list_id: 'list-the-family-already-has', created_by: 'user-1', name: 'tortillas', quantity: null, category: 'Bakery' },
      { family_id: 'fam-1', list_id: 'list-the-family-already-has', created_by: 'user-1', name: 'ground beef', quantity: '1 lb', category: 'Meat & Seafood' },
    ]);
  });

  it('still creates the first list for a family that genuinely has none', async () => {
    reads.values.grocery_lists = ABSENT;
    const result = await addWinnerToGrocery('vote-1');
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(listsCreated()).toHaveLength(1);
    expect((listsCreated()[0].values as { name: string }).name).toBe('Groceries');
    expect(itemsAdded()).toHaveLength(1);
  });

  it('still says "no winner yet" when the vote genuinely has no winner', async () => {
    reads.values.meal_votes = { data: { winner_option_id: null }, error: null };
    const result = await addWinnerToGrocery('vote-1');
    expect(result.ok === false && result.error).toBe('No winner yet — close the vote first.');
  });

  it('still says the winner is not a saved recipe when it genuinely is not', async () => {
    reads.values.meal_vote_options = { data: { recipe_id: null, label: 'Pizza night' }, error: null };
    const result = await addWinnerToGrocery('vote-1');
    expect(result.ok === false && result.error).toBe('The winning option is not a saved recipe.');
  });

  it('still says the recipe has no ingredients when it genuinely has none', async () => {
    reads.values.family_recipes = { data: { ingredients: [] }, error: null };
    const result = await addWinnerToGrocery('vote-1');
    expect(result.ok === false && result.error).toBe('That recipe has no ingredients.');
  });
});

// ── The copy half: both new refusals exist in every populated locale ─────────
//
// The English-sentence assertions above prove the key resolves in en-US and
// nowhere else: `getMessages` overlays a locale on `{ ...enUS }`, so a merge
// that reached en-US alone would leave a French family reading English while
// every case above stayed green. This is the idiom the neighbouring grocery
// test uses for its new keys. RED until scratchpad/i18n-asks/m32.json and
// m33+m34.json are merged into all seven catalogues by the audit's i18n pass.
/** The catalogues that hold real copy. en-GB/es-MX/es-US/fr-CA are declared placeholders. */
const POPULATED = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const NEW_REFUSALS = ['actions.couldNotCheckThisVote', 'actions.couldNotConfirmWhetherTheWinning'];

describe('the two refusals this action can toast are translated', () => {
  it.each(POPULATED)('%s holds both', (locale) => {
    const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
    for (const key of NEW_REFUSALS) {
      expect(messages[key], `${locale} is missing ${key}`).toBeTruthy();
      // A catalogue that echoes the key back would make `say` above "resolve" it.
      expect(messages[key], `${locale} stores the raw key as its own copy`).not.toBe(key);
    }
  });
});

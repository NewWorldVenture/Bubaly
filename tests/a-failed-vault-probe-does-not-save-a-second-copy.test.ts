// "Save to vault" on Dashboard → Recipes → Discover asks one question before it
// writes: is this provider recipe already in the family's vault?
// (app/(app)/dashboard/recipes/discover/actions.ts). That probe's error used not
// to be bound at all — only `{ data: existing }` was destructured — so a lookup
// that FAILED returned `existing === null`, which is bit-for-bit the answer for
// "not saved yet". Control fell into the unconditional insert and the action
// returned `{ ok: true }`, so discover-client.tsx toasted "Saved to your family
// vault" over a second identical card.
//
// Two ways that lookup fails, and the first one compounds:
//
//  1. postgrest-js turns `maybeSingle()` on MORE THAN ONE matching row into
//     PGRST116 / HTTP 406 with `data: null`. 0054 created a PLAIN index on
//     (family_id, source_provider, source_recipe_id), not a unique one, so two
//     members tapping Save on the same TheMealDB recipe in the same second both
//     probed empty and both inserted. From that moment the probe errored on
//     EVERY later call, and every later tap — including a cook just checking
//     whether they had already saved it — appended another copy. Unbounded.
//  2. Any transient error on that one SELECT (timeout, connection reset) bought
//     one silent duplicate plus a success toast.
//
// The house rule was already written down, one directory over, at
// lib/services/idempotency.ts: "A probe that fails is treated as fatal rather
// than falling through to `create`: a duplicate calendar event or a duplicate
// charge is worse than an honest 'try again'." Every sibling probe obeys it.
// This was the one that did not.
//
// So the outcomes asserted below are the ones a family would see in the vault
// grid at /dashboard/recipes:
//   - a probe that failed never becomes a second card;
//   - a vault that already holds two copies stops growing, and answers
//     "already saved" instead of a permanent wall (that is the `.limit(1)` half);
//   - the loser of a genuine race is told it is already saved, not shown an error;
//   - and a collision with nothing behind it is still reported as a failure, so
//     the 23505 branch cannot manufacture a success.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeThemealdb } from '@/lib/recipes/normalize';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  getProvider: vi.fn(),
  revalidatePath: vi.fn(),
}));
// The REAL en-US catalogue, not `(key) => key`. An identity mock makes a key
// that no catalogue holds indistinguishable from one that does, and the family
// would then read the raw key 'actions.couldNotCheckYourRecipeVault' in the
// toast (lib/i18n/translate.ts falls back to the key; discover-client.tsx toasts
// `res.error` as-is). Resolving through the catalogue and asserting the English
// sentence below is what makes a missing entry fail here.
const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => MESSAGES[key] ?? key,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/recipes/providers', () => ({ getProvider: mocks.getProvider }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

import { saveDiscoveredRecipe } from '@/app/(app)/dashboard/recipes/discover/actions';

const MIGRATION = 'supabase/migrations/0349_one_saved_copy_of_a_provider_recipe_per_family.sql';
const AI_VARIANT_ROUTE = 'app/api/recipes/transform/route.ts';

// ---------------------------------------------------------------------------
// The fake's fidelity, proved rather than assumed.
// ---------------------------------------------------------------------------

/**
 * The >1-row behaviour the whole compounding mode rests on is the CLIENT's, not
 * Postgres's: postgrest-js checks the array itself and synthesises PGRST116/406.
 * Read it out of the installed package so a dependency bump that changes it
 * fails here instead of quietly making this file fiction.
 */
function postgrestTurnsManyRowsIntoAnError(): boolean {
  const dist = readFileSync('node_modules/@supabase/postgrest-js/dist/index.cjs', 'utf8');
  // Anchor on the BRANCH, not on the flag's declaration — the flag is also set in
  // the builder's constructor, hundreds of lines away from the decision.
  const at = dist.search(/isMaybeSingle\s*&&\s*Array\.isArray/);
  if (at < 0) return false;
  const window = dist.slice(at, at + 1200);
  return /data\.length\s*>\s*1/.test(window) && window.includes('PGRST116') && /406/.test(window);
}

/**
 * The provider string 0349 deliberately EXEMPTS from the unique index, read out
 * of the migration. This must not be remembered: `app/api/recipes/transform/
 * route.ts` writes several rows sharing (family_id, <that provider>, <vault
 * recipe id>) — one per AI variant (healthier, cheaper, gluten-free) of the same
 * recipe — so a blanket unique index would kill the second variant of anything.
 */
function exemptProviderFromMigration(): string {
  const sql = readFileSync(MIGRATION, 'utf8');
  const create = /create unique index\s+uq_family_recipes_source([\s\S]*?);/i.exec(sql);
  expect(create, `${MIGRATION} must still create uq_family_recipes_source`).not.toBeNull();
  const body = create![1];
  expect(body, '0349 must still be unique on the natural key')
    .toMatch(/\(\s*family_id\s*,\s*source_provider\s*,\s*source_recipe_id\s*\)/);
  const where = body.slice(body.toLowerCase().indexOf('where'));
  expect(where, '0349 must stay PARTIAL — a blanket unique index breaks the AI variants').toMatch(/^where/i);
  expect(where, '0349 must skip rows with no provider recipe id (hand-typed recipes)')
    .toMatch(/source_recipe_id\s+is\s+not\s+null/i);
  const exempt = /source_provider\s*<>\s*'([^']+)'/.exec(where);
  expect(exempt, "0349's predicate must still name the AI-variant provider it exempts").not.toBeNull();
  return exempt![1];
}

const EXEMPT_PROVIDER = exemptProviderFromMigration();

// ---------------------------------------------------------------------------
// A family_recipes table that answers like postgrest-js and refuses like 0349.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** True when 0349's partial unique index covers this row at all. */
function indexed(row: Row): boolean {
  return row.source_recipe_id != null && row.source_provider != null && row.source_provider !== EXEMPT_PROVIDER;
}

function createVault(seed: Row[], uniqueIndex: boolean) {
  const rows: Row[] = seed.map((r, i) => ({ id: `seeded-${i + 1}`, ...r }));
  let nextId = 1;
  const state = {
    rows,
    /** Consumed by the NEXT probe: a transient DB failure on that one SELECT. */
    probeError: null as { code: string; message: string; details: string | null; hint: string | null } | null,
    /** Is 0349 applied on this database? No default: see BEFORE_0349 / AFTER_0349. */
    uniqueIndex,
    /** Collide every insert, even against an empty table (a 23505 from elsewhere). */
    alwaysCollide: false,
    /** Another request's write, landing between our probe and our insert. */
    racer: null as Row | null,
    probes: 0,
    inserts: 0,
  };

  const db = {
    from(table: string) {
      expect(table).toBe('family_recipes');
      return {
        select() {
          const filters: [string, unknown][] = [];
          let lim: number | null = null;
          const q = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return q;
            },
            limit(n: number) {
              lim = n;
              return q;
            },
            async maybeSingle() {
              state.probes += 1;
              if (state.probeError) {
                const error = state.probeError;
                state.probeError = null;
                return { data: null, error, status: 500, statusText: 'Internal Server Error', count: null };
              }
              let matched = state.rows.filter((r) => filters.every(([c, v]) => r[c] === v));
              if (lim !== null) matched = matched.slice(0, lim);
              // postgrest-js's own rule, not Postgres's: more than one row is an
              // error with `data: null` — the same data as "nothing matched".
              if (matched.length > 1) {
                return {
                  data: null,
                  error: {
                    code: 'PGRST116',
                    details: `Results contain ${matched.length} rows, application/vnd.pgrst.object+json requires 1 row`,
                    hint: null,
                    message: 'JSON object requested, multiple (or no) rows returned',
                  },
                  status: 406,
                  statusText: 'Not Acceptable',
                  count: null,
                };
              }
              const hit = matched[0];
              return { data: hit ? { id: hit.id } : null, error: null, status: 200, count: null };
            },
          };
          return q;
        },
        insert(row: Row) {
          return {
            select: () => ({
              single: async () => {
                if (state.racer) {
                  state.rows.push({ id: 'recipe-winner', ...state.racer });
                  state.racer = null;
                }
                const collides =
                  state.alwaysCollide ||
                  (state.uniqueIndex &&
                    indexed(row) &&
                    state.rows.some(
                      (r) =>
                        indexed(r) &&
                        r.family_id === row.family_id &&
                        r.source_provider === row.source_provider &&
                        r.source_recipe_id === row.source_recipe_id,
                    ));
                if (collides) {
                  return {
                    data: null,
                    error: {
                      code: '23505',
                      message:
                        'duplicate key value violates unique constraint "uq_family_recipes_source"',
                      details: null,
                      hint: null,
                    },
                  };
                }
                state.inserts += 1;
                const saved = { id: `recipe-${nextId++}`, ...row };
                state.rows.push(saved);
                return { data: { id: saved.id }, error: null };
              },
            }),
          };
        },
      };
    },
  };

  return { db, state };
}

/** A TheMealDB meal payload, the shape `lookup` really hands back. */
function meal(id: string, name: string, strCategory = 'Chicken') {
  return {
    idMeal: id,
    strMeal: name,
    strCategory,
    strArea: 'Japanese',
    strInstructions: 'Preheat oven.\nMix sauce.\nBake.',
    strMealThumb: 'https://img/x.jpg',
    strTags: 'Meat',
    strSource: 'https://example.com/r',
    strIngredient1: 'Chicken',
    strMeasure1: '2 pieces',
  };
}

/** The vault row the save writes for that meal — used to seed prior copies. */
function savedCopy(id: string, name: string): Row {
  return { family_id: 'family-1', name, source_provider: 'themealdb', source_recipe_id: id };
}

function serveMeal(payload: ReturnType<typeof meal>) {
  mocks.getProvider.mockReturnValue({
    id: 'themealdb',
    label: 'TheMealDB',
    isEnabled: () => true,
    search: async () => [],
    lookup: async () => normalizeThemealdb(payload),
  });
}

const TERIYAKI = '52772';
let vault: ReturnType<typeof createVault>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUserContext.mockResolvedValue({ user: { id: 'user-1' }, active: { familyId: 'family-1' } });
  serveMeal(meal(TERIYAKI, 'Teriyaki Chicken'));
});
afterEach(() => vi.restoreAllMocks());

/**
 * 0349 is WRITTEN, NOT APPLIED — it waits on the owner. The database production
 * runs today carries only 0054's plain index, so every insert succeeds there and
 * the code alone (the fail-closed probe, the `.limit(1)` bound) is what protects
 * the vault. So every call below names which database it models instead of
 * inheriting a default, and the probe outcomes are proved against both.
 */
const BEFORE_0349 = { name: 'before 0349 is applied (production today)', uniqueIndex: false } as const;
const AFTER_0349 = { name: 'after 0349 is applied', uniqueIndex: true } as const;
type VaultDatabase = typeof BEFORE_0349 | typeof AFTER_0349;

function useVault(database: VaultDatabase, seed: Row[] = []) {
  vault = createVault(seed, database.uniqueIndex);
  mocks.createServer.mockResolvedValue(vault.db);
  return vault;
}

describe('a failed vault probe does not save a second copy', () => {
  it('models postgrest-js truthfully: more than one row IS an error there', () => {
    expect(
      postgrestTurnsManyRowsIntoAnError(),
      'postgrest-js no longer synthesises PGRST116/406 for a multi-row maybeSingle() — ' +
        'the fake in this file, and the bug it guards, both need re-deriving',
    ).toBe(true);
  });

  describe.each([BEFORE_0349, AFTER_0349])('on the database $name', (database) => {
    it('a transient error on the lookup is an honest "try again", not a duplicate card', async () => {
      const { state } = useVault(database, [savedCopy(TERIYAKI, 'Teriyaki Chicken')]);
      state.probeError = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };

      const result = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: TERIYAKI });

      expect(result.ok, 'a save that could not check the vault must not report success').toBe(false);
      // What the family reads in the toast, in English. RED until the catalogue
      // merge adds `actions.couldNotCheckYourRecipeVault` to lib/i18n/messages/
      // (requested centrally; it lands in the same commit as this file) — until
      // then the action hands back the bare key, which is exactly the defect this
      // assertion exists to catch.
      expect(result.ok ? '' : result.error).toBe(
        'We could not check whether this recipe is already in your vault. Please try again.',
      );
      // The outcome in the vault grid: still one Teriyaki Chicken card.
      expect(state.rows).toHaveLength(1);
      expect(state.inserts).toBe(0);
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    });

    it('a vault that already holds two copies stops growing — and still says "already saved"', async () => {
      // The compounding mode: the pair is already there (two members raced before
      // 0349 existed), so an unbounded probe returns PGRST116 for ever.
      const { state } = useVault(database, [
        savedCopy(TERIYAKI, 'Teriyaki Chicken'),
        savedCopy(TERIYAKI, 'Teriyaki Chicken'),
      ]);

      const result = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: TERIYAKI });

      expect(result.ok, result.ok ? '' : result.error).toBe(true);
      expect(result.ok && result.already, 'the family must be told it is already in the vault').toBe(true);
      expect(state.rows, 'the third tap must not become a third card').toHaveLength(2);
      expect(state.inserts).toBe(0);
    });

    it('tapping Save again on an already-saved recipe is answered, not re-inserted', async () => {
      const { state } = useVault(database, [savedCopy(TERIYAKI, 'Teriyaki Chicken')]);

      const result = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: TERIYAKI });

      expect(result.ok, result.ok ? '' : result.error).toBe(true);
      expect(result.ok && result.already).toBe(true);
      expect(state.rows).toHaveLength(1);
    });

    it('still saves a recipe that really is new', async () => {
      const { state } = useVault(database);

      const result = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: TERIYAKI });

      expect(result.ok, result.ok ? '' : result.error).toBe(true);
      expect(result.ok && result.already).toBeFalsy();
      expect(state.rows).toHaveLength(1);
      expect(state.rows[0]!.source_recipe_id).toBe(TERIYAKI);
      expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/recipes');
    });
  });

  it('before 0349, a true race can still leave two copies — and the pair stops there', async () => {
    // The residual 0349 exists to close, asserted rather than hidden: with only
    // 0054's plain index both racers' inserts succeed, so the code alone cannot
    // stop the pair from being created. What it does guarantee on today's
    // database is that the pair never grows — the next tap answers "already
    // saved", where the unbounded probe used to hit PGRST116 and insert a third.
    const { state } = useVault(BEFORE_0349);
    state.racer = savedCopy(TERIYAKI, 'Teriyaki Chicken');

    const raced = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: TERIYAKI });
    expect(raced.ok, raced.ok ? '' : raced.error).toBe(true);
    expect(state.rows, 'without the unique index the race stays open — that is what 0349 is for').toHaveLength(2);

    const again = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: TERIYAKI });
    expect(again.ok && again.already, 'the pair must answer "already saved"').toBe(true);
    expect(state.rows, 'the next tap must not become a third card').toHaveLength(2);
  });

  it('after 0349, the loser of two simultaneous saves is told it is already saved, not shown an error', async () => {
    const { state } = useVault(AFTER_0349);
    // Our probe finds nothing; the other parent's insert lands first.
    state.racer = savedCopy(TERIYAKI, 'Teriyaki Chicken');

    const result = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: TERIYAKI });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    expect(result.ok && result.already).toBe(true);
    expect(state.rows, 'the race must leave one card, not two').toHaveLength(1);
  });

  it('a collision with nothing behind it is still a failure — the 23505 branch cannot invent a save', async () => {
    const { state } = useVault(AFTER_0349);
    state.alwaysCollide = true; // 23505, but the re-probe finds no winner.

    const result = await saveDiscoveredRecipe({ provider: 'themealdb', sourceRecipeId: TERIYAKI });

    expect(result.ok, 'a duplicate-key error with no row behind it must be reported').toBe(false);
    expect(result.ok ? '' : result.error).toContain('duplicate key');
    expect(state.rows).toHaveLength(0);
  });
});

describe('0349 closes the race without breaking the AI variants', () => {
  const sql = readFileSync(MIGRATION, 'utf8');

  it('exempts exactly the provider the AI-variant route writes', () => {
    // If the route's provider string is ever changed and 0349 is not, the second
    // AI variant of every recipe starts failing with 23505. That is the reason
    // the predicate is read out of the migration rather than hard-coded above.
    const route = readFileSync(AI_VARIANT_ROUTE, 'utf8');
    const written = /source_provider:\s*'([^']+)'/.exec(route);
    expect(written, `${AI_VARIANT_ROUTE} must still stamp a source_provider`).not.toBeNull();
    expect(
      EXEMPT_PROVIDER,
      `0349 exempts '${EXEMPT_PROVIDER}' but ${AI_VARIANT_ROUTE} writes '${written![1]}' — ` +
        'the second AI variant of a recipe would be refused',
    ).toBe(written![1]);
  });

  it('is replay-safe: the index is dropped before it is created', () => {
    const drop = sql.toLowerCase().indexOf('drop index if exists public.uq_family_recipes_source');
    const create = sql.toLowerCase().indexOf('create unique index uq_family_recipes_source');
    expect(drop, '0349 must drop the index before creating it').toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(drop);
  });

  it('refuses to apply over existing duplicates instead of silently skipping', () => {
    // A pre-existing duplicate pair makes CREATE UNIQUE INDEX fail. The migration
    // must say WHOSE rows block it and stop — not swallow the failure, and not
    // delete rows that may already be a meal-vote option or a meal-plan slot.
    expect(sql).toMatch(/raise\s+exception/i);
    expect(sql).toMatch(/having\s+count\(\*\)\s*>\s*1/i);
  });

  it('touches no grant, role or policy', () => {
    const body = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n')
      .toLowerCase();
    for (const forbidden of ['grant ', 'revoke ', 'create policy', 'drop policy', 'alter role', 'disable row level security']) {
      expect(body, `0349 must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

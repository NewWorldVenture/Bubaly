// An allergy the family recorded in Family Memory must reach the shopping list
// and the meal planner's context, no matter how many facts the household has
// accumulated before it.
//
// THE DEFECT THIS PINS. Both `addFromMealPlan` (lib/services/groceries) and
// `foodProfile` (lib/services/meals) read `family_facts` with an unbounded
// `select()`. PostgREST answers such a read with at most `db-max-rows` — 1,000
// on a default Supabase project — and says nothing about it: no error, no
// short-read signal. So the fail-closed guard both reads sit behind, which
// branches on `error`, cannot fire. The allergy row simply is not in the
// response, `collectDietaryConstraints` never sees it, `applySubstitutions`
// leaves the allergen on the list, and the action returns `ok: true` with an
// empty `substitutions` array.
//
// What a family loses: the peanut butter goes on a shopping list the product
// told them was allergy-checked, and the planner is told the household has no
// allergies at all. That is the outcome asserted below — the allergen line and
// the "never serve" list, not the shape of the query.
//
// The fake's `maxRows` is the server's own ceiling, applied the same silent way.
// A small cap stands in for 1,000 so the test seeds a handful of rows rather
// than a thousand; the mechanism is identical, and `readAll` pages either way.
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { addFromMealPlan } from '@/lib/services/groceries';
import { foodProfile } from '@/lib/services/meals';
import type { ServiceScope } from '@/lib/services/types';

/** Stands in for PostgREST's `db-max-rows`. */
const CAP = 3;

/**
 * PostgREST's real default `db-max-rows`, for the cases that must push past the
 * services' 5,000-row ceiling. Walking 5,001 rows three at a time is ~1,700
 * sequential round trips through the fake — seconds of wall clock, close enough
 * to vitest's 5 s timeout to flake under a parallel suite. At the production
 * page size it is six, and the mechanism under test is the same.
 */
const PRODUCTION_CAP = 1000;

/** More `family_facts` rows than either service's ceiling (5,000) will walk. */
const PAST_THE_CEILING = 6000;

function scopeWith(db: SupabaseClient<Database>): ServiceScope {
  return {
    db,
    familyId: 'fam-1',
    userId: 'auth-user-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'member',
    tz: 'America/New_York',
    now: new Date('2026-09-05T12:00:00Z'),
  };
}

/**
 * A household whose `family_facts` rows outnumber one response: `cap` harmless
 * preference rows recorded first, and the allergy recorded after them. Ids sort
 * the allergy row last, so it falls past the cap under a paged read as well as
 * an unpaged one — only a read that actually walks to the end of the table
 * finds it.
 */
function householdWithTheAllergyPastTheCap(cap = CAP) {
  const db = createInMemorySupabase<SupabaseClient<Database>>({
    maxRows: cap,
    defaults: {
      grocery_lists: { is_archived: false, archived_at: null },
      grocery_items: { is_checked: false, quantity: null, category: null, source_meal_id: null },
    },
  });
  db.seed('grocery_lists', [{ id: 'list-1', family_id: 'fam-1' }]);
  db.seed('family_members', [
    { id: 'member-1', family_id: 'fam-1', display_name: 'Ada', is_active: true, created_at: '2026-01-01T00:00:00Z' },
  ]);
  db.seed('family_facts', [
    ...Array.from({ length: cap }, (_, i) => ({
      id: `fact-${String(i).padStart(4, '0')}`, family_id: 'fam-1', member_id: null,
      category: 'preference', label: 'Favourite dinner', value: 'pizza',
    })),
    // Recorded last, and the only row that matters.
    { id: 'zz-allergy', family_id: 'fam-1', member_id: 'member-1', category: 'medical', label: 'Allergy', value: 'peanut' },
  ]);
  return db;
}

afterEach(() => { vi.restoreAllMocks(); });

describe('the shopping list built from a meal plan', () => {
  it('leaves the allergen off even when the allergy row is past the row cap', async () => {
    const db = householdWithTheAllergyPastTheCap();
    db.seed('meal_plans', [{ family_id: 'fam-1', meal_id: 'satay', plan_date: '2026-09-07' }]);
    db.seed('meals', [{
      id: 'satay', family_id: 'fam-1', name: 'Chicken satay',
      ingredients: [{ name: 'peanut butter', qty: '1', unit: 'cup' }, { name: 'chicken thighs', qty: '2', unit: 'lb' }],
    }]);

    const result = await addFromMealPlan(scopeWith(db as unknown as SupabaseClient<Database>), {
      from: '2026-09-07', to: '2026-09-13', listId: 'list-1',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // What the family sees on the page: the swap was forced, with its reason.
    expect(result.data.substitutions).toEqual([expect.objectContaining({
      from: 'peanut butter', kind: 'allergy', trigger: 'peanut',
    })]);
    // And what actually landed in the list: no peanut butter, anywhere.
    const onTheList = db.table('grocery_items').map((row) => String(row.name).toLowerCase());
    expect(onTheList).not.toContain('peanut butter');
    expect(onTheList.some((name) => name.includes('peanut'))).toBe(false);
    // The dish's safe ingredient is still shopped for — the fix must not turn
    // a truncated read into an empty list.
    expect(onTheList).toContain('chicken thighs');
  });

  it('refuses rather than shopping blind when the allergy read cannot complete', async () => {
    // The ceiling is a real bound: past it the read is a PREFIX, and a prefix of
    // the family's allergies is exactly what must not be shopped against. The
    // fail-closed branch refuses, and the family is told why in a sentence — the
    // helper's "raise the max" diagnostic goes to the log, not to the page.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = householdWithTheAllergyPastTheCap(PRODUCTION_CAP);
    db.seed('family_facts', Array.from({ length: PAST_THE_CEILING }, (_, i) => ({
      id: `bulk-${String(i).padStart(5, '0')}`, family_id: 'fam-1', member_id: null,
      category: 'preference', label: 'Favourite dinner', value: 'pizza',
    })));
    db.seed('meal_plans', [{ family_id: 'fam-1', meal_id: 'satay', plan_date: '2026-09-07' }]);
    db.seed('meals', [{
      id: 'satay', family_id: 'fam-1', name: 'Chicken satay',
      ingredients: [{ name: 'peanut butter', qty: '1', unit: 'cup' }],
    }]);

    const result = await addFromMealPlan(scopeWith(db as unknown as SupabaseClient<Database>), {
      from: '2026-09-07', to: '2026-09-13', listId: 'list-1',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('Could not check the family’s allergies, so nothing was added to the list.');
    expect(db.table('grocery_items')).toHaveLength(0);
    // Not swallowed: the reason is logged where an operator can see it.
    expect(errorLog).toHaveBeenCalledWith(
      '[service:groceries] dietary constraint read failed',
      expect.objectContaining({ message: expect.stringContaining('PREFIX') }),
    );
  });
});

describe('the food profile the meal planner is given', () => {
  it('names an allergy recorded past the row cap in the household allergy list', async () => {
    const db = householdWithTheAllergyPastTheCap();
    // `foodProfile` reads only category 'preference', and classifies by text —
    // so the allergy is recorded the way the Family Memory UI records a
    // preference-category note, still past the cap.
    db.seed('family_facts', [{
      id: 'zz-pref-allergy', family_id: 'fam-1', member_id: 'member-1',
      category: 'preference', label: 'Peanut allergy', value: 'peanuts',
    }]);

    const result = await foodProfile(scopeWith(db as unknown as SupabaseClient<Database>));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The line the AI context slice renders as "ALLERGIES (never serve): …".
    expect(result.data.household.allergies).toContain('peanuts');
  });

  it('fails the read, in a sentence, rather than handing the planner a prefix', async () => {
    // Past the ceiling the planner must get no profile at all — an empty or
    // partial ALLERGIES line would read as "none recorded". The reader (a
    // parent, or the model through meals.foodProfile) gets the service's own
    // sentence, and the helper's diagnostic goes to the log.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = householdWithTheAllergyPastTheCap(PRODUCTION_CAP);
    db.seed('family_facts', Array.from({ length: PAST_THE_CEILING }, (_, i) => ({
      id: `bulk-${String(i).padStart(5, '0')}`, family_id: 'fam-1', member_id: null,
      category: 'preference', label: 'Favourite dinner', value: 'pizza',
    })));

    const result = await foodProfile(scopeWith(db as unknown as SupabaseClient<Database>));

    expect(result).toEqual({ ok: false, error: 'Could not read the family food preferences.', code: 'db' });
    expect(errorLog).toHaveBeenCalledWith(
      '[service:meals] food profile read failed',
      expect.objectContaining({ message: expect.stringContaining('PREFIX') }),
    );
  });
});

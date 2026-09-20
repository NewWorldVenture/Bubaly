import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, bodyOf } from './helpers/source-order';

/**
 * Line comments only — enough to stop an assertion matching the prose that
 * explains the very thing it forbids, without pulling in a parser.
 */
function stripComments(source: string): string {
  return source.replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Audit C1-S9-25 — two AI routes that answered a family's question at HTTP 200
 * from reads that had not happened.
 *
 * Reported by a parallel worker sweeping the API surface, then re-verified in
 * source before either was touched.
 */
const savings = readFileSync('app/api/ai/savings/route.ts', 'utf8');
const habits = readFileSync('app/api/ai/habits/route.ts', 'utf8');

describe('the savings route does not answer "On track" from a failed read (C1-S9-25)', () => {
  it('checks all four finance reads and refuses rather than reassures', () => {
    // Its own docstring says it "never fabricates numbers" — and it did: a
    // refused `transactions` read emptied the category map, produced no
    // overspending, and reached the deterministic "On track" fallback at 200.
    expect(savings).toContain('const readFailures = (');
    for (const label of ['transactions', 'budgets', 'bills', 'subscriptions']) {
      expect(savings, `${label} must be named in the failure list`).toContain(`['${label}',`);
    }
    expect(savings).toContain('{ status: 503 }');
    // The bail must precede the work it invalidates: the category map, the
    // model context, and the fallback.
    expect(at(savings, 'if (readFailures.length > 0)')).toBeLessThan(at(savings, 'const byCat'));
    expect(at(savings, 'if (readFailures.length > 0)')).toBeLessThan(at(savings, "title: 'On track'"));
  });

  it('bounds the transactions read for real, not with .limit()', () => {
    // `.limit(N)` is not a bound — PostgREST caps at db-max-rows regardless —
    // so an understated over-budget figure would still be stated as fact.
    const read = bodyOf(savings, 'const [txnsResult', ']);');
    expect(read).toContain('readAllAsQuery');
    expect(read).toContain('{ max: 20_000 }');
    expect(read).not.toMatch(/from\('transactions'\)[\s\S]{0,200}?\.limit\(/);
  });
});

describe('the habits route does not compute streaks from a prefix (C1-S9-25)', () => {
  it('checks both reads, including readAll\'s truncation signal', () => {
    // readAll sets `error` for a failed page AND for exceeding `max`, handing
    // back partial rows either way. Dropping it meant "current streak 0" to
    // someone who had not missed a day.
    expect(habits).toMatch(/const \{ rows: logs, error: logsError \}/);
    expect(habits).toMatch(/const \{ data: habits, error: habitsError \}/);
    expect(habits).toContain('if (habitsError || logsError)');
    expect(habits).toContain('{ status: 503 }');
    // Before the streak maths, not after it.
    expect(at(habits, 'if (habitsError || logsError)')).toBeLessThan(at(habits, 'const logsByHabit'));
  });

  it('keeps the real ceiling the earlier fix installed', () => {
    // The `.limit(5000)` that was never 5,000 must not come back.
    expect(habits).toContain('{ max: 5000 }');
    expect(habits).not.toMatch(/from\('habit_logs'\)[\s\S]{0,200}?\.limit\(/);
  });
});

/**
 * Audit C1-S9-37 — the rest of the class, from a sweep of all 146 API routes.
 *
 * The scan looked for `const { data } = await ...` (the error dropped) whose
 * binding then reaches a `?? []` / `?? 0` fallback. Four survived, all of them
 * AI routes, and the sweep is recorded as a bound rather than a sample: 146
 * routes scanned, 46 data-only destructures, 4 with an empty-value fallback.
 */
const nutrition = readFileSync('app/api/ai/meals/nutrition/route.ts', 'utf8');
const relationship = readFileSync('app/api/ai/relationship/route.ts', 'utf8');
const journal = readFileSync('app/api/ai/journal/route.ts', 'utf8');
const utility = readFileSync('app/api/ai/home/utility-savings/route.ts', 'utf8');

describe('nutrition is not estimated for meals the route could not name (C1-S9-37)', () => {
  it('both week reads refuse rather than guess', () => {
    expect(nutrition).toContain('if (plansResult.error)');
    expect(nutrition).toContain('if (mealsResult.error)');
    // Scoped, not counted file-wide: this route already had two unrelated 503s
    // (AI unconfigured, and a provider failure), so a raw count asserts nothing.
    for (const guard of ['if (plansResult.error)', 'if (mealsResult.error)']) {
      // `bodyOf` asserts the end token appears AFTER the guard, so reaching the
      // 503 from each guard is the assertion; `'}'` alone would have stopped at
      // the console.error object's own closing brace.
      const bail = bodyOf(nutrition, guard, '{ status: 503 });');
      expect(bail, guard).toContain('ai.recommendationsAreTemporarilyUnavailable');
    }
    // Before the prompt is built, not after.
    expect(at(nutrition, 'if (mealsResult.error)')).toBeLessThan(at(nutrition, 'Estimate the AVERAGE PER DAY'));
  });

  it('the filter that only looked like a filter is gone', () => {
    // `.filter((l) => l.label !== 'meal' || true)` is unconditionally true. It
    // kept every line while reading as though it dropped the unresolved ones, so
    // a failed `meals` read sent twenty-one lines of "- <date> dinner: meal" to
    // the model and got back per-day macros for a week it had never seen.
    // Asserted against the code with comments stripped: the explanatory comment
    // below QUOTES the old expression, and a file-wide `not.toContain` matched
    // its own documentation. Same trap as C1-S9-34, from the other direction —
    // there a comment kept a guard green, here it turned one red.
    const code = stripComments(nutrition);
    expect(code).not.toContain('|| true');
    expect(code).not.toContain("?? 'meal'");
    // And the intent it described is now actually implemented.
    expect(nutrition).toContain('return label ? [{ label, date: p.plan_date, meal_type: p.meal_type }] : [];');
  });

  it('"not found" means the database answered, for the recipe and the meal', () => {
    // These two were missed by the first sweep, whose heuristic required a
    // `?? []` fallback within twelve lines. They have none: a refused read left
    // the binding null and fell straight into a 404, telling a family their own
    // recipe does not exist. 404 is a statement about their data.
    for (const guard of ['if (recipeError)', 'if (mealError)']) {
      expect(nutrition, guard).toContain(guard);
      expect(bodyOf(nutrition, guard, '{ status: 503 });'), guard)
        .toContain('ai.recommendationsAreTemporarilyUnavailable');
    }
    // And the genuine 404s are kept, because they are right for a real absence.
    expect(nutrition).toContain("t('nutrition.recipeNotFound')");
    expect(nutrition).toContain("t('nutrition.mealNotFound')");
    expect(at(nutrition, 'if (recipeError)')).toBeLessThan(at(nutrition, "t('nutrition.recipeNotFound')"));
    expect(at(nutrition, 'if (mealError)')).toBeLessThan(at(nutrition, "t('nutrition.mealNotFound')"));
  });

  it('the cache read degrades deliberately rather than silently', () => {
    // The one read here where continuing is correct — the recomputed answer is
    // right, it just costs a model call. Recorded so the decision is visible.
    expect(nutrition).toContain('if (cacheError)');
    expect(bodyOf(nutrition, 'if (cacheError)', '});')).toContain('console.warn');
    expect(nutrition).not.toMatch(/if \(cacheError\)[\s\S]{0,200}?status: 50/);
  });

  it('an unnameable week is refused, not fabricated', () => {
    // The pre-existing 422 is the truthful answer when nothing can be named.
    expect(nutrition).toMatch(/if \(lines\.length === 0\)[\s\S]{0,160}?status: 422/);
  });
});

describe('a relationship digest is not built on reads that failed (C1-S9-37)', () => {
  it('the dates guard is no longer inverted with respect to risk', () => {
    // It caught `isMissingRelationError` — "this feature is not installed yet" —
    // and let every REAL error through to `dateRows ?? []`. A helper whose whole
    // job is not forgetting the anniversary then reported ninety clear days.
    expect(relationship).toContain('if (datesErr || profileErr)');
    expect(at(relationship, 'if (datesErr || profileErr)')).toBeLessThan(at(relationship, 'const dates: RelDate[]'));
    // The missing-relation branch is KEPT: it is a different answer, and it was
    // right about the case it covered.
    expect(relationship).toContain('if (datesErr && isMissingRelationError(datesErr))');
  });

  it('the profile behind every personal detail is checked', () => {
    expect(relationship).toContain('error: profileErr');
  });

  it('the wishlist that grounds the gift suggestions is checked', () => {
    const block = bodyOf(relationship, "const { data: items, error: itemsError }", '{ status: 503 });');
    expect(block).toContain('if (itemsError)');
    // Against the CALL, not the import at the top of the file, which is what a
    // bare `at()` on the symbol finds.
    expect(at(relationship, 'if (itemsError)')).toBeLessThan(at(relationship, 'buildRelationshipDigestPrompt({'));
  });
});

describe('a journal prompt is honest about being generic (C1-S9-37)', () => {
  it('a failed read takes the evergreen path rather than posing as personal', () => {
    // An empty list is also what a brand-new journal produces, so the route
    // returned a generic prompt labelled `source: 'ai'`. The evergreen fallback
    // already existed for this and says what it is.
    expect(journal).toContain('if (recentError)');
    // Anchored to the block's OWN closing brace. A `bodyOf(..., "source:
    // 'evergreen' });")` slice passed while the bail returned something else
    // entirely, because `bodyOf` searches forward and found the route's other,
    // pre-existing evergreen return further down — the empty-slice hazard's
    // sibling: a slice that is too LONG rather than too short.
    expect(journal).toMatch(
      /if \(recentError\) \{[\s\S]{0,300}?return NextResponse\.json\(\{ prompt: promptOfTheDay\(\), source: 'evergreen' \}\);\s*\}/,
    );
    expect(at(journal, 'if (recentError)')).toBeLessThan(at(journal, 'const snippets'));
  });
});

describe('utility savings does not ask for bills it failed to read (C1-S9-37)', () => {
  it('a refused read is not "add a few utility bills"', () => {
    expect(utility).toContain('if (billsError)');
    expect(utility).toContain('{ status: 503 }');
    // The empty-bills 400 is kept — it is correct for a family with no bills.
    expect(utility).toContain("t('utilitySavings.addAFewUtilityBills')");
    expect(at(utility, 'if (billsError)')).toBeLessThan(at(utility, "t('utilitySavings.addAFewUtilityBills')"));
  });
});

describe('the sweep that found these leaves nothing behind (C1-S9-37)', () => {
  it('no AI route still drops a read error into an empty-value fallback', () => {
    for (const [name, source] of [
      ['nutrition', nutrition], ['relationship', relationship],
      ['journal', journal], ['utility-savings', utility],
    ] as const) {
      // The exact shape the scan matched: only `data` destructured off an await.
      const dropped = stripComments(source).match(/const \{ data(?:: \w+)? \} = await/g) ?? [];
      expect(dropped, `${name} still has a read with its error dropped`).toHaveLength(0);
    }
  });
});

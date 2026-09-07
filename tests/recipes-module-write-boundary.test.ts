import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// A-10 — the Recipes module previously fired three Supabase writes and dropped
// their `error`: toggleFavorite, markMade, and deleteRecipe. markMade even
// toasted "Marked as made today!" and deleteRecipe closed the recipe viewer as
// if the row were gone — both while the write may have failed (RLS denial,
// offline, constraint). Every write must capture `error` and surface it via
// toastError(describeDbError(error)) before claiming success, like the sibling
// addItemsToList / addToGrocery paths already do.
const src = readFileSync('components/modules/recipes-module.tsx', 'utf8');

function body(fn: string): string {
  // Grab from `async function <fn>(` to the next top-level `async function` (or EOF).
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

describe('recipes-module write boundaries fail visibly', () => {
  for (const fn of ['toggleFavorite', 'markMade', 'deleteRecipe']) {
    it(`${fn} captures the Supabase error and toasts it`, () => {
      const b = body(fn);
      expect(b, `${fn} must destructure { error }`).toMatch(/const \{ error \} = await/);
      expect(b, `${fn} must guard on error`).toContain('if (error) return toastError(describeDbError(error))');
    });
  }

  it('markMade only claims success after the error guard', () => {
    const b = body('markMade');
    const guard = b.indexOf('if (error) return toastError');
    const claim = b.indexOf("success(tr('recipesModule.markedAsMadeToday')");
    expect(guard).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(guard);
  });

  it('deleteRecipe only closes the viewer after the error guard', () => {
    const b = body('deleteRecipe');
    const guard = b.indexOf('if (error) return toastError');
    const close = b.indexOf('setViewing(null)');
    expect(guard).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(guard);
  });
});

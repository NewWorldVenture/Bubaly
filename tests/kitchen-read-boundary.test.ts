import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/kitchen/page.tsx', 'utf8');

// PLA-0773: the Smart Kitchen page must fail closed on its source-of-truth
// reads. This week's meal plan, pantry, recipes, and open grocery items feed
// the food score and the "tonight / pantry / grocery" surfaces — a dropped
// error would render an empty kitchen that lies ("no meals planned", "pantry
// empty"). The newer optional tables (leftover_inventory, meal_nutrition) stay
// best-effort via isMissingTableError, and a genuinely missing core table
// (unapplied migration) is still tolerated as empty.
describe('kitchen page read boundary', () => {
  it('collects the four core read errors, filtering missing-table', () => {
    expect(page).toContain('const coreError = [planRes.error, pantryRes.error, recipesRes.error, groceryRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a core read failure', () => {
    expect(page).toContain("console.error('[dashboard/kitchen] kitchen read failed', coreError);");
    expect(page).toContain('return <ErrorState message="Could not load your kitchen from Supabase. Refresh and try again." />;');
  });

  it('keeps the optional leftover/nutrition reads best-effort', () => {
    // These newer tables intentionally degrade to empty on a missing-table
    // error and must NOT be part of the fail-closed core set.
    expect(page).toContain('const leftoversMissing = isMissingTableError(leftoverRes.error);');
    expect(page).toContain('if (!isMissingTableError(nutritionRes.error) && nutritionRes.data');
  });
});

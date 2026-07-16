import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeDegradeRead } from '@/lib/meals/degrade-read';

// A-10 (Food & Nutrition hub) read boundary. The hub fans out many independent
// reads and renders a card per source; one failing/not-yet-migrated table must
// degrade THAT card to empty, but the failure must be LOGGED (not swallowed) so
// a partial outage on prod is diagnosable instead of a healthy-looking empty page.

describe('makeDegradeRead — degrade-but-log', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes success data + count through unchanged', async () => {
    const safe = makeDegradeRead('food');
    const r = await safe('recipes', Promise.resolve({ data: [{ id: '1' }], error: null, count: 7 }));
    expect(r).toEqual({ data: [{ id: '1' }], count: 7 });
  });

  it('degrades AND logs when the query resolves with an error field (RLS / missing table)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const safe = makeDegradeRead('food');
    const r = await safe('dining_out', Promise.resolve({ data: null, error: { message: 'relation "dining_out" does not exist' }, count: null }));
    expect(r).toEqual({ data: null, count: null });
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toContain('[food] dining_out read failed');
    expect(err.mock.calls[0][1]).toMatchObject({ message: expect.stringContaining('dining_out') });
  });

  it('degrades AND logs when the query throws (transient outage)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const safe = makeDegradeRead('food');
    const r = await safe('pantry_items', Promise.reject(new Error('ECONNRESET')));
    expect(r).toEqual({ data: null, count: null });
    expect(err).toHaveBeenCalledTimes(1);
    expect(err.mock.calls[0][0]).toContain('[food] pantry_items read threw');
  });

  it('namespaces the log under the given namespace', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const safe = makeDegradeRead('meals');
    await safe('planner', Promise.resolve({ data: null, error: { message: 'boom' }, count: null }));
    expect(err.mock.calls[0][0]).toContain('[meals] planner read failed');
  });
});

describe('food/page.tsx wiring (guards the fix against regression)', () => {
  const page = readFileSync('app/(app)/dashboard/food/page.tsx', 'utf8');

  it('uses the logging degrade-read helper (not a silent try/catch)', () => {
    expect(page).toContain("makeDegradeRead('food')");
    // The old silent wrapper (catch returns null with no log) must be gone.
    expect(page).not.toContain('catch { return { data: null, count: null }; }');
  });

  it('labels every degrade-read call so a failure names its source', () => {
    for (const label of ['meal_plans', 'recipes', 'grocery_items', 'pantry_items', 'favorites', 'food_scores', 'dining_out', 'meals']) {
      expect(page).toContain(`safe('${label}',`);
    }
  });
});

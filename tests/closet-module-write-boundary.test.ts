import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Every Supabase write in the Closet module must capture `{ error }` and surface
// it through toastError(describeDbError(error)) — a failed insert/update/delete
// (RLS denial, offline) must never look like a successful click.
const src = readFileSync('components/modules/closet-module.tsx', 'utf8');

function body(fn: string): string {
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

describe('closet-module writes fail visibly', () => {
  for (const fn of ['logWear', 'saveSuggestionAsOutfit', 'setItemStatus', 'deleteItem', 'toggleFavorite', 'deleteOutfit', 'onSubmit', 'uploadPhoto']) {
    it(`${fn} guards its Supabase result`, () => {
      const b = body(fn);
      expect(b, `${fn} must destructure an error`).toMatch(/(const \{ error \} =|const \{ data: stored, error: upErr \} =|results\.find\(\(r\) => r\.error\))/);
      expect(b, `${fn} must toast the failure`).toMatch(/toastError\(describeDbError\((error|upErr|failed\.error)\)\)/);
    });
  }

  it('logs a wear before bumping wear counts, and reports a failed bump', () => {
    const b = body('logWear');
    expect(b.indexOf("from('outfit_logs').insert(")).toBeLessThan(b.indexOf("from('wardrobe_items').update("));
    expect(b).toContain('const failed = results.find((r) => r.error);');
  });

  it('never fetches weather from the browser except through the CSP-allowed helper', () => {
    expect(src).toContain("from '@/lib/weather/open-meteo'");
    expect(src).not.toMatch(/fetch\(['"`]https?:/);
  });
});

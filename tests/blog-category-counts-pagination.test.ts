import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression guard for the "Recipes & Food (0)" tab-count bug: the category tab
// counts (getCategoryCounts) and the All grid (getAllPosts) fetch published rows
// then filter synthetic seed rows CLIENT-SIDE (the seed marker is in the slug,
// not a column). PostgREST caps a single query at 1000 rows, so when seed rows
// fill the first 1000, whole categories of real articles fall outside the window
// and count as 0. The fix paginates via `.range()` so every real article is seen.
const SRC = readFileSync(join(__dirname, '..', 'lib/blog/posts.ts'), 'utf8');

function body(fn: string): string {
  const start = SRC.indexOf(`export async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = SRC.indexOf('\nexport async function ', start + 1);
  return SRC.slice(start, after === -1 ? undefined : after);
}

describe('blog counts/list paginate past the 1000-row cap', () => {
  it('has a paginating helper that loops with .range() until a short page', () => {
    const helper = SRC.slice(SRC.indexOf('async function fetchAllPublishedRows'));
    expect(helper).toContain('.range(from, from + PAGE - 1)');
    expect(helper).toMatch(/rows\.length < PAGE/);
  });

  for (const fn of ['getCategoryCounts', 'getAllPosts']) {
    it(`${fn} fetches through the paginating helper (not a single capped query)`, () => {
      const b = body(fn);
      expect(b).toContain('fetchAllPublishedRows');
      // Must NOT do a bare single .select().eq('published', true) without range.
      expect(b).not.toMatch(/\.select\('slug, category'\)\s*\.eq\('published', true\);/);
    });
  }
});

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
  it('reads through the shared paged reader, applying the range it is handed', () => {
    const helper = SRC.slice(
      SRC.indexOf('async function fetchAllPublishedRows'),
      SRC.indexOf('export async function getAllPosts('),
    );
    // The loop itself lives in lib/supabase/read-all.ts, which is pinned
    // behaviourally by tests/supabase-read-all.test.ts — including that it
    // resumes from the rows RECEIVED, so a server capping a page below the
    // requested range cannot silently end the read. What matters here is that
    // this helper goes through it and applies the range it is given, rather
    // than issuing one query PostgREST will cap at 1,000 rows.
    expect(helper).toContain('readAll');
    expect(helper).toMatch(/\.range\(from, to\)/);
    expect(SRC).toMatch(/import \{ readAll \} from '@\/lib\/supabase\/read-all'/);
  });

  it('orders by a key no two rows can share, so pages cannot overlap or skip', () => {
    // `published_at` alone is not a total order — 717 of the 1,049 published
    // rows share a date with another row — and two pages are two separately
    // planned queries, so a tied boundary can repeat one row and drop another.
    const helper = SRC.slice(
      SRC.indexOf('async function fetchAllPublishedRows'),
      SRC.indexOf('export async function getAllPosts('),
    );
    expect(helper).toMatch(/\.order\('published_at'[^)]*\)\s*\n?\s*\.order\('slug'\)/);
  });

  for (const fn of ['getCategoryCounts', 'getAllPosts', 'getAllPostRefs']) {
    it(`${fn} fetches through the paginating helper (not a single capped query)`, () => {
      const b = body(fn);
      expect(b).toContain('fetchAllPublishedRows');
      // Must NOT do a bare single .select().eq('published', true) without range.
      expect(b).not.toMatch(/\.select\('slug, category'\)\s*\.eq\('published', true\);/);
    });
  }
});

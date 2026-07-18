import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const posts = readFileSync(join(ROOT, 'lib/blog/posts.ts'), 'utf8');
const page = readFileSync(join(ROOT, 'app/(marketing)/blog/page.tsx'), 'utf8');

describe('blog performance', () => {
  it('list queries project card columns (no heavy body) — only getPost fetches *', () => {
    expect(posts).toMatch(/const CARD_COLUMNS\s*=/);
    // exactly one select('*') remains — the single-article fetch
    expect((posts.match(/\.select\('\*'\)/g) ?? []).length).toBe(1);
    // getAllPosts + the category/featured/related/adjacent lists use the projection
    expect((posts.match(/\.select\(CARD_COLUMNS\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(posts).toMatch(/fetchAllPublishedRows<keyof Row>\(CARD_COLUMNS\)/);
  });

  it('the grid is paginated instead of rendering every card at once', () => {
    expect(page).toMatch(/const PAGE_SIZE = \d+/);
    expect(page).toMatch(/gridSource\.slice\(\(currentPage - 1\) \* PAGE_SIZE/);
    expect(page).toMatch(/Blog pagination/);
  });

  it('trims the client search-index payload', () => {
    expect(page).toMatch(/excerpt: p\.excerpt\.slice\(0, \d+\)/);
  });
});

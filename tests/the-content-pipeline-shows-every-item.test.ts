import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTENT_PAGE_SIZE, contentPage } from '@/lib/marketing/content-page';

// ADMIN-CONTENT-001. The admin content pipeline read every item in one query.
// PostgREST answers at most 1,000 rows, so with 1,050 items the page rendered
// exactly 1,000 cards, and a new idea without a publish date (which sorts last)
// was saved and never shown. Found by the workflow audit on a local stack.
describe('the content pipeline pages through every item', () => {
  it('reads a bounded page with a count, not the whole table', () => {
    const src = readFileSync('app/(app)/admin/marketing/content/page.tsx', 'utf8');
    const read = src.slice(src.indexOf("from('marketing_content_items')"), src.indexOf("from('blog_posts')"));
    expect(read).toContain("count: 'exact'");
    expect(read).toMatch(/\.range\(from, to\)/);
  });

  it('sends a page past the end to the last page instead of calling the pipeline empty', () => {
    const src = readFileSync('app/(app)/admin/marketing/content/page.tsx', 'utf8');
    expect(src).toMatch(/if \(requested > pages\) redirect\(/);
  });

  it('reaches the 1,050th item', () => {
    const { pages } = contentPage('1', 1050);
    expect(pages).toBe(Math.ceil(1050 / CONTENT_PAGE_SIZE));
    const last = contentPage(String(pages), 1050);
    expect(last.from).toBeLessThanOrEqual(1049);
    expect(last.to).toBeGreaterThanOrEqual(1049);
  });

  it('treats a missing or nonsense page as the first', () => {
    for (const raw of [undefined, '0', '-3', 'abc', '']) expect(contentPage(raw, 10).page).toBe(1);
    expect(contentPage('2.7', 500).page).toBe(2);
  });
});

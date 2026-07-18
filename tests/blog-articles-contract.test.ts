import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHashtag, articleHashtags } from '../lib/blog/engagement';
import { ALL_CATEGORIES } from '../lib/blog/posts';

const ROOT = join(__dirname, '..');
const MIGRATION = readFileSync(join(ROOT, 'supabase/migrations/0226_blog_500_articles.sql'), 'utf8');

// The VALUES block: each row is a single line beginning with `('slug', ...`.
const rows = MIGRATION.split('\n').filter((l) => /^\('[a-z0-9-]+',/.test(l));

describe('0226 blog seed — 500+ unique, on-brand articles', () => {
  it('inserts at least 500 articles', () => {
    expect(rows.length).toBeGreaterThanOrEqual(500);
  });

  it('has unique, valid, non-synthetic slugs', () => {
    const slugs = rows.map((r) => r.match(/^\('([a-z0-9-]+)'/)![1]);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) {
      expect(s).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(s.length).toBeGreaterThanOrEqual(3);
      expect(s.length).toBeLessThanOrEqual(120);
      // must NOT match the synthetic-seed pattern that lib/blog/posts hides
      expect(/^seed-blog_posts-\d+$/i.test(s)).toBe(false);
    }
  });

  it('tags every article with #bubaly', () => {
    const withBubaly = rows.filter((r) => /ARRAY\[[^\]]*'#bubaly'[^\]]*\]/.test(r));
    expect(withBubaly.length).toBe(rows.length);
  });

  it('gives every article multiple hashtags', () => {
    for (const r of rows) {
      const arr = r.match(/ARRAY\[([^\]]*)\]::text\[\]/)![1];
      const tags = arr.match(/'#[^']+'/g) ?? [];
      expect(tags.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('gives every article a free Unsplash hero photo', () => {
    const withImg = rows.filter((r) => /images\.unsplash\.com\/photo-/.test(r) && /'Unsplash'/.test(r));
    expect(withImg.length).toBe(rows.length);
  });

  it('places every article under a known category tab', () => {
    const allowed = new Set(ALL_CATEGORIES as readonly string[]);
    for (const r of rows) {
      const cat = r.match(/, '([^']+)', false,/)![1];
      expect(allowed.has(cat)).toBe(true);
    }
  });

  it('references bubaly.com back in every article body', () => {
    // Each row carries its body in a $json$...$json$ block.
    const missing = rows.filter((r) => !/bubaly\.com/i.test(r));
    expect(missing).toEqual([]);
  });

  it('is idempotent (ON CONFLICT ... DO UPDATE)', () => {
    expect(MIGRATION).toMatch(/ON CONFLICT \(slug\) DO UPDATE/);
  });
});

describe('hashtag helpers', () => {
  it('normalizes a tag into a hashtag', () => {
    expect(toHashtag('Family Finances')).toBe('#familyfinances');
    expect(toHashtag('#bubaly')).toBe('#bubaly');
    expect(toHashtag('  screen time!  ')).toBe('#screentime');
    expect(toHashtag('###')).toBe('');
  });

  it('always includes #bubaly and dedupes', () => {
    const tags = articleHashtags(['#bubaly', 'parenting', 'parenting', 'sleep']);
    expect(tags[0]).toBe('#bubaly');
    expect(tags).toContain('#familylife');
    expect(tags).toContain('#parenting');
    // no dupes
    expect(new Set(tags).size).toBe(tags.length);
  });

  it('handles legacy plain tags and empty input', () => {
    expect(articleHashtags(['ai', 'product'])).toEqual(['#bubaly', '#familylife', '#ai', '#product']);
    expect(articleHashtags(null)).toEqual(['#bubaly', '#familylife']);
  });
});

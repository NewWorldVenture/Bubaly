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

  // These two assertions used to require the OPPOSITE: that every row carried a
  // loremflickr.com hero credited 'LoremFlickr (CC)', described as "a free hero
  // photo". It is not free — it is a proxy serving MIXED-license Flickr photos,
  // which is why `0231` nulls every one of them out, `next.config.mjs` dropped
  // the host, and `0238` installs a trigger that REFUSES a hero whose licence it
  // cannot identify. The seed and the product disagreed, and the seed only
  // survived because a from-scratch replay inserts the rows before the trigger
  // exists. Replayed against a database that already has the schema — which is
  // what repairing production's ledger does — the trigger rejected all 525 and
  // the repair stopped dead (F-020). The rows are now seeded NULL, reaching the
  // same end state `0231` produced anyway.
  it('seeds NO hero image with an unverified licence', () => {
    expect(MIGRATION).not.toMatch(/'https:\/\/loremflickr\.com/);
    expect(MIGRATION).not.toMatch(/'LoremFlickr \(CC\)'/);
    const withHero = rows.filter((r) => /'https?:\/\//.test(r));
    expect(withHero).toEqual([]);
  });

  it('leaves the hero triple NULL so the licence trigger accepts a replay', () => {
    // (hero_image_url, hero_image_alt, hero_image_credit) — all three, every row.
    const nulled = rows.filter((r) => r.includes('NULL, NULL, NULL,'));
    expect(nulled.length).toBe(rows.length);
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const b1 = readFileSync(join(ROOT, 'supabase/migrations/0226_blog_500_articles.sql'), 'utf8');
const b2 = readFileSync(join(ROOT, 'supabase/migrations/0234_blog_500_more_articles.sql'), 'utf8');

const rows = (sql: string) => sql.split('\n').filter((l) => /^\('[a-z0-9-]+',/.test(l));
const slugs = (sql: string) => rows(sql).map((r) => r.match(/^\('([a-z0-9-]+)'/)![1]);

describe('0232 blog batch 2 — 500 more unique, wired articles', () => {
  it('adds ~500 new articles', () => {
    expect(rows(b2).length).toBeGreaterThanOrEqual(500);
  });

  it('never reuses a batch-1 slug (no duplicate topics)', () => {
    const s1 = new Set(slugs(b1));
    const overlap = slugs(b2).filter((s) => s1.has(s));
    expect(overlap).toEqual([]);
    // and internally unique
    const s2 = slugs(b2);
    expect(new Set(s2).size).toBe(s2.length);
  });

  it('stores NO LoremFlickr / unverified-license image URLs (renders BlogCover)', () => {
    expect(b2).not.toMatch(/loremflickr/i);
    // every row ends its hero columns with `null, null, null`
    const withNullHero = rows(b2).filter((r) => /, null, null, null, \$json\$/.test(r));
    expect(withNullHero.length).toBe(rows(b2).length);
  });

  it('never overwrites an existing post', () => {
    expect(b2).toMatch(/ON CONFLICT \(slug\) DO NOTHING/);
  });

  it('self-wires into the content registry + per-post AEO (closed loop)', () => {
    expect(b2).toMatch(/INSERT INTO public\.marketing_content_items/);
    expect(b2).toMatch(/INSERT INTO public\.marketing_aeo_questions/);
    expect(b2).toMatch(/seed','blog_aeo_v1'/);
  });

  it('tags every article with #bubaly + multiple hashtags', () => {
    for (const r of rows(b2)) {
      const arr = r.match(/ARRAY\[([^\]]*)\]::text\[\]/)![1];
      expect(arr).toMatch(/'#bubaly'/);
      expect((arr.match(/'#[^']+'/g) ?? []).length).toBeGreaterThanOrEqual(3);
    }
  });
});

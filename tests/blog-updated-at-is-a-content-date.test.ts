import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// blog_posts.updated_at answers "when did this writing last change?" — the
// claim /sitemap.xml publishes as lastmod, and the article publishes as
// dateModified. Production had one answer for all 1,048 posts
// (2026-07-18T18:05:07.518Z, a single migration's transaction timestamp), so
// the column was reporting an import, not an edit.

const migration = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/0286_blog_updated_at_is_a_content_date.sql'),
  'utf8',
);

describe('the updated_at backfill', () => {
  it('suspends the trigger that would overwrite its own correction', () => {
    // trg_blog_posts_updated_at is an unconditional BEFORE UPDATE setting
    // updated_at = now(). Without this, the migration stamps every corrected
    // row with the migration's own timestamp — the exact defect it repairs.
    expect(migration).toContain('disable trigger trg_blog_posts_updated_at');
    expect(migration).toContain('enable trigger trg_blog_posts_updated_at');
    expect(migration.indexOf('disable trigger')).toBeLessThan(migration.indexOf('update public.blog_posts'));
    expect(migration.indexOf('update public.blog_posts')).toBeLessThan(migration.indexOf('enable trigger'));
  });

  it('corrects only rows a bulk statement stamped, never a hand edit', () => {
    // A person's edit produces its own timestamp, shared with nothing, and
    // fails the batch test. Only a stamp shared by a hundred rows, later than
    // the post was published, is an import rather than an edit.
    expect(migration).toContain('p.published_at < p.updated_at::date');
    expect(migration).toMatch(/count\(\*\)\s*from public\.blog_posts q where q\.updated_at = p\.updated_at\s*\)\s*>= 100/);
  });

  it('reads the publication date as UTC, not as the server timezone', () => {
    // published_at is a `date`; casting without an explicit zone yields
    // midnight wherever the server happens to live, which is the classic
    // off-by-one-day across timezones.
    expect(migration).toContain("published_at::timestamp at time zone 'UTC'");
  });

  it('leaves trg_blog_image_provenance alone', () => {
    // The image-provenance trigger is named only in a comment saying it stays
    // armed; nothing may disable it, and nothing may disable the lot.
    expect(migration).not.toMatch(/disable trigger (all|user)\b/i);
    expect(migration).not.toMatch(/disable trigger trg_blog_image_provenance/i);
  });
});

describe('a post advertises when its writing changed', () => {
  it('reports dateModified and modifiedTime from updated_at, not the publish date', () => {
    // The same claim the sitemap makes, answered from the same column — an
    // article whose JSON-LD and sitemap entry disagree is worse than either.
    const schema = fs.readFileSync(path.join(process.cwd(), 'components/marketing/structured-data.tsx'), 'utf8');
    const page = fs.readFileSync(path.join(process.cwd(), 'app/(marketing)/blog/[slug]/page.tsx'), 'utf8');
    expect(schema).toContain('dateModified: post.updatedAt ?? post.date');
    expect(page).toContain('modifiedTime: post.updatedAt ?? post.date');
    // …and the page actually passes it down, or the fallback is all there is.
    expect(page).toContain('updatedAt={post.updatedAt}');
  });
});

import { describe, expect, it } from 'vitest';
import { isSyntheticBlogSeedSlug, normalizeBody } from '@/lib/blog/posts';

describe('public blog publication boundary', () => {
  it('recognizes only the generated production seed slug formats', () => {
    expect(isSyntheticBlogSeedSlug('seed-blog_posts-364')).toBe(true);
    expect(isSyntheticBlogSeedSlug('Seed 63511fed-a26f-499a-ab1e-2443b02d2766')).toBe(true);
    expect(isSyntheticBlogSeedSlug('Seed data 1 8c697813-04e9-49e2-a88d-ff7d15f0983f')).toBe(true);
    expect(isSyntheticBlogSeedSlug('seed-blog-posts-writing-guide')).toBe(false);
    expect(isSyntheticBlogSeedSlug('seed-blog_posts-writing-guide')).toBe(false);
    expect(isSyntheticBlogSeedSlug('a-real-family-story')).toBe(false);
  });

  it('rejects metadata objects as article body content', () => {
    expect(normalizeBody({ row: 364, table: 'blog_posts', seeded: true })).toEqual([]);
  });
});

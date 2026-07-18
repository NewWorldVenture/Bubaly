import { describe, expect, it } from 'vitest';
import {
  normalizeCategory,
  blogSlugify,
  contentBodyToBlocks,
  estimateReadingMinutes,
  deriveExcerpt,
  buildBlogPost,
  BLOG_CATEGORIES,
} from '@/lib/marketing/blog-publish';
import { ALL_CATEGORIES } from '@/lib/blog/posts';

describe('admin/public blog category contract', () => {
  it('keeps the admin category picker aligned with every public category', () => {
    expect(BLOG_CATEGORIES).toEqual(expect.arrayContaining(ALL_CATEGORIES));
    expect(BLOG_CATEGORIES).toHaveLength(ALL_CATEGORIES.length);
  });
});

describe('normalizeCategory', () => {
  it('keeps valid categories, defaults otherwise', () => {
    expect(normalizeCategory('Wellness')).toBe('Wellness');
    expect(normalizeCategory('Nonsense')).toBe('Organization');
    expect(normalizeCategory(null)).toBe('Organization');
  });
});

describe('blogSlugify', () => {
  it('kebab-cases', () => {
    expect(blogSlugify('  10 Morning Routines!! ')).toBe('10-morning-routines');
  });
});

describe('contentBodyToBlocks', () => {
  it('splits paragraphs and detects headings', () => {
    const body = '# Intro\n\nFirst para line one\nline two\n\n**A Bold Heading**\n\nLast para';
    expect(contentBodyToBlocks(body)).toEqual([
      { type: 'h2', text: 'Intro' },
      { type: 'p', text: 'First para line one line two' },
      { type: 'h2', text: 'A Bold Heading' },
      { type: 'p', text: 'Last para' },
    ]);
  });
  it('handles empty', () => {
    expect(contentBodyToBlocks('')).toEqual([]);
    expect(contentBodyToBlocks(null)).toEqual([]);
  });
});

describe('estimateReadingMinutes', () => {
  it('is at least 1 and scales by words', () => {
    expect(estimateReadingMinutes('short text')).toBe(1);
    expect(estimateReadingMinutes(Array(400).fill('word').join(' '))).toBe(2);
  });
});

describe('deriveExcerpt', () => {
  it('uses the first paragraph and truncates', () => {
    expect(deriveExcerpt('## Heading\n\nThe body starts here.')).toBe('Heading');
    expect(deriveExcerpt('A short intro.\n\nmore')).toBe('A short intro.');
    expect(deriveExcerpt('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});

describe('buildBlogPost', () => {
  const now = '2026-06-22T00:00:00.000Z';
  it('derives fields and respects metadata.blog overrides', () => {
    const post = buildBlogPost({
      title: 'My First Post',
      body: 'Hello world.\n\nSecond paragraph here.',
      metadata: { blog: { category: 'Parenting', author: 'Jane', featured: true, tags: ['tips'] } },
    }, now);
    expect(post).toMatchObject({
      slug: 'my-first-post',
      title: 'My First Post',
      excerpt: 'Hello world.',
      author: 'Jane',
      category: 'Parenting',
      tags: ['tips'],
      featured: true,
      published: true,
      published_at: now,
    });
    expect(post.body).toEqual([
      { type: 'p', text: 'Hello world.' },
      { type: 'p', text: 'Second paragraph here.' },
    ]);
  });
  it('falls back to defaults with no overrides', () => {
    const post = buildBlogPost({ title: 'Plain', body: 'Body text.', metadata: null }, now);
    expect(post.author).toBe('The Bubaly Team');
    expect(post.category).toBe('Organization');
    expect(post.featured).toBe(false);
    expect(post.slug).toBe('plain');
  });
});

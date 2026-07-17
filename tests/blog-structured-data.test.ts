import { describe, expect, it } from 'vitest';
import {
  wordCount,
  blogPostingJsonLd,
  breadcrumbJsonLd,
  faqJsonLd,
  articleGraph,
  blogIndexJsonLd,
} from '../lib/blog/structured-data';
import type { BlogPost } from '../lib/blog/posts';

const post: BlogPost = {
  slug: 'the-mental-load-is-real',
  title: 'The Mental Load Is Real — and You Can Finally Put It Down',
  excerpt: 'The invisible work of running a household has a name. Here is how to share it.',
  author: 'Jessica Miller',
  date: '2026-07-10',
  readingMinutes: 6,
  tags: ['mental load', 'parenting', 'fair play'],
  category: 'Parenting',
  featured: true,
  heroImageUrl: 'https://images.unsplash.com/photo-x?w=1600',
  heroImageAlt: 'A parent exhaling on a tidy couch',
  heroImageCredit: 'Unsplash',
  body: [
    { type: 'p', text: 'One two three four five.' },
    { type: 'h2', text: 'A heading here' },
    { type: 'p', text: 'Six seven eight.' },
  ],
};

const BASE = 'https://www.bubaly.com';

describe('wordCount', () => {
  it('counts words across all blocks', () => {
    expect(wordCount(post.body)).toBe(5 + 3 + 3); // "A heading here" counts too
  });
});

describe('blogPostingJsonLd', () => {
  const ld = blogPostingJsonLd(post, BASE);
  it('is a valid BlogPosting with canonical @id and mainEntityOfPage', () => {
    expect(ld['@type']).toBe('BlogPosting');
    expect(ld['@id']).toBe(`${BASE}/blog/${post.slug}`);
    expect(ld.mainEntityOfPage).toMatchObject({ '@id': `${BASE}/blog/${post.slug}` });
  });
  it('emits ISO datePublished + dateModified from the date', () => {
    expect(ld.datePublished).toBe(new Date('2026-07-10').toISOString());
    expect(ld.dateModified).toBe(ld.datePublished);
  });
  it('carries author, publisher, image, section, keywords, wordCount', () => {
    expect(ld.author).toMatchObject({ '@type': 'Person', name: 'Jessica Miller' });
    expect(ld.publisher).toMatchObject({ '@type': 'Organization', name: 'Bubaly' });
    expect(ld.image).toMatchObject({ url: post.heroImageUrl });
    expect(ld.articleSection).toBe('Parenting');
    expect(ld.keywords).toBe('mental load, parenting, fair play');
    expect(ld.wordCount).toBe(11);
  });
  it('includes an AEO speakable spec', () => {
    expect(ld.speakable).toMatchObject({ '@type': 'SpeakableSpecification' });
  });
  it('omits date fields on an unparseable date (never emits NaN)', () => {
    const bad = blogPostingJsonLd({ ...post, date: 'not-a-date' }, BASE);
    expect(bad).not.toHaveProperty('datePublished');
  });
});

describe('breadcrumbJsonLd', () => {
  it('builds Home > Blog > Category > Title in order', () => {
    const bc = breadcrumbJsonLd(post, BASE);
    expect(bc['@type']).toBe('BreadcrumbList');
    expect(bc.itemListElement.map((i) => i.name)).toEqual([
      'Bubaly', 'Blog', 'Parenting', post.title,
    ]);
    expect(bc.itemListElement.map((i) => i.position)).toEqual([1, 2, 3, 4]);
    expect(bc.itemListElement[2].item).toBe(`${BASE}/blog?category=Parenting`);
  });
});

describe('faqJsonLd', () => {
  it('returns null with no FAQ (never fabricates)', () => {
    expect(faqJsonLd([])).toBeNull();
  });
  it('builds a FAQPage from real Q&A', () => {
    const f = faqJsonLd([{ question: 'What is the mental load?', answer: 'Invisible household work.' }]);
    expect(f).toMatchObject({ '@type': 'FAQPage' });
    expect(f!.mainEntity[0]).toMatchObject({ '@type': 'Question', name: 'What is the mental load?' });
  });
});

describe('articleGraph', () => {
  it('wraps BlogPosting + BreadcrumbList in a schema.org @graph', () => {
    const g = articleGraph(post, [], BASE);
    expect(g['@context']).toBe('https://schema.org');
    expect(g['@graph'].map((n) => (n as { '@type': string })['@type'])).toEqual([
      'BlogPosting', 'BreadcrumbList',
    ]);
  });
  it('appends FAQPage only when FAQ present', () => {
    const g = articleGraph(post, [{ question: 'Q?', answer: 'A.' }], BASE);
    expect(g['@graph'].map((n) => (n as { '@type': string })['@type'])).toContain('FAQPage');
  });
  it('serializes to valid JSON', () => {
    expect(() => JSON.parse(JSON.stringify(articleGraph(post, [], BASE)))).not.toThrow();
  });
});

describe('blogIndexJsonLd', () => {
  it('is a Blog listing recent posts (cap 50)', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...post, slug: `p-${i}` }));
    const ld = blogIndexJsonLd(many, BASE);
    expect(ld['@type']).toBe('Blog');
    expect(ld.blogPost).toHaveLength(50);
    expect(ld.blogPost[0].url).toBe(`${BASE}/blog/p-0`);
  });
});

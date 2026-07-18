import { describe, expect, it } from 'vitest';
import {
  articleHashtags,
  hashtagString,
  articleKeywords,
  BUBALY_URL,
  BRAND_HASHTAG,
} from '../lib/blog/social';

const post = {
  category: 'AI & Technology',
  tags: ['mental load', 'organization', 'AI'],
};

describe('articleHashtags', () => {
  const tags = articleHashtags(post);

  it('always includes #bubaly, first', () => {
    expect(tags[0]).toBe('#bubaly');
    expect(tags).toContain(BRAND_HASHTAG);
  });

  it('camelCases the category and tags into valid hashtags', () => {
    expect(tags).toContain('#aiAndTechnology');
    expect(tags).toContain('#mentalLoad');
    expect(tags).toContain('#organization');
    // Every hashtag is a single token: # then alphanumerics only.
    for (const t of tags) expect(t).toMatch(/^#[a-zA-Z0-9]+$/);
  });

  it('dedupes case-insensitively (AI tag vs the aiAndTechnology category stay distinct, but no exact dupes)', () => {
    const lower = tags.map((t) => t.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it('handles empty tags but still returns the brand + category', () => {
    const t = articleHashtags({ category: 'Wellness', tags: [] });
    expect(t).toEqual(['#bubaly', '#wellness']);
  });
});

describe('hashtagString', () => {
  it('joins hashtags with spaces for share/meta text', () => {
    const s = hashtagString(post);
    expect(s.startsWith('#bubaly ')).toBe(true);
    expect(s).toContain('#mentalLoad');
  });
});

describe('articleKeywords', () => {
  it('includes the brand, category, raw tags, and hashtags, deduped', () => {
    const k = articleKeywords(post);
    expect(k).toContain('Bubaly');
    expect(k).toContain('AI & Technology');
    expect(k).toContain('mental load');
    expect(k).toContain('#bubaly');
    expect(new Set(k.map((x) => x.toLowerCase())).size).toBe(k.length);
  });
});

describe('BUBALY_URL', () => {
  it('is the canonical Bubaly URL used for the backlink', () => {
    expect(BUBALY_URL).toBe('https://www.bubaly.com');
  });
});

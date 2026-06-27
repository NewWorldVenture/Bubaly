import { describe, it, expect } from 'vitest';
import {
  PLATFORMS, isPlatform, platformMeta, platformLabel,
  applyTab, applyQuickFilter, buildFeed, quickFilterCounts,
  type FeedItemLike,
} from '@/lib/social/feed';

const mk = (over: Partial<FeedItemLike>): FeedItemLike => ({
  kind: 'post', category: 'other', is_favorite: false, is_read: false, media_urls: [], posted_at: '2026-06-01T00:00:00Z', ...over,
});

describe('platform metadata', () => {
  it('covers the 9 mockup platforms', () => {
    expect(PLATFORMS.map((p) => p.key)).toEqual([
      'facebook', 'instagram', 'tiktok', 'youtube', 'x', 'linkedin', 'reddit', 'whatsapp', 'pinterest',
    ]);
  });
  it('validates + labels', () => {
    expect(isPlatform('instagram')).toBe(true);
    expect(isPlatform('myspace')).toBe(false);
    expect(platformLabel('youtube')).toBe('YouTube');
    expect(platformMeta('unknown').label).toBe('unknown');
  });
});

describe('applyTab', () => {
  const items = [
    mk({ category: 'family', is_favorite: true }),
    mk({ category: 'friends' }),
    mk({ category: 'groups' }),
    mk({ category: 'other' }),
  ];
  it('all passes everything', () => expect(applyTab(items, 'all')).toHaveLength(4));
  it('favorites filters favorites', () => expect(applyTab(items, 'favorites')).toHaveLength(1));
  it('category tabs match', () => {
    expect(applyTab(items, 'family')).toHaveLength(1);
    expect(applyTab(items, 'friends')).toHaveLength(1);
    expect(applyTab(items, 'groups')).toHaveLength(1);
  });
});

describe('applyQuickFilter', () => {
  const items = [
    mk({ kind: 'video', is_read: false }),
    mk({ kind: 'photo', is_read: true }),
    mk({ kind: 'link', is_favorite: true }),
    mk({ kind: 'post', media_urls: ['a.jpg'] }),
  ];
  it('null returns all', () => expect(applyQuickFilter(items, null)).toHaveLength(4));
  it('unread', () => expect(applyQuickFilter(items, 'unread')).toHaveLength(3));
  it('videos', () => expect(applyQuickFilter(items, 'videos')).toHaveLength(1));
  it('photos counts photo kind OR media present', () => expect(applyQuickFilter(items, 'photos')).toHaveLength(2));
  it('links', () => expect(applyQuickFilter(items, 'links')).toHaveLength(1));
  it('favorites', () => expect(applyQuickFilter(items, 'favorites')).toHaveLength(1));
});

describe('buildFeed', () => {
  it('sorts newest first then filters', () => {
    const items = [
      mk({ posted_at: '2026-06-01T00:00:00Z', category: 'family' }),
      mk({ posted_at: '2026-06-10T00:00:00Z', category: 'family' }),
      mk({ posted_at: '2026-06-05T00:00:00Z', category: 'friends' }),
    ];
    const out = buildFeed(items, 'family', null);
    expect(out).toHaveLength(2);
    expect(out[0].posted_at).toBe('2026-06-10T00:00:00Z');
  });
  it('handles empty', () => expect(buildFeed([], 'all', null)).toEqual([]));
});

describe('quickFilterCounts', () => {
  it('counts each bucket', () => {
    const c = quickFilterCounts([
      mk({ kind: 'video', is_read: false }),
      mk({ kind: 'photo', is_read: true, is_favorite: true }),
      mk({ kind: 'link', is_read: false }),
    ]);
    expect(c).toEqual({ unread: 2, favorites: 1, videos: 1, photos: 1, links: 1 });
  });
});

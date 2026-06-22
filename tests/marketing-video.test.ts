import { describe, expect, it } from 'vitest';
import {
  isVideoProvider,
  parseVideoUrl,
  embedUrl,
  thumbnailUrl,
  formatDuration,
  publishedOnly,
} from '@/lib/marketing/video';

describe('isVideoProvider', () => {
  it('accepts known providers only', () => {
    expect(isVideoProvider('youtube')).toBe(true);
    expect(isVideoProvider('upload')).toBe(true);
    expect(isVideoProvider('tiktok')).toBe(false);
    expect(isVideoProvider(null)).toBe(false);
  });
});

describe('parseVideoUrl', () => {
  it('parses YouTube variants', () => {
    expect(parseVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({ provider: 'youtube', videoId: 'dQw4w9WgXcQ' });
    expect(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ?t=10')).toEqual({ provider: 'youtube', videoId: 'dQw4w9WgXcQ' });
    expect(parseVideoUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toEqual({ provider: 'youtube', videoId: 'dQw4w9WgXcQ' });
    expect(parseVideoUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toEqual({ provider: 'youtube', videoId: 'dQw4w9WgXcQ' });
  });
  it('parses Vimeo variants', () => {
    expect(parseVideoUrl('https://vimeo.com/123456789')).toEqual({ provider: 'vimeo', videoId: '123456789' });
    expect(parseVideoUrl('https://player.vimeo.com/video/123456789')).toEqual({ provider: 'vimeo', videoId: '123456789' });
  });
  it('returns null for junk', () => {
    expect(parseVideoUrl('https://example.com/x')).toBeNull();
    expect(parseVideoUrl('')).toBeNull();
    expect(parseVideoUrl(null)).toBeNull();
  });
});

describe('embedUrl / thumbnailUrl', () => {
  it('builds embed URLs per provider', () => {
    expect(embedUrl('youtube', 'abc')).toBe('https://www.youtube.com/embed/abc');
    expect(embedUrl('vimeo', '123')).toBe('https://player.vimeo.com/video/123');
    expect(embedUrl('upload', 'x')).toBeNull();
    expect(embedUrl('youtube', null)).toBeNull();
  });
  it('thumbnails only for YouTube', () => {
    expect(thumbnailUrl('youtube', 'abc')).toBe('https://img.youtube.com/vi/abc/hqdefault.jpg');
    expect(thumbnailUrl('vimeo', '123')).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatDuration(0)).toBe('—');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(95)).toBe('1:35');
    expect(formatDuration(3661)).toBe('1:01:01');
  });
});

describe('publishedOnly', () => {
  it('keeps published, non-deleted', () => {
    const rows = [
      { status: 'published', deleted_at: null },
      { status: 'draft', deleted_at: null },
      { status: 'published', deleted_at: '2026-01-01' },
    ];
    expect(publishedOnly(rows)).toHaveLength(1);
  });
});

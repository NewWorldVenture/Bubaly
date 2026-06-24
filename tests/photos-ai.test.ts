import { describe, expect, it } from 'vitest';
import {
  analyzeAlbums,
  buildPhotosPrompt,
  parsePhotosResponse,
  type AlbumLike,
} from '@/lib/photos/ai';

function album(overrides: Partial<AlbumLike> & { id: string }): AlbumLike {
  return { title: 'Album', photo_count: 0, ...overrides };
}

describe('analyzeAlbums', () => {
  it('summarizes albums', () => {
    const r = analyzeAlbums([album({ id: 'a', photo_count: 10 }), album({ id: 'b', photo_count: 0 })], 10);
    expect(r.totalPhotos).toBe(10);
    expect(r.totalAlbums).toBe(2);
    expect(r.emptyAlbums).toBe(1);
    expect(r.summary).toContain('10 photos');
    expect(r.summary).toContain('1 empty');
  });

  it('handles empty', () => {
    const r = analyzeAlbums([], 0);
    expect(r.totalPhotos).toBe(0);
    expect(r.summary).toContain('0 photos');
  });
});

describe('buildPhotosPrompt', () => {
  it('builds prompt with album info', () => {
    const { system, user } = buildPhotosPrompt([album({ id: 'a', title: 'Summer', photo_count: 5 })], 5);
    expect(system).toContain('JSON');
    expect(user).toContain('Summer');
    expect(user).toContain('5 photos');
  });
});

describe('parsePhotosResponse', () => {
  it('parses valid JSON', () => {
    const r = parsePhotosResponse('{"suggestions":["sort by date"],"albumIdeas":["Holidays"],"organizationTip":"tag faces"}');
    expect(r.suggestions).toEqual(['sort by date']);
    expect(r.albumIdeas).toEqual(['Holidays']);
    expect(r.organizationTip).toBe('tag faces');
  });

  it('handles malformed input', () => {
    const r = parsePhotosResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parsePhotosResponse('```json\n{"suggestions":["x"],"albumIdeas":[],"organizationTip":"y"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});

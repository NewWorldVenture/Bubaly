import { describe, expect, it } from 'vitest';
import {
  isAssetKind,
  assetKindFromMime,
  isImageMime,
  formatBytes,
  parseTags,
  sanitizeAssetName,
  buildAssetPath,
  assetsByKind,
} from '@/lib/marketing/assets';

describe('isAssetKind', () => {
  it('accepts known kinds only', () => {
    expect(isAssetKind('image')).toBe(true);
    expect(isAssetKind('brand')).toBe(true);
    expect(isAssetKind('audio')).toBe(false);
    expect(isAssetKind(null)).toBe(false);
  });
});

describe('assetKindFromMime', () => {
  it('maps image/video, defaults to document', () => {
    expect(assetKindFromMime('image/png')).toBe('image');
    expect(assetKindFromMime('video/mp4')).toBe('video');
    expect(assetKindFromMime('application/pdf')).toBe('document');
    expect(assetKindFromMime(null)).toBe('document');
  });
  it('isImageMime', () => {
    expect(isImageMime('image/jpeg')).toBe(true);
    expect(isImageMime('video/mp4')).toBe(false);
  });
});

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(0)).toBe('—');
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(2048)).toBe('2KB');
    expect(formatBytes(2.4 * 1024 * 1024)).toBe('2.4MB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15MB');
  });
});

describe('parseTags', () => {
  it('cleans, kebabs and de-dupes', () => {
    expect(parseTags('Summer Sale, hero ,  Summer Sale')).toEqual(['summer-sale', 'hero']);
    expect(parseTags('a@b!, c#d')).toEqual(['ab', 'cd']);
    expect(parseTags('')).toEqual([]);
  });
});

describe('sanitizeAssetName / buildAssetPath', () => {
  it('sanitises filenames and partitions by kind', () => {
    expect(sanitizeAssetName('My Logo (final).png')).toBe('My_Logo_final_.png');
    expect(sanitizeAssetName('')).toBe('asset');
    expect(buildAssetPath('brand', 'abc123', 'My Logo.svg')).toBe('brand/abc123-My_Logo.svg');
  });
});

describe('assetsByKind', () => {
  it('buckets assets and ignores unknown kinds', () => {
    const grouped = assetsByKind([
      { kind: 'image' }, { kind: 'image' }, { kind: 'video' }, { kind: 'bogus' },
    ]);
    expect(grouped.image).toHaveLength(2);
    expect(grouped.video).toHaveLength(1);
    expect(grouped.document).toHaveLength(0);
    expect(grouped.brand).toHaveLength(0);
  });
});

// The 2026-09-27 page audit found blog cards and heroes pointing at Lorem
// Picsum ids that no longer exist: /_next/image answered 404 on the article
// and on every page listing it as related. `freeLicensedImage` drops those
// URLs so <BlogCover> draws the cover instead, the same way it already drops
// an unverified host.
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ unstable_rethrow: () => {} }));

import { freeLicensedImage, RETIRED_HERO_IMAGE_URLS } from '@/lib/blog/posts';

describe('a blog photo that no longer exists', () => {
  it('falls back to the drawn cover', () => {
    expect(freeLicensedImage('https://picsum.photos/id/624/1600/900')).toBeUndefined();
    for (const url of RETIRED_HERO_IMAGE_URLS) expect(freeLicensedImage(url)).toBeUndefined();
  });

  it('keeps a photo that still exists (control)', () => {
    expect(freeLicensedImage('https://picsum.photos/id/625/1600/900')).toBe('https://picsum.photos/id/625/1600/900');
    expect(freeLicensedImage('https://upload.wikimedia.org/wikipedia/commons/2/23/Football_for_kids_in_Rwanda.jpg'))
      .toBe('https://upload.wikimedia.org/wikipedia/commons/2/23/Football_for_kids_in_Rwanda.jpg');
  });

  it('still drops an unverified host', () => {
    expect(freeLicensedImage('https://loremflickr.com/1600/900/family')).toBeUndefined();
  });
});

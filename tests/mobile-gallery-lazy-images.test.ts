import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

// Mobile production-readiness (Phase — performance) [M-020]: the photo/memory/social
// GALLERY GRID thumbnails were raw `<img>` with no `loading` hint, so a phone
// eager-loaded every below-the-fold image on open — wasted mobile data + slower first
// paint on image-heavy screens. Added `loading="lazy" decoding="async"` to the grid /
// feed thumbnails (NOT the lightbox's active image or upload blob previews, which
// should load immediately). This guard locks lazy-loading onto those grids.

const files = {
  photos: 'components/modules/photos-module.tsx',
  socialFeed: 'components/modules/social-feed-module.tsx',
  memories: 'app/(app)/dashboard/memories/page.tsx',
};

const minLazy: Record<keyof typeof files, number> = {
  photos: 3,
  socialFeed: 3,
  memories: 4,
};

describe('gallery/feed grid thumbnails lazy-load on mobile', () => {
  for (const [name, file] of Object.entries(files)) {
    it(`${name} (${file}) lazy-loads its grid thumbnails`, () => {
      const src = fs.readFileSync(file, 'utf8');
      const lazyCount = (src.match(/loading="lazy" decoding="async"/g) ?? []).length;
      expect(lazyCount).toBeGreaterThanOrEqual(minLazy[name as keyof typeof files]);
    });
  }

  it('the photos lightbox active image is NOT lazy (it is the focused image)', () => {
    const src = fs.readFileSync(files.photos, 'utf8');
    const lightbox = src.split('\n').find((l) => l.includes('lightboxIdx') && l.includes('<img')) ?? '';
    expect(lightbox).not.toContain('loading="lazy"');
    // No line holds both `lightboxIdx` and `<img` any more (the lightbox renders
    // <FamilyMediaImg> over several lines), so the line above is the empty
    // string. Find the element that shows photos[lightboxIdx] and read all of it.
    const opening = '<FamilyMediaImg src={photos[lightboxIdx].url}';
    const start = src.indexOf(opening);
    expect(start).toBeGreaterThan(-1);
    expect(src.indexOf(opening, start + 1)).toBe(-1);
    const element = src.slice(start).match(/^[\s\S]*?\n\s*\)\}/)?.[0] ?? '';
    expect(element).toContain('className="max-h-[80vh]');
    expect(element).toContain('fallback={');
    expect(element).not.toMatch(/\bloading=/);
  });
});

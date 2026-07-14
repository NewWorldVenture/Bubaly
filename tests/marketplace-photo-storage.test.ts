import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { marketplacePhotoPathFromUrl } from '../lib/storage/marketplace-photos';

const ORIGIN = 'https://pvxbjgnxxftombaovoql.supabase.co';
const USER = '00000000-0000-4000-8000-000000000001';

describe('marketplace photo storage paths', () => {
  it('extracts only this bucket path from a project public URL', () => {
    expect(marketplacePhotoPathFromUrl(
      `${ORIGIN}/storage/v1/object/public/marketplace-photos/${USER}/123-photo.webp?cache=1`,
      ORIGIN,
    )).toBe(`${USER}/123-photo.webp`);
  });

  it('does not turn external URLs or other buckets into delete targets', () => {
    expect(marketplacePhotoPathFromUrl(
      `https://other.example/storage/v1/object/public/marketplace-photos/${USER}/photo.webp`,
      ORIGIN,
    )).toBeNull();
    expect(marketplacePhotoPathFromUrl(
      `${ORIGIN}/storage/v1/object/public/documents/${USER}/secret.pdf`,
      ORIGIN,
    )).toBeNull();
  });

  it('rejects paths that do not begin with a UUID-owned folder', () => {
    expect(marketplacePhotoPathFromUrl(
      `${ORIGIN}/storage/v1/object/public/marketplace-photos/not-a-user/../photo.webp`,
      ORIGIN,
    )).toBeNull();
  });

  it('wires cleanup into every marketplace listing lifecycle', () => {
    const root = process.cwd();
    const upload = readFileSync(resolve(root, 'components/marketplace/photo-upload.tsx'), 'utf8');
    const quickPost = readFileSync(resolve(root, 'components/marketplace/quick-post.tsx'), 'utf8');
    const marketplace = readFileSync(resolve(root, 'components/modules/marketplace-module.tsx'), 'utf8');

    expect(upload).toContain('onOwnedPathChange');
    expect(quickPost).toContain('await cleanupPhoto();');
    expect(marketplace).toContain('removeMarketplacePhotoUrl');
    expect(marketplace).toContain('await cleanupOwnedPhoto();');
  });
});

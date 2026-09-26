import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('family media persistence boundaries', () => {
  it('uses collision-resistant client-side upload paths', () => {
    // The randomUUID call these three used to make inline now lives in
    // lib/storage/object-name.ts, because four OTHER modules were naming objects
    // `${Date.now()}.${ext}` in the same public bucket. The assertion follows the
    // subject rather than the old spelling: each uploader must route through a
    // collision-resistant namer. tests/public-bucket-objects-are-unguessable.ts
    // enforces this across every uploader and checks the namer behaviourally.
    const createMemory = read('components/memories/create-memory.tsx');
    const photosModule = read('components/modules/photos-module.tsx');
    const marketplaceUpload = read('components/marketplace/photo-upload.tsx');

    expect(createMemory).toContain('familyMediaPath');
    expect(photosModule).toContain('familyMediaPath');
    expect(marketplaceUpload).toContain('crypto.randomUUID');
    expect(read('lib/storage/object-name.ts')).toContain('crypto.randomUUID');
  });

  it('cleans up family-media objects when Create Memory metadata fails', () => {
    const source = read('components/memories/create-memory.tsx');

    expect(source).toContain(".from('family-media').remove([stored.path])");
    expect(source).toContain('if (cleanupError) toastError');
    expect(source).not.toContain('upErr.message');
  });

  it('only counts Photos uploads after the library row is persisted', () => {
    const source = read('components/modules/photos-module.tsx');

    expect(source).toContain("}).select('id').single();");
    expect(source).toContain(".from('family-media').remove([stored.path])");
    expect(source).toContain('if (insertError || !photo)');
    expect(source).toContain('uploaded++;');
  });

  it('keeps storage failures generic in marketplace upload feedback', () => {
    const source = read('components/marketplace/photo-upload.tsx');

    expectSays(source, 'photoUpload.uploadFailedPleaseTryAgain', 'Upload failed. Please try again.');
    expect(source).not.toContain('toastError(`Upload failed: ${error.message}`)');
  });

  it('surfaces a failed Favorites update after a memory is saved', () => {
    const source = read('components/memories/create-memory.tsx');

    // Re-pointed (Audit C1-S9-83): the favorite now also reads back its row.
    expect(source).toMatch(/const \{ (?:data(?:: \w+)?, )?error: favoriteError \}/);
    expect(source).toContain('createMemory.theMemoryWasSavedBut');
  });
});

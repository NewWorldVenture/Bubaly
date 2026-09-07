import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('family media persistence boundaries', () => {
  it('uses collision-resistant client-side upload paths', () => {
    const createMemory = read('components/memories/create-memory.tsx');
    const photosModule = read('components/modules/photos-module.tsx');
    const marketplaceUpload = read('components/marketplace/photo-upload.tsx');

    expect(createMemory).toContain('crypto.randomUUID');
    expect(photosModule).toContain('crypto.randomUUID');
    expect(marketplaceUpload).toContain('crypto.randomUUID');
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

    expect(source).toContain('const { error: favoriteError }');
    expect(source).toContain('createMemory.theMemoryWasSavedBut');
  });
});

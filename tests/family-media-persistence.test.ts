import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expectSays } from './helpers/translated';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

describe('family media persistence boundaries', () => {
  it('uses collision-resistant client-side upload paths', () => {
    // This pinned the literal `crypto.randomUUID` in each component, which was
    // the right invariant expressed as an implementation detail. Both
    // family-media callers now build their path with familyMediaPath(), the one
    // place that decides this — see tests/family-media-paths-are-not-guessable.ts
    // for why it has to be unguessable rather than merely collision-resistant,
    // and for the sweep that stops a seventh caller rolling its own again.
    const createMemory = read('components/memories/create-memory.tsx');
    const photosModule = read('components/modules/photos-module.tsx');
    expect(createMemory).toContain('familyMediaPath(');
    expect(photosModule).toContain('familyMediaPath(');

    // The marketplace uploads to a DIFFERENT bucket (marketplace-photos) and
    // still rolls its own, so it keeps the original assertion.
    const marketplaceUpload = read('components/marketplace/photo-upload.tsx');
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

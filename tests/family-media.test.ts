import { describe, it, expect } from 'vitest';
import { partitionBySize, oversizeMessage, FAMILY_MEDIA_MAX_BYTES } from '@/lib/storage/family-media';

const file = (name: string, size: number) => ({ name, size });

describe('partitionBySize', () => {
  it('splits files at the 25 MB bucket limit (inclusive ok)', () => {
    const { ok, tooBig } = partitionBySize([
      file('a.jpg', 1_000),
      file('exact.jpg', FAMILY_MEDIA_MAX_BYTES),
      file('big.mp4', FAMILY_MEDIA_MAX_BYTES + 1),
    ]);
    expect(ok.map((f) => f.name)).toEqual(['a.jpg', 'exact.jpg']);
    expect(tooBig.map((f) => f.name)).toEqual(['big.mp4']);
  });

  it('handles an empty list', () => {
    expect(partitionBySize([])).toEqual({ ok: [], tooBig: [] });
  });
});

describe('oversizeMessage', () => {
  it('is null when nothing overflowed', () => {
    expect(oversizeMessage(0)).toBeNull();
  });
  it('pluralizes', () => {
    expect(oversizeMessage(1)).toBe('1 file skipped — over the 25 MB limit.');
    expect(oversizeMessage(3)).toBe('3 files skipped — over the 25 MB limit.');
  });
});

import { describe, expect, it } from 'vitest';
import { isBundleStaleByAge, isStaleBundleError, shouldHardReload } from '@/lib/display/recover';

describe('isStaleBundleError', () => {
  it('recognizes the stale-bundle error family', () => {
    expect(isStaleBundleError('ChunkLoadError: Loading chunk 4838 failed.')).toBe(true);
    expect(isStaleBundleError('Failed to fetch dynamically imported module: https://x/_next/…')).toBe(true);
    expect(isStaleBundleError('Importing a module script failed.')).toBe(true);
    expect(isStaleBundleError("'text/html' is not a valid JavaScript MIME type")).toBe(true);
  });

  it('ignores ordinary errors and empties', () => {
    expect(isStaleBundleError('RangeError: Invalid time value')).toBe(false);
    expect(isStaleBundleError('')).toBe(false);
    expect(isStaleBundleError(null)).toBe(false);
  });
});

describe('shouldHardReload', () => {
  it('hard-reloads immediately on stale-bundle errors', () => {
    expect(shouldHardReload(0, 'Loading chunk 12 failed')).toBe(true);
  });

  it('gives ordinary errors two soft resets, then escalates', () => {
    expect(shouldHardReload(0, 'Something transient')).toBe(false);
    expect(shouldHardReload(1, 'Something transient')).toBe(false);
    expect(shouldHardReload(2, 'Something transient')).toBe(true);
    expect(shouldHardReload(5, undefined)).toBe(true);
  });
});

describe('isBundleStaleByAge', () => {
  const H = 3_600_000;
  it('flags a bundle past the max age, not before', () => {
    expect(isBundleStaleByAge(0, 11 * H, 12)).toBe(false);
    expect(isBundleStaleByAge(0, 12 * H, 12)).toBe(true);
  });
});

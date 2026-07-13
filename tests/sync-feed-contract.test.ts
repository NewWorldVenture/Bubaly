import { describe, expect, it } from 'vitest';
import { isValidFeedToken } from '@/lib/sync/feed-request';

describe('public calendar feed token contract', () => {
  it('accepts compact URL-safe capability tokens', () => {
    expect(isValidFeedToken('a'.repeat(16))).toBe(true);
    expect(isValidFeedToken('Abc_123-xyz-token')).toBe(true);
  });

  it('rejects missing, oversized, and unsafe token values before database access', () => {
    expect(isValidFeedToken(null)).toBe(false);
    expect(isValidFeedToken('')).toBe(false);
    expect(isValidFeedToken('a'.repeat(201))).toBe(false);
    expect(isValidFeedToken('token/with/slash')).toBe(false);
    expect(isValidFeedToken({})).toBe(false);
  });
});

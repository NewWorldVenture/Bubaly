import { createHmac } from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { generateFeedToken, signFeedToken, verifyFeedSignature } from '@/lib/sync/feed-token';

// A feed token is a capability: whoever holds it reads that calendar. The
// optional HMAC signature is there for tamper-evidence, and it used to be
// computed with `process.env.SYNC_TOKEN_KEY ?? ''`.
//
// An HMAC keyed on the empty string is computable by anyone. On a deployment
// that had not set SYNC_TOKEN_KEY, `verifyFeedSignature` would have accepted a
// forged signature and said nothing — the same shape `hasCronAuthorization`
// exists to avoid, where a missing secret quietly becomes a usable one.
//
// Every other use of this key already fails closed: `getKey()` throws, both
// sync callbacks document "fails closed without SYNC_TOKEN_KEY", and
// architecture.md records it that way. This was the one place that did not.
//
// Nothing calls these two functions today. That is the reason to fix the
// fallback rather than leave it for whoever wires them up first.
const KEY = '12'.repeat(32);

afterEach(() => vi.unstubAllEnvs());

describe('feed token signing fails closed without its key', () => {
  it('refuses to sign with no key rather than signing with an empty secret', () => {
    vi.stubEnv('SYNC_TOKEN_KEY', '');
    expect(() => signFeedToken('abc')).toThrow(/SYNC_TOKEN_KEY/);
  });

  it('rejects the signature an attacker computes with the empty key', () => {
    // THE actual attack, and the one worth asserting. With the old
    // `?? ''` fallback the server signed with the empty string, which anybody
    // can do too — so this forgery verified TRUE on any deployment missing the
    // variable.
    //
    // A first draft of this test checked the opposite direction — a genuine
    // signature presented while the key was missing — which returns false
    // either way and so passed against the very bug it was written for.
    const token = generateFeedToken();
    const forged = createHmac('sha256', '').update(token).digest('base64url');

    vi.stubEnv('SYNC_TOKEN_KEY', '');
    expect(verifyFeedSignature(token, forged)).toBe(false);
    expect(verifyFeedSignature(token, '')).toBe(false);
  });

  it('still accepts a genuine signature and rejects a wrong one (control)', () => {
    vi.stubEnv('SYNC_TOKEN_KEY', KEY);
    const token = generateFeedToken();
    expect(verifyFeedSignature(token, signFeedToken(token))).toBe(true);
    expect(verifyFeedSignature(token, signFeedToken('a different token'))).toBe(false);
  });

  it('gives a feed token real entropy (sanity)', () => {
    const a = generateFeedToken();
    const b = generateFeedToken();
    expect(a).not.toEqual(b);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
  });
});

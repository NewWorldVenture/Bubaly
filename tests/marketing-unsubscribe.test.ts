import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unsubToken, verifyUnsubToken, unsubUrl } from '@/lib/marketing/unsubscribe';

afterEach(() => vi.unstubAllEnvs());

describe('marketing unsubscribe tokens', () => {
  it('is deterministic and case/space-insensitive on the email', () => {
    expect(unsubToken('a@b.com')).toBe(unsubToken('  A@B.com '));
  });

  it('verifies a valid token', () => {
    const e = 'parent@example.com';
    expect(verifyUnsubToken(e, unsubToken(e))).toBe(true);
  });

  it('rejects a tampered or empty token', () => {
    expect(verifyUnsubToken('parent@example.com', 'deadbeef')).toBe(false);
    expect(verifyUnsubToken('parent@example.com', '')).toBe(false);
  });

  it('does not accept another address token', () => {
    expect(verifyUnsubToken('a@b.com', unsubToken('c@d.com'))).toBe(false);
  });

  it('builds a one-click url with email + token params', () => {
    const url = unsubUrl('https://app.test/', 'a@b.com');
    expect(url).toContain('/api/marketing/unsubscribe?e=a%40b.com&t=');
    expect(url).not.toContain('//api'); // trailing slash trimmed
  });

  it('fails closed when production has no unsubscribe secret', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MARKETING_UNSUB_SECRET', '');
    vi.stubEnv('INTERNAL_SECRET', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    expect(() => unsubToken('parent@example.com')).toThrow('MARKETING_UNSUB_SECRET');
    // Verification fails the same way: no dev secret is consulted in production.
    const devSigned = createHmac('sha256', 'bubaly-dev-unsub-secret').update('parent@example.com').digest('hex');
    expect(() => verifyUnsubToken('parent@example.com', devSigned)).toThrow('MARKETING_UNSUB_SECRET');
  });

  // Production signs with INTERNAL_SECRET today, because MARKETING_UNSUB_SECRET
  // is unset there (ENV-F3AB1A14762D). The operator action that closes that row
  // must not invalidate the unsubscribe links already mailed.
  it('keeps verifying a link signed before MARKETING_UNSUB_SECRET was set', () => {
    vi.stubEnv('MARKETING_UNSUB_SECRET', '');
    vi.stubEnv('INTERNAL_SECRET', 'internal-only');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role');
    const e = 'parent@example.com';
    const mailed = unsubToken(e);
    expect(mailed).toBe(createHmac('sha256', 'internal-only').update(e).digest('hex'));

    vi.stubEnv('MARKETING_UNSUB_SECRET', 'dedicated-secret');
    const fresh = unsubToken(e);
    expect(fresh).toBe(createHmac('sha256', 'dedicated-secret').update(e).digest('hex'));
    expect(fresh).not.toBe(mailed);
    expect(verifyUnsubToken(e, mailed)).toBe(true);
    expect(verifyUnsubToken(e, fresh)).toBe(true);
    // The older service-role fallback is still honoured while it is configured.
    expect(verifyUnsubToken(e, createHmac('sha256', 'service-role').update(e).digest('hex'))).toBe(true);
  });

  it('does not verify a token signed with a secret that is not configured', () => {
    vi.stubEnv('MARKETING_UNSUB_SECRET', 'dedicated-secret');
    vi.stubEnv('INTERNAL_SECRET', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const e = 'parent@example.com';
    expect(verifyUnsubToken(e, createHmac('sha256', 'some-other-secret').update(e).digest('hex'))).toBe(false);
    // A retired fallback stops verifying once it is no longer configured.
    expect(verifyUnsubToken(e, createHmac('sha256', 'internal-only').update(e).digest('hex'))).toBe(false);
    // Nor does the dev secret, which only exists where nothing is configured.
    expect(verifyUnsubToken(e, createHmac('sha256', 'bubaly-dev-unsub-secret').update(e).digest('hex'))).toBe(false);
    expect(verifyUnsubToken(e, unsubToken(e))).toBe(true);
  });

  it('treats a blank secret as unset, in the same order as signing', () => {
    vi.stubEnv('MARKETING_UNSUB_SECRET', '   ');
    vi.stubEnv('INTERNAL_SECRET', 'internal-only');
    const e = 'parent@example.com';
    expect(unsubToken(e)).toBe(createHmac('sha256', 'internal-only').update(e).digest('hex'));
    expect(verifyUnsubToken(e, createHmac('sha256', '   ').update(e).digest('hex'))).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { unsubToken, verifyUnsubToken, unsubUrl } from '@/lib/marketing/unsubscribe';

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
});

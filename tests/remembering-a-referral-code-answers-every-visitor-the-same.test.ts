// Call-level tests for app/(auth)/signup/actions.ts (audit Register B, group 8).
//
// rememberReferralCodeAction runs when /signup?ref=CODE mounts, before anyone
// has an account. It reads no session, household or role (createServer and
// the service client throw if called), and it writes one thing: an httpOnly
// cookie holding the normalized code. Whose code it is — household A's, B's,
// the caller's own — is decided later, at onboarding, by
// captureSignupReferral; this action has no id to check against a family.
// So every caller gets the same answer: a plausible code is remembered, and
// anything else is refused with no cookie written.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: h.set }) }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => { throw new Error('must not read the session'); },
  createServiceClient: () => { throw new Error('must not reach the database'); },
}));

const { rememberReferralCodeAction } = await import('@/app/(auth)/signup/actions');

beforeEach(() => { h.set.mockReset(); });

describe('rememberReferralCodeAction', () => {
  it('ACTION-A1C6EC63DB88 any visitor has a plausible code remembered, normalized, in an httpOnly cookie', async () => {
    await expect(rememberReferralCodeAction(' ab12-cd34 ')).resolves.toEqual({ ok: true, code: 'AB12-CD34' });
    expect(h.set).toHaveBeenCalledTimes(1);
    expect(h.set).toHaveBeenCalledWith('bubaly_ref', 'AB12-CD34', expect.objectContaining({
      path: '/', httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 60 * 60,
    }));
  });

  it.each(['', 'x', 'has spaces and; semicolons', 'TOO-LONG-REFERRAL-CODE-1234', '<script>'])(
    'ACTION-A1C6EC63DB88 an implausible code %j is refused and nothing is written', async (code) => {
      await expect(rememberReferralCodeAction(code)).resolves.toEqual({ ok: false });
      expect(h.set).not.toHaveBeenCalled();
    });

  it('ACTION-A1C6EC63DB88 a value that is not a string is refused and nothing is written', async () => {
    await expect(rememberReferralCodeAction({ code: 'AB12' } as unknown as string)).resolves.toEqual({ ok: false });
    expect(h.set).not.toHaveBeenCalled();
  });
});

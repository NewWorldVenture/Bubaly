import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserContext } from '@/lib/supabase/auth';

// The server half of two-step sign-in. Three things are pinned here:
//   1. the decision (pure) — who is sent to the step-up page and who is not;
//   2. the guard — it redirects through next/navigation with the return path,
//      fails CLOSED when the assurance level cannot be read, and logs that;
//   3. the wiring — every money/documents/trust page actually calls it, and
//      /dashboard/security (home alarms) does not.

const mocks = vi.hoisted(() => ({
  redirect: vi.fn(),
  getAal: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    mocks.redirect(to);
    throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: mocks.getAal } } }),
}));

import { aal2Verdict, decideAal2, readAssurance, requireAal2 } from '@/lib/auth/require-aal2';

function ctx(role: string): UserContext {
  return {
    user: { id: 'user-1', email: 'p@example.com' },
    memberships: [],
    active: { familyId: 'fam-1', role, member: { id: 'mem-1' }, family: { id: 'fam-1', timezone: 'UTC' } },
  } as unknown as UserContext;
}

describe('decideAal2', () => {
  it('allows a session whose level was read and needs nothing more', () => {
    expect(decideAal2({ role: 'parent', read: { ok: true, assurance: { currentLevel: 'aal1', nextLevel: 'aal1' } }, returnTo: '/dashboard/expenses' })).toEqual({ action: 'allow' });
    expect(decideAal2({ role: 'parent', read: { ok: true, assurance: { currentLevel: 'aal2', nextLevel: 'aal2' } }, returnTo: '/dashboard/expenses' })).toEqual({ action: 'allow' });
    expect(decideAal2({ role: 'teen', read: { ok: true, assurance: { currentLevel: 'aal1', nextLevel: 'aal2' } }, returnTo: '/dashboard/expenses' })).toEqual({ action: 'allow' });
  });

  it('sends a manager with an enrolled factor and an aal1 session to step up, carrying the return path', () => {
    expect(decideAal2({ role: 'adult', read: { ok: true, assurance: { currentLevel: 'aal1', nextLevel: 'aal2' } }, returnTo: '/dashboard/trust' }))
      .toEqual({ action: 'step_up', to: '/auth/step-up?next=%2Fdashboard%2Ftrust', reason: 'needs_code' });
  });

  it('fails closed when the level could not be read — the step-up page shows the error, the sensitive page does not render', () => {
    expect(decideAal2({ role: 'parent', read: { ok: false, error: new Error('jwt malformed') }, returnTo: '/dashboard/documents' }))
      .toEqual({ action: 'step_up', to: '/auth/step-up?next=%2Fdashboard%2Fdocuments', reason: 'assurance_unreadable' });
  });
});

describe('readAssurance', () => {
  it('wraps the Supabase answer, a Supabase error, and a thrown error the same way', async () => {
    const good = await readAssurance({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null }) } } });
    expect(good).toEqual({ ok: true, assurance: { currentLevel: 'aal1', nextLevel: 'aal2' } });

    const bad = await readAssurance({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: null, error: { message: 'no session' } }) } } });
    expect(bad).toMatchObject({ ok: false, error: { message: 'no session' } });

    const thrown = await readAssurance({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => { throw new Error('network'); } } } });
    expect(thrown).toMatchObject({ ok: false, error: new Error('network') });
  });
});

describe('requireAal2', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.redirect.mockReset();
    mocks.getAal.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns for a family with no authenticator, without redirecting', async () => {
    mocks.getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null });
    await expect(requireAal2(ctx('parent'), 'money', '/dashboard/expenses')).resolves.toBeUndefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('redirects a manager who enrolled a factor but has not entered a code this session', async () => {
    mocks.getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null });
    await expect(requireAal2(ctx('parent'), 'money', '/dashboard/expenses')).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/auth/step-up?next=%2Fdashboard%2Fexpenses');
  });

  it('lets the same manager through once the session is aal2', async () => {
    mocks.getAal.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null });
    await expect(requireAal2(ctx('parent'), 'trust', '/dashboard/trust')).resolves.toBeUndefined();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it('fails closed and logs when the assurance level cannot be read', async () => {
    mocks.getAal.mockResolvedValue({ data: null, error: { message: 'session missing' } });
    await expect(requireAal2(ctx('adult'), 'documents', '/dashboard/documents')).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.redirect).toHaveBeenCalledWith('/auth/step-up?next=%2Fdashboard%2Fdocuments');
    expect(errorSpy.mock.calls.map((c: unknown[]) => String(c[0]))).toContain('[auth/aal2] documents assurance level read failed');
  });

  it('answers a verdict without acting on it, for route handlers that reply with JSON', async () => {
    mocks.getAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null });
    const verdict = await aal2Verdict(ctx('parent'), 'documents', '/dashboard/settings#privacy');
    expect(verdict).toEqual({ action: 'step_up', to: '/auth/step-up?next=%2Fdashboard%2Fsettings%23privacy', reason: 'needs_code' });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});

describe('the pages that hold money, documents and trust call the guard', () => {
  const GUARDED: [string, 'money' | 'documents' | 'trust', string][] = [
    ['app/(app)/dashboard/expenses/page.tsx', 'money', '/dashboard/expenses'],
    ['app/(app)/dashboard/budgets/page.tsx', 'money', '/dashboard/budgets'],
    ['app/(app)/dashboard/bills/page.tsx', 'money', '/dashboard/bills'],
    ['app/(app)/dashboard/payments/page.tsx', 'money', '/dashboard/payments'],
    ['app/(app)/dashboard/autopay/page.tsx', 'money', '/dashboard/autopay'],
    ['app/(app)/dashboard/savings/page.tsx', 'money', '/dashboard/savings'],
    ['app/(app)/dashboard/subscriptions/page.tsx', 'money', '/dashboard/subscriptions'],
    ['app/(app)/dashboard/money-timeline/page.tsx', 'money', '/dashboard/money-timeline'],
    ['app/(app)/dashboard/family-cfo/page.tsx', 'money', '/dashboard/family-cfo'],
    ['app/(app)/dashboard/tax-vault/page.tsx', 'documents', '/dashboard/tax-vault'],
    ['app/(app)/dashboard/documents/page.tsx', 'documents', '/dashboard/documents'],
    ['app/(app)/dashboard/files/cloud/page.tsx', 'documents', '/dashboard/files/cloud'],
    ['app/(app)/dashboard/files/shared/page.tsx', 'documents', '/dashboard/files/shared'],
    ['app/(app)/dashboard/files/vault/page.tsx', 'documents', '/dashboard/files/vault'],
    ['app/(app)/dashboard/binder/page.tsx', 'documents', '/dashboard/binder'],
    ['app/(app)/dashboard/paperwork/page.tsx', 'documents', '/dashboard/paperwork'],
    ['app/(app)/dashboard/passwords/page.tsx', 'documents', '/dashboard/passwords'],
    ['app/(app)/dashboard/trust/page.tsx', 'trust', '/dashboard/trust'],
  ];

  it.each(GUARDED)('%s calls requireAal2 as %s with its own return path', (file, area, returnTo) => {
    const src = readFileSync(file, 'utf8');
    expect(src).toContain("from '@/lib/auth/require-aal2'");
    expect(src).toContain(`requireAal2(ctx, '${area}', '${returnTo}')`);
    // The guard runs after the context guard, never instead of it.
    expect(src).toMatch(/await require(UserContext|Feature)\(/);
  });

  it('leaves /dashboard/security (home alarms) alone, per the standing sidebar rule', () => {
    const src = readFileSync('app/(app)/dashboard/security/page.tsx', 'utf8');
    expect(src).not.toContain('requireAal2');
  });

  it('the step-up page validates its return path and never asks a session that needs no code', () => {
    const src = readFileSync('app/(app)/auth/step-up/page.tsx', 'utf8');
    expect(src).toContain('isSafeReturnPath(rawNext)');
    expect(src).toContain("sessionStrength(read.assurance) !== 'needs_step_up') redirect(next)");
  });
});

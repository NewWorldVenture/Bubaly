// SRV-001 l6 — an admin action ANSWERS when the account cannot be checked; it
// does not reject.
//
// getUser() and isSuperAdmin() raise on a retryable auth failure, correctly —
// "we could not tell" is not "signed out". But the admin actions awaited them
// before their own try, so the action REJECTED instead of returning the result
// its caller branches on. On /admin/stripe and /admin/services that left the
// button spinning with no message until a reload (the operator could not tell
// whether the keys were saved; they were not); the <form action> forms fell to
// the error boundary and threw away what had been typed.
//
// Each action here must now resolve to `ok: false` with the catalogue's
// "Account context is temporarily unavailable." and write nothing.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const UNAVAILABLE = EN_US['ai.accountContextIsTemporarilyUnavailable'];
const h = vi.hoisted(() => ({
  mode: 'throws' as 'throws' | 'forbidden' | 'allowed',
  serviceClient: vi.fn(),
}));

vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => {
    if (h.mode === 'throws') throw new Error('Account context is temporarily unavailable.');
    return h.mode === 'forbidden' ? null : { id: 'admin-1', email: 'admin@example.com' };
  },
  isSuperAdmin: async () => {
    if (h.mode === 'throws') throw new Error('Account context is temporarily unavailable.');
    return h.mode === 'allowed';
  },
  requireUserContext: async () => { throw new Error('not used here'); },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: (...args: unknown[]) => { h.serviceClient(...args); throw new Error('nothing may be written'); },
  createServer: async () => { throw new Error('nothing may be written'); },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }));

const { superAdminGate } = await import('@/lib/auth/super-admin-gate');
const { saveAIConfigAction, testAIConnectionAction } = await import('@/app/(app)/admin/ai/actions');
const { saveSocialLinksAction } = await import('@/app/(app)/admin/settings/social-links/actions');
const { setFeatureTierAction, resetFeatureTiersAction } = await import('@/app/(app)/admin/tier-features/actions');
const { saveServiceDescriptionAction, resetServiceDescriptionAction } = await import('@/app/(app)/admin/services/actions');
const { saveStripeSettingsAction, testStripeConnectionAction } = await import('@/app/(app)/admin/actions');

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  h.mode = 'throws';
  h.serviceClient.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('superAdminGate is an answer, never a throw', () => {
  it('is unavailable when the auth check throws', async () => {
    expect(await superAdminGate()).toEqual({ status: 'unavailable' });
  });
  it('is forbidden for nobody signed in, and for a signed-in non-admin', async () => {
    h.mode = 'forbidden';
    expect(await superAdminGate()).toEqual({ status: 'forbidden' });
  });
  it('is allowed, with the user, for a super admin', async () => {
    h.mode = 'allowed';
    expect(await superAdminGate()).toMatchObject({ status: 'allowed', user: { id: 'admin-1' } });
  });
});

describe('an admin action whose auth check throws resolves with a sentence and writes nothing', () => {
  const cases: [string, () => Promise<unknown>][] = [
    ['saveAIConfigAction', () => saveAIConfigAction(form({ model: 'gpt-x', openaiKey: 'sk-test' }))],
    ['saveSocialLinksAction', () => saveSocialLinksAction(form({ revision: 'r1' }))],
    ['setFeatureTierAction', () => setFeatureTierAction('meals', 'plus')],
    ['resetFeatureTiersAction', () => resetFeatureTiersAction()],
    ['saveServiceDescriptionAction', () => saveServiceDescriptionAction({ key: '/dashboard/meals', description: 'x' })],
    ['resetServiceDescriptionAction', () => resetServiceDescriptionAction({ key: '/dashboard/meals' })],
    ['saveStripeSettingsAction', () => saveStripeSettingsAction({
      enabled: true, publishableKey: null, secretKey: null, webhookSecret: null,
      connectAccountId: null, serviceFeeCents: 90, serviceFeePriceId: null,
    })],
    ['testStripeConnectionAction', () => testStripeConnectionAction()],
  ];

  it.each(cases)('%s', async (_name, run) => {
    expect(UNAVAILABLE).toEqual(expect.any(String));
    await expect(run()).resolves.toEqual({ ok: false, error: UNAVAILABLE });
    expect(h.serviceClient).not.toHaveBeenCalled();
  });

  it('testAIConnectionAction answers with its own result shape', async () => {
    await expect(testAIConnectionAction()).resolves.toEqual({ ok: false, code: 'unavailable', message: UNAVAILABLE, detail: '' });
    expect(h.serviceClient).not.toHaveBeenCalled();
  });
});

describe('a caller who is not a super admin is still refused, as before', () => {
  it('forbidden is not unavailable', async () => {
    h.mode = 'forbidden';
    await expect(saveAIConfigAction(form({ model: 'gpt-x' }))).resolves.toEqual({ ok: false, error: EN_US['actions.forbidden'] });
    await expect(setFeatureTierAction('meals', 'plus')).resolves.toEqual({ ok: false, error: EN_US['actions.notAuthorized'] });
    expect(h.serviceClient).not.toHaveBeenCalled();
  });
});

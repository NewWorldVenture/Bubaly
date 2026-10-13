// M1 — "Can we afford it?" answers to the gates its page applies.
//
// /dashboard/family-cfo refuses a guest and a Free or Basic family
// (requireFeature), anyone who is not a parent or adult (readsHouseholdMoney),
// and a password-only session of a parent with an authenticator (requireAal2).
// Its form's server action did none of that: its id ships in the form's client
// bundle, so a child, a teen, a caregiver, a guest, a Basic family or an aal1
// session could POST any amount and date and read back the household's
// projected lowest balance, before and after, and the headroom — the figures
// the page withholds.
//
// The action is driven for real, with the real plan resolver and step-up
// verdict; the forecast loader is the one seam, and whether it is reached at
// all is the question for every refusal.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuildTimelineInput } from '@/lib/finance/timeline';

const mocks = vi.hoisted(() => ({
  role: 'parent' as string,
  plan: 'plus',
  aal: { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null } as unknown,
  load: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw Object.assign(new Error('NEXT_REDIRECT'), { digest: `NEXT_REDIRECT;replace;${to};307;` }); },
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('@/lib/i18n/server', async () => {
  const { readFileSync: read } = await import('node:fs');
  const { translate } = await import('@/lib/i18n/translate');
  const messages = JSON.parse(read('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1', email: 'member@example.com' },
    memberships: [],
    active: { familyId: 'fam-1', role: mocks.role, member: { id: 'mem-1' }, family: { id: 'fam-1', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', async () => {
  const { entitledServiceClient: client } = await import('./helpers/entitled-service-client');
  return {
    createServer: async () => ({
      auth: { mfa: { getAuthenticatorAssuranceLevel: async () => mocks.aal } },
      // The feature-tier settings read: no override, the catalog's own tier.
      from: client(mocks.plan).from,
    }),
    // The plan is read through the service client (lib/server/plan.ts).
    createServiceClient: () => client(mocks.plan),
  };
});
vi.mock('@/lib/finance/timeline-load', () => ({ loadMoneyTimelineInput: mocks.load }));

const { assessAffordabilityAction } = await import('@/app/(app)/dashboard/family-cfo/actions');

const en = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
const ASK = { label: 'New car', amountDollars: 900, date: '2026-10-20', recurrence: 'once' as const };

/** The household the forecast is built from: $2,000 in checking. */
const HOUSEHOLD: BuildTimelineInput = { bills: [], goals: [], events: [], startingBalance: 2000, now: new Date('2026-10-13T12:00:00Z') };

beforeEach(() => {
  mocks.role = 'parent';
  mocks.plan = 'plus';
  mocks.aal = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
  mocks.load.mockReset().mockResolvedValue(HOUSEHOLD);
  // Silences the expected-failure logging; nothing asserts on it.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('"Can we afford it?" answers to the gates its page applies', () => {
  it('a parent on Family+ with the code entered gets the answer', async () => {
    const res = await assessAffordabilityAction(ASK);
    expect(res.ok).toBe(true);
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s is told whose money it is, and the forecast is never read', async (role) => {
    mocks.role = role;
    const res = await assessAffordabilityAction(ASK);
    expect(res).toEqual({ ok: false, error: en['householdMoney.keptByParents'] });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it.each(['free', 'basic'])('a %s family is refused the Family+ what-if', async (plan) => {
    mocks.plan = plan;
    const res = await assessAffordabilityAction(ASK);
    expect(res).toEqual({ ok: false, error: en['familyCfoActions.needsFamilyPlus'] });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('a password-only session of a parent with an authenticator is sent for the code', async () => {
    mocks.aal = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
    const res = await assessAffordabilityAction(ASK);
    expect(res).toEqual({
      ok: false,
      error: en['familyCfoActions.needsYourCode'],
      stepUp: `/auth/step-up?next=${encodeURIComponent('/dashboard/family-cfo')}`,
    });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('a parent who never enrolled an authenticator is not asked for one', async () => {
    mocks.aal = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
    expect((await assessAffordabilityAction(ASK)).ok).toBe(true);
  });
});

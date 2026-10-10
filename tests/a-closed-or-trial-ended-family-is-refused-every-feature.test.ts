// A closed or trial-ended family is refused every feature, not only the paid ones.
//
// `resolveFeatureEntitlement` is the one answer to "may this family use this
// feature?" for pages (`requireFeature`), routes (`refuseUnlessEntitled`), the
// family write actions (`lib/family/actions.ts`) and crons. It read only the
// family's plan level. `computeEntitlement` gives a closed family, and one
// whose 5-day trial ended unpaid, level 0, the same as Free, and adds `closed`
// / `locked` beside it. So both still had every Free-tier feature (chores,
// meals, the assistant and the rest), and every server gate answered "allowed".
// The only thing in their way was the overlay `app/(app)/layout.tsx` draws over
// the web screens.
//
// The refusal must not trap anyone. `requireFeature` sends a refused family to
// /dashboard/billing, and the layout's gate is drawn there too, with its own
// way back (reopen the account, or choose a plan, both server-side). So the
// billing page is the one place that must never send a family on again; the
// last cases pin that.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveFeatureTiers, tiersByHref } from '@/lib/features/tiers';
import type { FeatureTier } from '@/lib/constants/feature-catalog';

type Family = { trial_ends_at: string | null; closed_at: string | null };
const state: {
  family: Family;
  subscriptions: Array<{ plan: string; status: string }>;
  overrides: Record<string, FeatureTier>;
  superAdmin: boolean;
} = { family: { trial_ends_at: null, closed_at: null }, subscriptions: [], overrides: {}, superAdmin: false };

/** A thenable query chain that answers with `result` whatever is filtered. */
function chain(result: () => unknown) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'order', 'limit', 'maybeSingle', 'single', 'abortSignal']) c[m] = () => c;
  c.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result()).then(resolve);
  return c;
}

/** The service client `lib/server/plan.ts` reads the family's standing through. */
const serviceClient = {
  from: (table: string) => chain(() => (
    table === 'families' ? { data: state.family, error: null }
      : table === 'subscriptions' ? { data: state.subscriptions, error: null }
        : { data: null, error: null })),
};

/** The member's own session, as `getUserContext` and `isSuperAdmin` read it. */
const sessionClient = {
  auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'parent@example.test' } }, error: null }) },
  rpc: async (name: string) => ({ data: name === 'is_super_admin' ? state.superAdmin : null, error: null }),
  from: (table: string) => chain(() => (
    table === 'family_members'
      ? { data: [{ id: 'm-1', family_id: 'fam-1', user_id: 'user-1', role: 'parent', is_active: true, created_at: '2025-01-01T00:00:00Z' }], error: null }
      : table === 'families'
        ? { data: [{ id: 'fam-1', name: 'Fam', timezone: 'UTC' }], error: null }
        : { data: null, error: null })),
};

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => sessionClient,
  createServiceClient: () => serviceClient,
}));
vi.mock('@/lib/server/feature-tiers', () => ({
  getResolvedFeatureTiers: async () => resolveFeatureTiers(state.overrides),
  getFeatureTiersByHref: async () => tiersByHref(resolveFeatureTiers(state.overrides)),
}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); },
  notFound: () => { throw new Error('NOT_FOUND'); },
}));

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const closed = () => { state.family = { trial_ends_at: null, closed_at: PAST }; };
const trialEnded = () => { state.family = { trial_ends_at: PAST, closed_at: null }; };

beforeEach(() => {
  state.family = { trial_ends_at: null, closed_at: null };
  state.subscriptions = [];
  state.overrides = {};
  state.superAdmin = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

async function entitlementFor(href: string) {
  const { resolveFeatureEntitlement } = await import('@/lib/server/feature-entitlement');
  return resolveFeatureEntitlement(serviceClient as never, 'fam-1', href);
}

describe('resolveFeatureEntitlement', () => {
  it('refuses a closed family a Free-tier feature', async () => {
    closed();
    expect(await entitlementFor('/dashboard/chores')).toMatchObject({ allowed: false, reason: 'closed' });
  });

  it('refuses a closed family even while its paid plan runs out', async () => {
    closed();
    state.subscriptions = [{ plan: 'plus', status: 'active' }];
    expect(await entitlementFor('/dashboard/chores')).toMatchObject({ allowed: false, reason: 'closed' });
  });

  it('refuses a trial-ended family a Free-tier feature, needing Family Basic', async () => {
    trialEnded();
    expect(await entitlementFor('/dashboard/chores')).toMatchObject({ allowed: false, reason: 'trial_ended', needLevel: 1 });
  });

  it('names the plan a Plus feature needs to a trial-ended family', async () => {
    trialEnded();
    expect(await entitlementFor('/missions')).toMatchObject({ allowed: false, reason: 'trial_ended', needLevel: 2 });
  });

  // An href outside the catalogue is not gated by tier, but the account's
  // standing is not a tier: a closed account is closed everywhere.
  it('refuses a closed family an href outside the catalogue too', async () => {
    closed();
    expect(await entitlementFor('/dashboard/not-a-catalogued-feature')).toMatchObject({ allowed: false, reason: 'closed' });
    state.family = { trial_ends_at: null, closed_at: null };
    expect(await entitlementFor('/dashboard/not-a-catalogued-feature')).toMatchObject({ allowed: true });
  });

  it('still answers "off" first, so a switched-off feature is never confirmed to exist', async () => {
    closed();
    state.overrides = { 'tasks-chores': 'off' };
    expect(await entitlementFor('/dashboard/chores')).toMatchObject({ allowed: false, reason: 'off' });
  });

  it('leaves a grandfathered Free family, a family in its trial and a paying one alone', async () => {
    expect(await entitlementFor('/dashboard/chores')).toMatchObject({ allowed: true, planLevel: 0 });
    state.family = { trial_ends_at: FUTURE, closed_at: null };
    expect(await entitlementFor('/dashboard/kitchen')).toMatchObject({ allowed: true, planLevel: 1 });
    state.family = { trial_ends_at: PAST, closed_at: null };
    state.subscriptions = [{ plan: 'basic', status: 'active' }];
    expect(await entitlementFor('/dashboard/kitchen')).toMatchObject({ allowed: true, planLevel: 1 });
  });
});

describe('refuseUnlessEntitled, the route gate', () => {
  async function refuse(hrefs: string[]) {
    const { refuseUnlessEntitled } = await import('@/lib/server/route-feature-gate');
    return refuseUnlessEntitled(sessionClient as never, 'fam-1', hrefs);
  }

  it('answers a closed family 403 account_closed', async () => {
    closed();
    const res = await refuse(['/dashboard/assistant']);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ code: 'account_closed', error: expect.stringMatching(/closed/i) });
  });

  it('answers a trial-ended family 403 plan_required with need 1', async () => {
    trialEnded();
    const res = await refuse(['/dashboard/assistant', '/dashboard/chores']);
    expect(res?.status).toBe(403);
    expect(await res!.json()).toMatchObject({ code: 'plan_required', needLevel: 1, error: expect.stringMatching(/trial/i) });
  });

  it('lets a super administrator through, as for any other refusal', async () => {
    closed();
    state.superAdmin = true;
    expect(await refuse(['/dashboard/assistant'])).toBeNull();
  });

  it('lets an open Free family through', async () => {
    expect(await refuse(['/dashboard/assistant'])).toBeNull();
  });
});

describe('requireFeature, the page gate', () => {
  async function page(key: string) {
    const { requireFeature } = await import('@/lib/supabase/auth');
    return requireFeature(key);
  }

  it('sends a closed family to billing, where the closed-account gate offers to reopen', async () => {
    closed();
    const thrown = await page('/dashboard/chores').then(() => null, (e: Error) => e.message);
    expect(thrown).toBe('REDIRECT /dashboard/billing');
  });

  it('sends a trial-ended family to billing to choose a plan', async () => {
    trialEnded();
    const thrown = await page('/dashboard/chores').then(() => null, (e: Error) => e.message);
    expect(thrown).toBe('REDIRECT /dashboard/billing?upgrade=1&need=1');
  });

  it('never sends a refused family from billing to billing', async () => {
    closed();
    await expect(page('/dashboard/billing')).resolves.toMatchObject({ active: { familyId: 'fam-1' } });
    trialEnded();
    await expect(page('/dashboard/billing')).resolves.toMatchObject({ active: { familyId: 'fam-1' } });
  });

  it('lets an open Free family onto a Free page', async () => {
    await expect(page('/dashboard/chores')).resolves.toMatchObject({ active: { familyId: 'fam-1' } });
  });
});

describe('the billing page is not itself plan-gated', () => {
  // The page every refusal lands on. A plan gate here would send a refused
  // family back to the page it was refused from.
  it('calls no plan gate', () => {
    const src = readFileSync('app/(app)/dashboard/billing/page.tsx', 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/requirePlanLevel\(|requireFeature\(|refuseUnlessEntitled\(/);
  });
});

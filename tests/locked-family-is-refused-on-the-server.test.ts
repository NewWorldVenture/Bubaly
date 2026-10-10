// What a family's subscription state allows, read by the real resolvers over an
// in-memory database. Negative controls for three audited gaps:
//  - a trial that ended unpaid was locked only by the (app) layout overlay, so
//    every free-tier API route and the Free AI allowance kept serving it;
//  - past_due (Stripe retrying a failed renewal) dropped a paying family to a
//    paywall whose checkout answered "already subscribed";
//  - resolveEntitlement computed from partial data when a read failed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failing: new Set<string>(),
}));

function fakeDb() {
  return {
    from(table: string) {
      const eqs: [string, unknown][] = [];
      const ins: [string, unknown[]][] = [];
      const rows = () => (h.tables[table] ?? []).filter(r => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c])));
      const answer = (single: boolean) => h.failing.has(table)
        ? { data: null, error: { message: `${table} read failed` } }
        : { data: single ? (rows()[0] ?? null) : rows(), error: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder; },
        in: (c: string, vs: unknown[]) => { ins.push([c, vs]); return builder; },
        maybeSingle: async () => answer(true),
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(answer(false)).then(resolve, reject),
      };
      return builder;
    },
    rpc: async () => ({ data: 0, error: null }),
  };
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => fakeDb(), createServer: async () => fakeDb() }));
vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => false, getUserContext: async () => null }));
vi.mock('@/lib/server/feature-tiers', () => ({
  getFeatureTiersByHref: async () => ({ '/dashboard/assistant': 'free', '/dashboard/kitchen': 'basic' }),
  getResolvedFeatureTiers: async () => ({ 'ai-assistant': 'free', 'smart-kitchen': 'basic' }),
}));

import { resolveEntitlement, subscriptionGrantsPaidLevel, pastDuePaidThrough, PAST_DUE_GRACE_DAYS, PAST_DUE_GRACE_MS } from '@/lib/server/entitlement';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { resolveFeatureEntitlement } from '@/lib/server/feature-entitlement';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { assertAIAccess, AI_ASSISTANT_FEATURE_KEY } from '@/lib/server/ai-access';

const EXPIRED = '2020-01-01T00:00:00Z';
const DAY = 24 * 60 * 60 * 1000;
/** An ISO instant `days` from now (negative is the past). */
const fromNow = (days: number) => new Date(Date.now() + days * DAY).toISOString();
const ctx = { user: { id: 'user-a', email: 'parent@example.test' }, memberships: [],
  active: { familyId: 'family-a', role: 'parent', family: { name: 'Fixture' } } } as never;

function family(trialEndsAt: string | null, subs: Row[] = [], closedAt: string | null = null) {
  h.tables = {
    family_members: [{ user_id: 'user-a', family_id: 'family-a', is_active: true, created_at: '2025-01-01T00:00:00Z' }],
    user_preferences: [{ user_id: 'user-a', active_family_id: 'family-a' }],
    families: [{ id: 'family-a', trial_ends_at: trialEndsAt, closed_at: closedAt }],
    subscriptions: subs.map(s => ({ family_id: 'family-a', ...s })),
  };
}

beforeEach(() => {
  h.failing = new Set();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a trial that ended unpaid is refused by the server, not only the overlay', () => {
  beforeEach(() => family(EXPIRED, [{ plan: 'free', status: 'trialing' }]));

  it('refuses a free-tier feature', async () => {
    expect(await resolveFeatureEntitlement(fakeDb() as never, 'family-a', '/dashboard/assistant'))
      .toMatchObject({ allowed: false, reason: 'locked', code: 'trial_expired' });
  });

  it('answers a free-tier route 403 trial_expired', async () => {
    const refused = await refuseUnlessEntitled(fakeDb() as never, 'family-a', ['/dashboard/assistant']);
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toMatchObject({ code: 'trial_expired' });
  });

  it('gives no Free AI allowance (the mobile bearer path reaches this too)', async () => {
    const access = await assertAIAccess(ctx, { db: fakeDb() as never, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: false, status: 403, code: 'trial_expired' });
  });

  it('refuses a closed account as account_closed', async () => {
    family(null, [], '2026-01-01T00:00:00Z');
    const access = await assertAIAccess(ctx, { db: fakeDb() as never, featureKey: AI_ASSISTANT_FEATURE_KEY });
    expect(access).toMatchObject({ ok: false, code: 'account_closed' });
  });

  it('still serves a grandfathered free family its free features and allowance', async () => {
    family(null, [{ plan: 'free', status: 'trialing' }]);
    expect(await resolveFeatureEntitlement(fakeDb() as never, 'family-a', '/dashboard/assistant')).toMatchObject({ allowed: true });
    expect(await assertAIAccess(ctx, { db: fakeDb() as never, featureKey: AI_ASSISTANT_FEATURE_KEY })).toMatchObject({ ok: true, monthlyAllowance: 10 });
  });

  it('still answers 503 (not a lock) when the plan cannot be read', async () => {
    h.failing.add('families');
    const refused = await refuseUnlessEntitled(fakeDb() as never, 'family-a', ['/dashboard/assistant']);
    expect(refused?.status).toBe(503);
  });
});

describe('past_due keeps the paid level while Stripe retries the renewal', () => {
  // Stripe advanced the period when it renewed, so a monthly past_due row ends
  // ~a month after the renewal that failed. 25 days ahead: that renewal was
  // ~5 days ago, inside the grace.
  beforeEach(() => family(EXPIRED, [{ plan: 'basic', status: 'past_due', current_period_end: fromNow(25) }]));

  it('does not lock the family behind the paywall', async () => {
    expect(await resolveEntitlement(fakeDb() as never, 'user-a')).toMatchObject({ locked: false, effectiveLevel: 1 });
  });

  it('keeps the paid level on the server-side gates', async () => {
    expect(await resolveFamilyPlanLevel(fakeDb() as never, 'family-a')).toBe(1);
  });

  it('still locks once Stripe gives up (unpaid)', async () => {
    family(EXPIRED, [{ plan: 'basic', status: 'unpaid' }]);
    expect(await resolveEntitlement(fakeDb() as never, 'user-a')).toMatchObject({ locked: true });
  });
});

describe('the past_due grace ends 14 days after the renewal that failed', () => {
  it('is a named 14-day constant', () => {
    expect(PAST_DUE_GRACE_DAYS).toBe(14);
    expect(PAST_DUE_GRACE_MS).toBe(14 * DAY);
  });

  it('locks a trial-era family whose past_due outlived the grace', async () => {
    // Renewal ~20 days ago (period ends in ~10): past the 14 days.
    family(EXPIRED, [{ plan: 'basic', status: 'past_due', current_period_end: fromNow(10) }]);
    expect(await resolveEntitlement(fakeDb() as never, 'user-a')).toMatchObject({ locked: true, effectiveLevel: 0 });
    expect(await resolveFamilyPlanLevel(fakeDb() as never, 'family-a')).toBe(0);
    expect(await resolveFeatureEntitlement(fakeDb() as never, 'family-a', '/dashboard/kitchen'))
      .toMatchObject({ allowed: false, reason: 'locked', code: 'trial_expired' });
  });

  it('drops a grandfathered family to Free (not locked) once the grace lapses', async () => {
    family(null, [{ plan: 'plus', status: 'past_due', current_period_end: fromNow(10) }]);
    expect(await resolveEntitlement(fakeDb() as never, 'user-a')).toMatchObject({ locked: false, effectiveLevel: 0 });
  });

  it('does not give an annual plan a year of grace', async () => {
    // An annual row's period end is a year after its failed renewal.
    family(EXPIRED, [{ plan: 'plus_annual', status: 'past_due', current_period_end: fromNow(340) }]);
    expect(await resolveEntitlement(fakeDb() as never, 'user-a')).toMatchObject({ locked: true });
    family(EXPIRED, [{ plan: 'plus_annual', status: 'past_due', current_period_end: fromNow(360) }]);
    expect(await resolveEntitlement(fakeDb() as never, 'user-a')).toMatchObject({ locked: false, effectiveLevel: 2 });
  });

  it('gives a past_due row with no period end no grace', () => {
    expect(subscriptionGrantsPaidLevel({ status: 'past_due', plan: 'basic', current_period_end: null })).toBe(false);
    expect(subscriptionGrantsPaidLevel({ status: 'past_due', plan: 'basic', current_period_end: 'not a date' })).toBe(false);
  });

  it('draws the boundary at exactly renewal + 14 days, in UTC', () => {
    const sub = { status: 'past_due', plan: 'basic', current_period_end: '2026-04-01T00:00:00Z' };
    expect(new Date(pastDuePaidThrough(sub)!).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(subscriptionGrantsPaidLevel(sub, new Date('2026-03-14T23:59:59Z'))).toBe(true);
    expect(subscriptionGrantsPaidLevel(sub, new Date('2026-03-15T00:00:00Z'))).toBe(false);
    // Mar 31 less a month is the last day of February, not Mar 3.
    expect(new Date(pastDuePaidThrough({ plan: 'basic', current_period_end: '2026-03-31T12:00:00Z' })!).toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(new Date(pastDuePaidThrough({ plan: 'basic_annual', current_period_end: '2028-02-29T00:00:00Z' })!).toISOString()).toBe('2027-02-28T00:00:00.000Z');
    // active and trialing are unaffected by any date.
    expect(subscriptionGrantsPaidLevel({ status: 'active', current_period_end: '2000-01-01T00:00:00Z' })).toBe(true);
  });
});

describe('resolveEntitlement never decides on half a read', () => {
  it('does not lock a paying family when the subscriptions read fails', async () => {
    family(EXPIRED, [{ plan: 'plus', status: 'active' }]);
    h.failing.add('subscriptions');
    expect(await resolveEntitlement(fakeDb() as never, 'user-a')).toMatchObject({ locked: false, closed: false });
  });

  it('answers the fail-open fallback, not a computed "grandfathered" family, when the families read fails', async () => {
    family(EXPIRED, [{ plan: 'plus', status: 'active' }]);
    h.failing.add('families');
    // A computed answer would read the paid row and say level 2; the fallback
    // is deliberate and claims nothing.
    expect(await resolveEntitlement(fakeDb() as never, 'user-a')).toMatchObject({ locked: false, effectiveLevel: 0, inTrial: false });
  });
});

// The server half of the strategy metrics, over real tables.
//
// The pure functions in lib/billing/conversion.ts and lib/referrals/core.ts are
// unit-tested against synthetic inputs, and that is exactly how X10 shipped a
// number that could never be anything but 0%: the test fed it timestamps the
// real `subscriptions` column can never produce. This suite reads the tables
// the way the admin report does, with the columns and the values the writers
// actually put there.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { loadStrategyMetrics } from '@/lib/metric/strategy-server';

const NOW = new Date('2026-03-15T12:00:00.000Z');

/** The family-creation instant every `subscriptions.created_at` in this repo carries. */
const FAMILY_CREATED = '2026-01-01T00:00:00.000Z';
const REACHED_FIRST_VALUE = '2026-01-05T00:00:00.000Z';
const WENT_PAID = '2026-01-11T00:00:00.000Z';

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

beforeEach(() => { db = createInMemorySupabase<SupabaseClient<Database>>(); });
afterEach(() => { vi.restoreAllMocks(); });

/**
 * One subscriptions row per family, the way `ensureFamily` and the onboarding
 * action write it: inserted at family creation on the free plan, then UPDATED
 * IN PLACE by the Stripe webhook. `created_at` never moves; `updated_at` does.
 */
function seedFamilyThatLaterPaid(familyId: string, paidUpdatedAt = WENT_PAID) {
  db.seed('subscriptions', [{
    id: `sub-${familyId}`, family_id: familyId, plan: 'family', status: 'active',
    created_at: FAMILY_CREATED, updated_at: paidUpdatedAt,
  }]);
  db.seed('activation_events', [{
    id: `act-${familyId}`, family_id: familyId,
    milestone: 'first_outcome_viewed', created_at: REACHED_FIRST_VALUE,
  }]);
}

describe('X10 · conversion after value, over the real subscriptions shape', () => {
  it('counts a family whose one subscriptions row was created at signup and later went paid', async () => {
    // THE REGRESSION THIS PINS: dating the conversion from `created_at` put the
    // payment before the milestone for EVERY family, so `converted` was 0 by
    // construction and the tile rendered a confident "0%" forever.
    seedFamilyThatLaterPaid('fam-1');

    const metrics = await loadStrategyMetrics(db, NOW);
    expect(metrics.conversion).not.toBeNull();
    expect(metrics.conversion?.families).toBe(1);
    expect(metrics.conversion?.converted).toBe(1);
    expect(metrics.conversion?.rate).toBe(1);
  });

  it('dates the conversion from the billing event when the webhook recorded one', async () => {
    seedFamilyThatLaterPaid('fam-1', '2026-03-01T00:00:00.000Z');   // a later renewal moved updated_at
    db.seed('admin_notifications', [{
      id: 'note-1', kind: 'subscription', related_id: 'fam-1',
      created_at: WENT_PAID,
    }]);

    const metrics = await loadStrategyMetrics(db, NOW);
    expect(metrics.conversion?.converted).toBe(1);
    expect(metrics.conversion?.medianDays).toBe(6);          // 5 Jan → 11 Jan
    expect(metrics.conversion?.medianDaysApproximate).toBe(false);
  });

  it('says the median is approximate when it had to fall back to the row', async () => {
    seedFamilyThatLaterPaid('fam-1');
    const metrics = await loadStrategyMetrics(db, NOW);
    expect(metrics.conversion?.medianDaysApproximate).toBe(true);
  });

  it('still refuses a family that was already paying before it saw an outcome', async () => {
    db.seed('subscriptions', [{
      id: 'sub-early', family_id: 'fam-early', plan: 'family', status: 'active',
      created_at: FAMILY_CREATED, updated_at: '2026-01-02T00:00:00.000Z',
    }]);
    db.seed('activation_events', [{
      id: 'act-early', family_id: 'fam-early',
      milestone: 'first_outcome_viewed', created_at: '2026-02-01T00:00:00.000Z',
    }]);

    const metrics = await loadStrategyMetrics(db, NOW);
    expect(metrics.conversion?.families).toBe(1);
    expect(metrics.conversion?.converted).toBe(0);
    expect(metrics.conversion?.rate).toBe(0);
  });

  it('does not count a family still on the free plan', async () => {
    db.seed('subscriptions', [{
      id: 'sub-free', family_id: 'fam-free', plan: 'free', status: 'trialing',
      created_at: FAMILY_CREATED, updated_at: WENT_PAID,
    }]);
    db.seed('activation_events', [{
      id: 'act-free', family_id: 'fam-free',
      milestone: 'first_outcome_viewed', created_at: REACHED_FIRST_VALUE,
    }]);

    const metrics = await loadStrategyMetrics(db, NOW);
    expect(metrics.conversion?.converted).toBe(0);
  });
});

describe('X12 · the referral coefficient, over the real invites shape', () => {
  it('does not turn accepted member invites into households', async () => {
    // `invites` is scoped to an existing family_id: accepting one adds a member
    // and writes nothing to `families`.
    db.seed('families', [{ id: 'fam-1', name: 'The Only Household' }]);
    db.seed('referrals', []);
    db.seed('invites', [
      { id: 'i1', family_id: 'fam-1', status: 'accepted' },
      { id: 'i2', family_id: 'fam-1', status: 'accepted' },
      { id: 'i3', family_id: 'fam-1', status: 'accepted' },
      { id: 'i4', family_id: 'fam-1', status: 'accepted' },
    ]);

    const metrics = await loadStrategyMetrics(db, NOW);
    expect(metrics.referrals?.households).toBe(1);
    expect(metrics.referrals?.membersInvited).toBe(4);
    expect(metrics.referrals?.joined).toBe(0);
    expect(metrics.referrals?.coefficient).toBe(0);
  });

  it('counts referral rows, which do carry a referred family', async () => {
    db.seed('families', [{ id: 'fam-1' }, { id: 'fam-2' }]);
    db.seed('referrals', [{ id: 'r1', status: 'converted' }, { id: 'r2', status: 'pending' }]);
    db.seed('invites', []);

    const metrics = await loadStrategyMetrics(db, NOW);
    expect(metrics.referrals?.fromReferrals).toBe(1);
    expect(metrics.referrals?.coefficient).toBe(0.5);
  });
});

describe('a failed read is never a zero', () => {
  it('leaves conversion null when the activation ledger does not answer', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    seedFamilyThatLaterPaid('fam-1');
    const original = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      if (table === 'activation_events') {
        return { select: () => ({ eq: () => ({ not: () => ({ limit: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) };
      }
      return original(table as never);
    }) as typeof db.from);

    const metrics = await loadStrategyMetrics(db, NOW);
    expect(metrics.conversion).toBeNull();
    expect(spy).toHaveBeenCalled();
  });
});

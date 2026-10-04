import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { DEFAULT_REFERRAL_CONFIG, REFERRAL_EMAIL_POLICY, referralEmailSendTimes } from '@/lib/referrals/core';

// #771 comment 5983215358. A referral email is limited to 10 a day per
// family, counted from the send stamps on the family's referral rows. The
// count was read, judged and then written, and nothing in front of the action
// rate-limits it: N sends at once each read "under the limit" and N emails
// left the product's domain. A repeat send to one address rewrote that row's
// stamp array from what it had read, so concurrent repeats lost stamps and the
// limit undercounted. These hold every racer's first read at a barrier until
// all of them have it — the interleaving a burst produces.

const REFERRER = '11111111-1111-4111-8111-111111111111';
const T0 = new Date('2026-10-04T12:00:00Z');

const db = createInMemorySupabase({
  defaults: {
    referrals: { status: 'pending', source: 'email', referred_family_id: null, referrer_reward_cents: 0, referred_reward_cents: 0, converted_at: null, rewarded_at: null, metadata: {} },
  },
});
let barrier: { size: number; waiting: number; release: (() => void) | null } | null = null;
let familyReads = 0;

/** The store, with the first `barrier.size` reads of the family's rows held until all have read. */
function client(): SupabaseClient<Database> {
  return {
    from(table: string) {
      const builder = db.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (table !== 'referrals') return builder;
      const select = builder.select.bind(builder);
      builder.select = (cols?: unknown, opts?: unknown) => {
        const q = select(cols, opts) as Record<string, unknown>;
        const qeq = (q.eq as (...a: unknown[]) => unknown).bind(q);
        q.eq = (col: unknown, val: unknown) => {
          const next = qeq(col, val) as Record<string, unknown>;
          if (col !== 'referrer_family_id' || !barrier) return next;
          familyReads += 1;
          if (familyReads > barrier.size) return next;
          const b = barrier;
          const then = (next.then as (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => Promise<unknown>).bind(next);
          next.then = (ok: (v: unknown) => unknown, ko?: (e: unknown) => unknown) => then(async (v: unknown) => {
            b.waiting += 1;
            if (b.waiting === b.size) b.release?.();
            else await new Promise<void>((r) => { const prev = b.release; b.release = () => { prev?.(); r(); }; });
            return ok(v);
          }, ko);
          return next;
        };
        return q;
      };
      return builder;
    },
  } as unknown as SupabaseClient<Database>;
}

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => client(), createServer: async () => client() }));
const { recordReferralEmailInvite } = await import('@/lib/referrals/server');

const stampsOnFile = () => (db.table('referrals') as Record<string, unknown>[])
  .filter((r) => r.referrer_family_id === REFERRER)
  .reduce((n, r) => n + referralEmailSendTimes(r.metadata).length, 0);

function seedSends(n: number) {
  db.seed('referrals', Array.from({ length: n }, (_, i) => ({
    id: `sent-${i}`, code: 'CODE1', referrer_family_id: REFERRER, referred_email: `friend${i}@example.com`,
    metadata: { email_sent_at: [new Date(T0.getTime() - (i + 1) * 60_000).toISOString()] },
    updated_at: `2026-10-04T10:00:0${i % 10}.000Z`,
  })));
}

const send = (email: string, at = T0) => recordReferralEmailInvite(client(), {
  referrerFamilyId: REFERRER, code: 'CODE1', email, config: DEFAULT_REFERRAL_CONFIG, now: at,
});

beforeEach(() => {
  db.reset();
  barrier = null;
  familyReads = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the referral email limit holds under concurrent sends', () => {
  it('three sends racing at 9 of 10 leave the family at the limit, never past it', async () => {
    seedSends(REFERRAL_EMAIL_POLICY.limit - 1);
    barrier = { size: 3, waiting: 0, release: null };
    const results = await Promise.all([send('a@example.com'), send('b@example.com'), send('c@example.com')]);
    const sent = results.filter((r) => r.ok).length;
    expect(stampsOnFile()).toBeLessThanOrEqual(REFERRAL_EMAIL_POLICY.limit);
    // Every send told "go" is on file, and every refused one left nothing behind.
    expect(stampsOnFile()).toBe(REFERRAL_EMAIL_POLICY.limit - 1 + sent);
    for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ ok: false, reason: 'throttled' });
  });

  it('two repeat sends to the same address both stay counted', async () => {
    db.seed('referrals', [{
      id: 'friend', code: 'CODE1', referrer_family_id: REFERRER, referred_email: 'friend@example.com',
      metadata: { email_sent_at: [] }, updated_at: '2026-10-04T09:00:00.000Z',
    }]);
    barrier = { size: 2, waiting: 0, release: null };
    const results = await Promise.all([
      send('friend@example.com', T0),
      send('friend@example.com', new Date(T0.getTime() + 1000)),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(stampsOnFile()).toBe(2);
  });

  it('control: under the limit a send is recorded once and reports what is left', async () => {
    seedSends(3);
    const r = await send('new@example.com');
    expect(r).toMatchObject({ ok: true, created: true, remaining: REFERRAL_EMAIL_POLICY.limit - 4 });
    expect(stampsOnFile()).toBe(4);
  });

  it('control: at the limit the pre-check refuses without writing', async () => {
    seedSends(REFERRAL_EMAIL_POLICY.limit);
    const before = (db.table('referrals') as unknown[]).length;
    const r = await send('late@example.com');
    expect(r).toMatchObject({ ok: false, reason: 'throttled' });
    expect((db.table('referrals') as unknown[]).length).toBe(before);
  });
});

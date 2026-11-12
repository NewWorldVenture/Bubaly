// Call-level tests for app/reviews/new/actions.ts (audit Register B, group 8).
//
// /reviews/new is public, so the callers are a signed-out visitor, a signed-in
// person with no household yet, and signed-in members of household A in each
// role. The policy (the action's own comment, audit N4): everyone may submit;
// a stranger's review is always written PENDING; only a signed-in Bubaly
// user's review may clear the admin's auto-approve threshold. Reviews belong
// to no household and the action takes no id, so there is no cross-family
// argument to forge — the cross-family check here is that a review is never
// written as anything but a new, own row.
//
// Pinned for: signed-out, no household, parent, adult, caregiver, guest.
// NOT pinned for a teen or a child (kid login): the action fast-tracks any
// signed-in account and no source says whether a minor's review may go to the
// public wall unmoderated (PR body, "Needs an owner decision").
//
// Who is signed in comes from the real signedInUserId -> getUser chain; only
// the cookie client underneath is stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, user: null as null | { id: string }, epoch: 0, ip: '203.0.113.30' }));
vi.mock('@/lib/server/rate-limit', async (original) => {
  const real = await original<typeof import('@/lib/server/rate-limit')>();
  return { ...real, rateLimit: (key: string, opts?: Parameters<typeof real.rateLimit>[1]) => real.rateLimit(`${h.epoch}:${key}`, opts) };
});
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  createServer: async () => ({ auth: { getUser: async () => ({ data: { user: h.user }, error: null }) } }),
}));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': h.ip }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { submitReviewAction } = await import('@/app/reviews/new/actions');

const FAMILY_A_USER = (role: string) => `a0000000-0000-4000-8000-0000000001${String(['parent', 'adult', 'caregiver', 'guest'].indexOf(role)).padStart(2, '0')}`;
const NEWCOMER = 'c0000000-0000-4000-8000-0000000000c1';
let db: InMemorySupabase;
const reviews = () => db.table('reviews');
const EXISTING = { id: 'b0000000-0000-4000-8000-0000000007b1', rating: 2, title: 'Household B wrote this', body: 'Not for me.', status: 'pending', deleted_at: null, metadata: {} };

beforeEach(() => {
  h.epoch++;
  h.user = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } });
  db.seed('reputation_settings', [{ singleton: true, auto_approve_min: 4 }]);
  db.seed('reviews', [EXISTING]);
  h.db = db;
});
afterEach(() => { vi.restoreAllMocks(); });

const review = { rating: 5, title: 'Calmer mornings', body: 'The shared list helps.', name: 'Pat Example', email: 'pat@example.com' };
const written = () => reviews().filter((r) => r.id !== EXISTING.id);

describe('submitReviewAction answers every visitor', () => {
  it('ACTION-B46855B1C594 a signed-out visitor is written pending, however high the rating', async () => {
    await expect(submitReviewAction(review)).resolves.toEqual({ ok: true });
    expect(written()).toEqual([expect.objectContaining({
      rating: 5, title: 'Calmer mornings', author_name: 'Pat Example', author_email: 'pat@example.com',
      status: 'pending', deleted_at: null, source: 'internal',
    })]);
  });

  it.each([['a person with no household', NEWCOMER], ...['parent', 'adult', 'caregiver', 'guest'].map((role) => [`a ${role} of A`, FAMILY_A_USER(role)])])(
    'ACTION-B46855B1C594 %s clears the threshold and is published', async (_label, userId) => {
      h.user = { id: userId };
      await expect(submitReviewAction(review)).resolves.toEqual({ ok: true });
      expect(written()).toEqual([expect.objectContaining({ rating: 5, title: 'Calmer mornings', status: 'approved', deleted_at: null })]);
    });

  it('ACTION-B46855B1C594 a signed-in review below the threshold still waits', async () => {
    h.user = { id: FAMILY_A_USER('parent') };
    await expect(submitReviewAction({ ...review, rating: 3 })).resolves.toEqual({ ok: true });
    expect(written()).toEqual([expect.objectContaining({ rating: 3, status: 'pending' })]);
  });

  it('ACTION-B46855B1C594 an out-of-range rating is refused and writes nothing, signed in or not', async () => {
    await expect(submitReviewAction({ ...review, rating: 9 })).resolves.toEqual({ ok: false, error: 'actions.pleaseChooseAStarRating' });
    h.user = { id: FAMILY_A_USER('parent') };
    await expect(submitReviewAction({ ...review, rating: 0 })).resolves.toEqual({ ok: false, error: 'actions.pleaseChooseAStarRating' });
    expect(written()).toEqual([]);
  });

  it("ACTION-B46855B1C594 a submission never touches another family's existing review", async () => {
    h.user = { id: FAMILY_A_USER('parent') };
    // Even with that review's id smuggled into the payload, a new row is written.
    await expect(submitReviewAction({ ...review, id: EXISTING.id } as typeof review)).resolves.toEqual({ ok: true });
    expect(reviews().find((r) => r.id === EXISTING.id)).toMatchObject({ title: 'Household B wrote this', status: 'pending', rating: 2 });
    expect(written()).toHaveLength(1);
  });
});

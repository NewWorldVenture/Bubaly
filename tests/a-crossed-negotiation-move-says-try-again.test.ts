import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A negotiation move that crossed the other side's says so and asks for a
 * retry (MT-2, its app half).
 *
 * marketplace_negotiation_offer locks the listing and then the thread;
 * marketplace_negotiation_respond locks the thread and then the listing
 * (0483). A buyer's counter crossing the seller's decline on one thread can
 * deadlock, and Postgres aborts one of them with 40P01. Nothing was written
 * and a retry succeeds, but the action answered the generic "Could not send
 * the offer" / "Could not respond to the offer". Now the person is told the
 * other side acted at the same moment. Ordering both functions' locks the
 * same way (listing, then thread) is the owner's SQL.
 */
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const harness = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' }, memberships: [],
    active: { familyId: 'fam-1', role: 'parent', member: { id: 'm-self', family_id: 'fam-1' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { makeOfferAction, respondToOfferAction } = await import('@/app/(app)/marketplace/negotiations/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

let db: InMemorySupabase;
const failWith = (code: string, message: string) => {
  (db as unknown as { rpc: unknown }).rpc = async () => ({ data: null, error: { code, message, details: null, hint: null }, count: null, status: 500, statusText: 'Error' });
};

beforeEach(() => {
  db = createInMemorySupabase();
  harness.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a negotiation move aborted by a deadlock', () => {
  it('the buyer\'s counter is told the other side acted at the same moment', async () => {
    failWith('40P01', 'deadlock detected');
    expect(await makeOfferAction({ listingId: 'l-1', amountCents: 5_000 }))
      .toEqual({ ok: false, error: t('negotiations.theOtherSideActedAtTheSameMoment') });
  });

  it('the seller\'s decline is told the same', async () => {
    failWith('40P01', 'deadlock detected');
    expect(await respondToOfferAction({ negotiationId: 'n-1', action: 'decline' }))
      .toEqual({ ok: false, error: t('negotiations.theOtherSideActedAtTheSameMoment') });
  });

  it('a serialization failure reads the same', async () => {
    failWith('40001', 'could not serialize access due to concurrent update');
    expect(await respondToOfferAction({ negotiationId: 'n-1', action: 'accept' }))
      .toEqual({ ok: false, error: t('negotiations.theOtherSideActedAtTheSameMoment') });
  });

  it('control: any other failure is still the generic one, without the database\'s words', async () => {
    failWith('XX000', 'internal error in marketplace_negotiation_respond');
    expect(await respondToOfferAction({ negotiationId: 'n-1', action: 'decline' }))
      .toEqual({ ok: false, error: t('negotiations.couldNotRespondToTheOffer') });
  });
});

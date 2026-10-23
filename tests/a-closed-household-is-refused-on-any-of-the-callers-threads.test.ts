// A closed household is refused on any of the caller's threads, not only the
// active household's (N7-S2).
//
// respondToOfferAction refuses an accept or a counter with a household that
// closed. It read the thread with `or(eitherPartyFamily(active))`, and a thread
// that read did not return skipped the standing check and went straight to
// marketplace_negotiation_respond. That RPC finds the caller through
// marketplace_member_id (0154), which answers for ANY family the user belongs
// to — so a parent active in A, who is also in C, could accept C's thread with
// a seller B that had closed, and the RPC made the confirmed order with B. The
// read now covers every household the caller belongs to.
//
// Driven through the real action against the in-memory database; the RPC is
// modelled to settle whatever reaches it, as the real one would.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const HOUR = 3_600_000;
const harness = vi.hoisted(() => ({ db: null as unknown, rpcs: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => harness.db, createServer: async () => harness.db }));
vi.mock('@/lib/supabase/auth', () => {
  const membership = (familyId: string) => ({ familyId, role: 'parent', member: { id: `m-${familyId}`, family_id: familyId } });
  return {
    // Active in A; also a parent in C, the buyer household on the thread below.
    requireUserContext: async () => ({
      user: { id: 'user-parent' }, memberships: [membership('fam-a'), membership('fam-c')], active: membership('fam-a'),
    }),
  };
});
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { respondToOfferAction } = await import('@/app/(app)/marketplace/negotiations/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const closedNotice = translate(SOURCE_MESSAGES, 'actions.thisFamilyHasClosedItsAccount');

let db: InMemorySupabase;

/** A thread C's buyer opened on B's desk, countered by B: C's turn to accept or counter. */
const thread = (id: string, sellerFamily: string, buyerFamily: string): Row => ({
  id, family_id: sellerFamily, listing_id: `desk-${sellerFamily}`, buyer_member_id: `m-${buyerFamily}`, buyer_family_id: buyerFamily,
  status: 'open', current_amount_cents: 7_000, last_actor: 'seller', rounds_count: 2,
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  harness.rpcs = [];
  db = createInMemorySupabase({
    rpc: {
      marketplace_negotiation_respond: (args: Record<string, unknown>) => {
        harness.rpcs.push(`marketplace_negotiation_respond:${String(args.p_action)}`);
        if (args.p_action === 'accept') db.seed('marketplace_orders', [{ id: 'order-agreed', negotiation_id: args.p_negotiation }]);
        return args.p_action === 'accept' ? { ok: true, status: 'agreed', order_id: 'order-agreed' } : { ok: true, status: 'open' };
      },
    },
  });
  db.seed('families', [
    { id: 'fam-a', name: 'Active House', closed_at: null },
    { id: 'fam-c', name: 'Other House', closed_at: null },
    { id: 'fam-b', name: 'Closed Seller', closed_at: new Date(Date.now() - HOUR).toISOString() },
    { id: 'fam-d', name: 'Open Seller', closed_at: null },
  ]);
  db.seed('marketplace_listings', ['fam-b', 'fam-d'].map((familyId) => ({
    id: `desk-${familyId}`, title: 'Desk', family_id: familyId, kind: 'sell', sale_format: 'fixed', status: 'available', price_cents: 8_000,
  })));
  db.seed('marketplace_negotiations', [thread('neg-closed-seller', 'fam-b', 'fam-c'), thread('neg-open-seller', 'fam-d', 'fam-c')]);
  harness.db = db;
});

describe('a thread of the caller\'s other household', () => {
  it('refuses the accept — a confirmed order — and the counter with a seller that closed, before the RPC runs', async () => {
    expect(await respondToOfferAction({ negotiationId: 'neg-closed-seller', action: 'accept' })).toEqual({ ok: false, error: closedNotice });
    expect(await respondToOfferAction({ negotiationId: 'neg-closed-seller', action: 'counter', amountCents: 7_500 }))
      .toEqual({ ok: false, error: closedNotice });
    expect(harness.rpcs).toEqual([]);
    expect(db.table('marketplace_orders')).toEqual([]);
  });

  it('still reaches the RPC with an open seller (control)', async () => {
    expect(await respondToOfferAction({ negotiationId: 'neg-open-seller', action: 'accept' }))
      .toEqual({ ok: true, data: { status: 'agreed', orderId: 'order-agreed' } });
    expect(harness.rpcs).toEqual(['marketplace_negotiation_respond:accept']);
  });

  it('still lets the caller end it: decline and withdraw reach the RPC', async () => {
    expect((await respondToOfferAction({ negotiationId: 'neg-closed-seller', action: 'withdraw' })).ok).toBe(true);
    expect(harness.rpcs).toEqual(['marketplace_negotiation_respond:withdraw']);
  });
});

import { describe, expect, it, beforeEach, vi } from 'vitest';
import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { cardMirrorFromStripe, handleIssuingCardUpdated } from '@/lib/stripe/webhook';

// lib/stripe/issuing.ts changes a card in two steps: the Stripe update, which is
// awaited and whose failure reaches the caller, and then our MIRROR of it, whose
// result was discarded. Nothing reconciled the two — the money webhook handled
// issuing_transaction.created, issuing_authorization.updated and account.updated,
// and issuing_card.* fell through to `default`. So a refused mirror write left
// /wallet showing a spend limit the card no longer had, or a freeze state it no
// longer had, permanently, while the toast the parent had just seen said
// otherwise.
//
// Stripe is the authority here: it is what actually declines a purchase. These
// assert that our copy now follows it.

const CARD_ROW = 'c0000000-0000-4000-8000-000000000001';
const STRIPE_CARD = 'ic_test_123';

// Only the fields the reconciler reads. Stripe's own Card type demands a full
// SpendingControls (six more fields this mapping never touches), so typing the
// overrides as Partial<Card> forced a cast at every call site — and those casts
// are what tsc rejected. Naming the shape the fixture actually builds keeps the
// call sites plain and says what the mapping depends on.
type CardOverrides = {
  status?: Stripe.Issuing.Card['status'];
  spending_controls?: {
    spending_limits?: { amount: number; interval: string }[];
    blocked_categories?: string[];
  };
};

function stripeCard(over: CardOverrides = {}): Stripe.Issuing.Card {
  return {
    id: STRIPE_CARD,
    status: 'active',
    spending_controls: { spending_limits: [], blocked_categories: [] },
    ...over,
  } as unknown as Stripe.Issuing.Card;
}

function mirrorRow(over: Row = {}): Row {
  return {
    id: CARD_ROW, family_id: 'fam-1', child_wallet_id: 'w-1', cardholder_id: 'ch-1',
    stripe_card_id: STRIPE_CARD, type: 'virtual', status: 'active',
    spend_limit_cents: 2000, spend_window: 'weekly', blocked_categories: [], is_frozen: false,
    ...over,
  };
}

describe('the card mirror follows Stripe', () => {
  let db: ReturnType<typeof createInMemorySupabase>;
  let client: SupabaseClient<Database>;
  beforeEach(() => {
    db = createInMemorySupabase();
    client = db as unknown as SupabaseClient<Database>;
  });

  it('a freeze made at Stripe reaches a mirror that missed it', async () => {
    // The exact divergence: Stripe froze the card, our row still says spendable.
    db.seed('stripe_issuing_cards', [mirrorRow({ is_frozen: false, status: 'active' })]);
    await handleIssuingCardUpdated(client, stripeCard({ status: 'inactive' }));
    const [row] = db.table('stripe_issuing_cards');
    expect(row.is_frozen).toBe(true);
    expect(row.status).toBe('inactive');
  });

  it('a CANCELED card is not displayed as spendable', () => {
    // is_frozen is derived, not mirrored: Stripe has three statuses and the
    // product has a boolean. Reading it as `status === 'inactive'` would leave a
    // cancelled card looking usable, which is the failure being fixed.
    expect(cardMirrorFromStripe(stripeCard({ status: 'canceled' })).is_frozen).toBe(true);
    expect(cardMirrorFromStripe(stripeCard({ status: 'inactive' })).is_frozen).toBe(true);
    expect(cardMirrorFromStripe(stripeCard({ status: 'active' })).is_frozen).toBe(false);
  });

  it('a spend limit the card no longer has is corrected', async () => {
    db.seed('stripe_issuing_cards', [mirrorRow({ spend_limit_cents: 2000, spend_window: 'weekly' })]);
    await handleIssuingCardUpdated(client, stripeCard({
      spending_controls: { spending_limits: [{ amount: 50_000, interval: 'monthly' }], blocked_categories: ['gambling'] },
    }));
    const [row] = db.table('stripe_issuing_cards');
    expect(row.spend_limit_cents).toBe(50_000);
    expect(row.spend_window).toBe('monthly');
    expect(row.blocked_categories).toEqual(['gambling']);
  });

  it('no limit at Stripe is no limit here, and a zero limit is not "unlimited"', () => {
    expect(cardMirrorFromStripe(stripeCard()).spend_limit_cents).toBeNull();
    // `|| null` would turn a deliberate zero — spend nothing — into no limit at all.
    const zero = cardMirrorFromStripe(stripeCard({
      spending_controls: { spending_limits: [{ amount: 0, interval: 'daily' }], blocked_categories: [] },
    }));
    expect(zero.spend_limit_cents).toBe(0);
    expect(zero.spend_window).toBe('daily');
  });

  it('applying the same event twice writes the same row', async () => {
    db.seed('stripe_issuing_cards', [mirrorRow()]);
    const card = stripeCard({ status: 'inactive' });
    await handleIssuingCardUpdated(client, card);
    const first = { ...db.table('stripe_issuing_cards')[0] };
    await handleIssuingCardUpdated(client, card);
    expect(db.table('stripe_issuing_cards')[0]).toEqual(first);
  });

  it('a card this deployment does not mirror is skipped, not retried forever', async () => {
    db.seed('stripe_issuing_cards', []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Throwing would return 500 and make Stripe retry an event that can never
    // succeed. A family may hold cards this deployment never issued.
    await expect(handleIssuingCardUpdated(client, stripeCard())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a failed lookup is retried rather than read as an absent card', async () => {
    const failing = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '08006', message: 'down' } }) }) }),
      }),
    } as unknown as SupabaseClient<Database>;
    // "could not ask" and "is not there" take opposite branches, and only one of
    // them should make Stripe try again.
    await expect(handleIssuingCardUpdated(failing, stripeCard())).rejects.toThrow(/lookup failed/);
  });

  it('a failed mirror write is reported, never swallowed', async () => {
    const failing = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: CARD_ROW }, error: null }) }) }),
        update: () => ({ eq: async () => ({ data: null, error: { code: '42501', message: 'denied' } }) }),
      }),
    } as unknown as SupabaseClient<Database>;
    // This handler exists BECAUSE a discarded write error left the mirror wrong.
    await expect(handleIssuingCardUpdated(failing, stripeCard())).rejects.toThrow(/mirror update failed/);
  });
});

describe('the money webhook actually routes the card events', () => {
  it('issuing_card.created and .updated reach the reconciler', async () => {
    const { readFileSync } = await import('node:fs');
    const route = readFileSync('app/api/webhooks/money/route.ts', 'utf8');
    // Without the dispatch the handler is unreachable and the mirror stays stale
    // — the defect, with a fix sitting next to it.
    expect(route).toContain("case 'issuing_card.updated':");
    expect(route).toContain("case 'issuing_card.created':");
    expect(route).toContain('handleIssuingCardUpdated(supabase');
  });

  it('the mirror writes in issuing.ts no longer discard their error', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync('lib/stripe/issuing.ts', 'utf8');
    const discarded = /\n  await supabase\n    \.from\('stripe_issuing_cards'\)\n    \.update\(/.test(src);
    expect(discarded, 'a mirror write is back to discarding its result').toBe(false);
    // Re-pointed under C1-S9-64 from the exact `const { error }`, which went red
    // when both writes also began asking for their row. The intent — neither
    // mirror write discards its result — is any destructure that keeps `error`.
    // Anchored on `.update(`: widening the destructure also admitted a READ from
    // the same table, which the exact form had excluded only by accident.
    expect((src.match(/const \{[^}]*\berror\b[^}]*\} = await supabase\s*\n\s*\.from\('stripe_issuing_cards'\)\s*\n\s*\.update\(/g) ?? []).length).toBe(2);
  });
});

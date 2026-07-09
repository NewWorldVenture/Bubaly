import { describe, it, expect } from 'vitest';
import { loadMemberTrust, loadCheckoutQuote } from '@/lib/marketplace/server';

// Minimal thenable query stub: .select()/.eq() chain, awaits to a canned result.
// .maybeSingle() resolves to the same canned result (data already single/null).
function fakeQuery(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = () => Promise.resolve(result);
  q.then = (resolve: (r: unknown) => unknown) => resolve(result);
  return q;
}
function fakeDb(byTable: Record<string, { data: unknown; error: unknown }>) {
  return { from: (t: string) => fakeQuery(byTable[t] ?? { data: [], error: null }) } as never;
}

describe('loadMemberTrust', () => {
  it('returns safe empties when no member/user id is given', async () => {
    const p = await loadMemberTrust(fakeDb({}), { familyId: 'f1' });
    expect(p.reviews.count).toBe(0);
    expect(p.trust.score).toBeLessThan(30);
  });

  it('aggregates real reviews + verifications into a trust profile', async () => {
    const db = fakeDb({
      marketplace_reviews: { data: [
        { rating: 5, role: 'buyer', body: 'great', created_at: '2026-03-01' },
        { rating: 4, role: 'buyer', body: 'good', created_at: '2026-02-01' },
        { rating: 5, role: 'buyer', body: 'ok', created_at: '2026-01-01' },
      ], error: null },
      marketplace_verifications: { data: [
        { kind: 'identity', status: 'verified' },
        { kind: 'email', status: 'verified' },
        { kind: 'nonsense', status: 'verified' }, // ignored
      ], error: null },
    });
    const p = await loadMemberTrust(db, { familyId: 'f1', userId: 'u1', memberId: 'm1', signals: { completedTransactions: 8 } });
    expect(p.reviews.count).toBe(3);
    expect(p.reviews.averageRating).toBeCloseTo(4.7, 1);
    expect(p.trust.badges).toContain('id_verified');
    expect(p.trust.badges).toContain('repeat_seller'); // 8 completed
    expect(p.trust.score).toBeGreaterThan(40);
  });

  it('degrades to empties on a read error', async () => {
    const db = fakeDb({
      marketplace_reviews: { data: null, error: { message: 'boom' } },
      marketplace_verifications: { data: null, error: { message: 'boom' } },
    });
    const p = await loadMemberTrust(db, { familyId: 'f1', userId: 'u1', signals: { completedTransactions: 5 } });
    expect(p.reviews.count).toBe(0);
    // Falls back to signals-only trust (no reviews/verifications), still computes.
    expect(p.trust.badges).toContain('repeat_seller');
  });
});

describe('loadCheckoutQuote', () => {
  it('quotes fees using the family commission setting', async () => {
    const db = fakeDb({
      marketplace_listings: { data: { id: 'l1', title: 'Bike', price_cents: 10_000, category: 'sports' }, error: null },
      marketplace_settings: { data: { commission_bps: 500, default_currency: 'USD' }, error: null }, // 5%
    });
    const q = await loadCheckoutQuote(db, { familyId: 'f1', listingId: 'l1' });
    expect(q).not.toBeNull();
    expect(q!.listing.title).toBe('Bike');
    expect(q!.breakdown.marketplaceFeeCents).toBe(500); // 5% of $100
    expect(q!.breakdown.buyerTotalCents).toBe(10_000 + q!.breakdown.serviceFeeCents);
  });

  it('falls back to the default commission when settings are absent', async () => {
    const db = fakeDb({
      marketplace_listings: { data: { id: 'l1', title: 'Bike', price_cents: 10_000, category: 'sports' }, error: null },
      marketplace_settings: { data: null, error: null },
    });
    const q = await loadCheckoutQuote(db, { familyId: 'f1', listingId: 'l1' });
    expect(q!.breakdown.marketplaceFeeCents).toBe(1000); // default 10%
    expect(q!.listing.currency).toBe('USD');
  });

  it('returns null when the listing is gone', async () => {
    const db = fakeDb({
      marketplace_listings: { data: null, error: null },
      marketplace_settings: { data: null, error: null },
    });
    expect(await loadCheckoutQuote(db, { familyId: 'f1', listingId: 'nope' })).toBeNull();
  });
});

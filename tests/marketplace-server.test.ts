import { describe, it, expect } from 'vitest';
import { loadMemberTrust } from '@/lib/marketplace/server';

// Minimal thenable query stub: .select()/.eq() chain, awaits to a canned result.
function fakeQuery(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
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

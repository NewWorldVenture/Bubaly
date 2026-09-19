// `payChoreRewardAction` states the invariant in its own comment — "one wallet
// credit per assignment" — and enforced it with a SELECT followed by an INSERT.
// Nothing in the schema backed it, so two "Pay" clicks arriving together both
// read zero rows and both credited the child's wallet. 0316 adds the partial
// unique index that makes the invariant true rather than likely.
//
// This pins the other half: the loser of that race must come back as the thing
// it is. A raw "23505 duplicate key value violates unique constraint
// uq_wallet_txn_chore_payout" shown to a parent is a regression of a different
// kind — the money is correct and the message is not.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { creditChildWallet } from '@/lib/wallet/server';

vi.mock('server-only', () => ({}));

type DB = SupabaseClient<Database>;

/** A client whose wallet_transactions insert answers with a scripted error. */
function client(insertError: { code?: string; message: string } | null) {
  const from = (table: string) => {
    const q: Record<string, unknown> = {
      select: () => q, eq: () => q, in: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: () => Promise.resolve({ error: insertError }),
      then: (resolve: (v: unknown) => unknown) => resolve(
        table === 'wallet_buckets'
          ? { data: [
              { id: 'b-spend', kind: 'spend' }, { id: 'b-save', kind: 'save' },
              { id: 'b-give', kind: 'give' }, { id: 'b-invest', kind: 'invest' },
            ], error: null }
          : { data: null, error: null },
      ),
    };
    return q;
  };
  return { from } as unknown as DB;
}

const params = {
  familyId: 'fam-1', childWalletId: 'cw-1', amountCents: 4000,
  type: 'chore_reward' as const, description: 'Chore: dishes', createdBy: 'user-1',
  relatedType: 'chore_assignments', relatedId: 'assignment-1',
};

describe('a chore payout refused by the ledger reads as already paid', () => {
  it('reports a unique violation as a duplicate, not a database error', async () => {
    const res = await creditChildWallet(
      client({ code: '23505', message: 'duplicate key value violates unique constraint "uq_wallet_txn_chore_payout"' }),
      params,
    );
    expect(res.ok).toBe(false);
    expect(res.duplicate).toBe(true);
    expect(res.credited).toBe(0);
    // The message a parent would see carries no constraint name.
    expect(res.error).not.toContain('uq_wallet_txn_chore_payout');
    expect(res.error).toMatch(/already been paid/i);
  });

  it('does not call every other failure a duplicate', async () => {
    // The control. A flag that were always true would pass the case above and
    // would turn a real storage outage into "already paid" — telling a parent
    // their child was paid when nothing was written.
    const res = await creditChildWallet(
      client({ code: '42501', message: 'permission denied for table wallet_transactions' }),
      params,
    );
    expect(res.ok).toBe(false);
    expect(res.duplicate).toBe(false);
  });

  it('leaves a successful credit alone', async () => {
    const res = await creditChildWallet(client(null), params);
    expect(res.ok).toBe(true);
    expect(res.duplicate).toBeUndefined();
    expect(res.credited).toBe(4000);
  });
});

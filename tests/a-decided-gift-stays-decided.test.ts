import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Declining a gift cannot undo an approval. (DATA-017)
 *
 * `dismissGiftAction` set `status = 'cancelled'` with no condition on the
 * status. The gift screen offers Approve and Decline side by side, so a second
 * parent — or one parent on a stale page — could decline a gift that had
 * already been credited. Measured on the local database with the exact
 * statements, as a parent session: `wallet_approve_gift` credited 5,000 cents,
 * then the decline updated 1 row and the gift read "cancelled" with the credit
 * still in the ledger.
 *
 * The double applies every filter to the row as it is when the write runs,
 * which is what makes the missing condition observable.
 */

type Gift = { id: string; family_id: string; status: string };
const store = vi.hoisted(() => ({ gifts: [] as Array<{ id: string; family_id: string; status: string }> }));

function gifts() {
  const filters: Array<[string, unknown]> = [];
  let patch: Partial<Gift> | null = null;
  const run = () => {
    const hits = store.gifts.filter((g) => filters.every(([column, value]) => g[column as keyof Gift] === value));
    if (patch) { for (const g of hits) Object.assign(g, patch); return { data: hits[0] ? { id: hits[0].id } : null, error: null }; }
    return { data: hits[0] ? { ...hits[0] } : null, error: null };
  };
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return chain; },
    update: (value: Partial<Gift>) => { patch = value; return chain; },
    maybeSingle: async () => run(),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
  };
  return chain;
}

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'parent-user' }, active: { familyId: 'family-1', role: 'parent', member: { id: 'parent-1' } } }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ from: (table: string) => { if (table !== 'gift_payments') throw new Error(`unexpected ${table}`); return gifts(); } }),
  createServiceClient: () => { throw new Error('not used'); },
}));

import { dismissGiftAction } from '@/app/(app)/wallet/actions';

const decline = () => dismissGiftAction({ giftPaymentId: 'gift-1' });
const status = () => store.gifts[0].status;

beforeEach(() => { store.gifts = [{ id: 'gift-1', family_id: 'family-1', status: 'pending' }]; });

describe('the control: a pending gift can be declined', () => {
  it('declines it', async () => {
    expect(await decline()).toEqual({ ok: true });
    expect(status()).toBe('cancelled');
  });

  it('treats declining it twice as declined', async () => {
    await decline();
    expect(await decline()).toEqual({ ok: true });
    expect(status()).toBe('cancelled');
  });
});

describe('a gift already credited stays credited', () => {
  it('refuses to decline an approved gift and leaves it completed', async () => {
    store.gifts[0].status = 'completed';
    expect(await decline()).toEqual({ ok: false, error: 'actions.thisGiftWasAlreadyApplied' });
    expect(status()).toBe('completed');
  });

  it('does not touch another family\'s gift', async () => {
    store.gifts[0].family_id = 'family-2';
    expect(await decline()).toEqual({ ok: false, error: 'actions.giftNotFound' });
    expect(status()).toBe('pending');
  });
});

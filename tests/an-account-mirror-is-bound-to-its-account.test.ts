// The connected-account mirror follows the account it was retrieved for, not
// whichever family the account's metadata names (audit N12).
//
// The money webhook's `account.updated` handler took the family from
// `acct.metadata.family_id` and updated `stripe_connected_accounts` filtered on
// family_id alone, with state read from the account the event was about. The
// table is unique on each column, so an account carrying another family's
// metadata — a Dashboard edit, an orphan from a failed persist — overwrote that
// family's onboarding/capability mirror with the wrong account's state, and the
// event was marked processed. Driven through the real service and the real
// webhook against the in-memory database, with Stripe replaced: a mismatch
// changes no row and is a logged skip; the family's own account still mirrors.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const stripe = vi.hoisted(() => ({ accounts: new Map<string, Record<string, unknown>>(), event: null as unknown }));
vi.mock('@/lib/stripe', () => ({
  getStripe: () => ({ accounts: { retrieve: async (id: string) => {
    const account = stripe.accounts.get(id);
    if (!account) throw new Error(`No such account: ${id}`);
    return account;
  } } }),
  constructWebhookEvent: () => stripe.event,
}));
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { syncConnectedAccount } from '@/lib/stripe/connect';

const FAMILY_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FAMILY_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type Db = ReturnType<typeof createInMemorySupabase>;
let db: Db;
const client = () => db as unknown as SupabaseClient<Database>;
const mirror = (familyId: string) => db.table('stripe_connected_accounts').find((row) => row.family_id === familyId)!;

function account(id: string, enabled: boolean, metadata: Record<string, string> = {}) {
  return {
    id, object: 'account', charges_enabled: enabled, payouts_enabled: enabled, details_submitted: true,
    capabilities: { treasury: enabled ? 'active' : 'inactive', card_issuing: 'inactive' },
    requirements: { currently_due: [], disabled_reason: null }, metadata,
  };
}

beforeEach(() => {
  db = createInMemorySupabase({ uniques: { stripe_connected_accounts: [['family_id'], ['stripe_account_id']], stripe_webhook_events: [['stripe_event_id']] } });
  db.seed('stripe_connected_accounts', [
    { id: 'row-a', family_id: FAMILY_A, stripe_account_id: 'acct_A', status: 'pending', charges_enabled: false, payouts_enabled: false, treasury_enabled: false },
    { id: 'row-b', family_id: FAMILY_B, stripe_account_id: 'acct_B', status: 'pending', charges_enabled: false, payouts_enabled: false, treasury_enabled: false },
  ]);
  h.db = db;
  stripe.accounts.clear();
  stripe.accounts.set('acct_A', account('acct_A', true));
  stripe.accounts.set('acct_B', account('acct_B', false));
  vi.stubEnv('STRIPE_MONEY_WEBHOOK_SECRET', 'whsec_synthetic');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('syncConnectedAccount', () => {
  it('writes nothing when the family does not own the account, and says so', async () => {
    expect(await syncConnectedAccount(client(), FAMILY_B, 'acct_A')).toBe(false);
    expect(mirror(FAMILY_B)).toMatchObject({ status: 'pending', charges_enabled: false, treasury_enabled: false });
    expect(mirror(FAMILY_A)).toMatchObject({ status: 'pending', charges_enabled: false });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('no mirror row matched'), { familyId: FAMILY_B, accountId: 'acct_A' });
  });

  it('mirrors the family\'s own account (control)', async () => {
    expect(await syncConnectedAccount(client(), FAMILY_A, 'acct_A')).toBe(true);
    expect(mirror(FAMILY_A)).toMatchObject({ status: 'enabled', charges_enabled: true, payouts_enabled: true, treasury_enabled: true });
    expect(mirror(FAMILY_B)).toMatchObject({ status: 'pending' });
  });
});

describe('the money webhook\'s account.updated', () => {
  async function deliver(event: Record<string, unknown>) {
    stripe.event = { id: 'evt_synthetic_1', created: 1_760_000_000, ...event };
    const { POST } = await import('@/app/api/webhooks/money/route');
    return POST(new NextRequest('https://bubaly.example/api/webhooks/money', {
      method: 'POST', headers: { 'stripe-signature': 't=1,v1=synthetic' }, body: '{}',
    }));
  }

  it('an account whose metadata names another family is a logged skip that changes no row, marked processed', async () => {
    const response = await deliver({ type: 'account.updated', data: { object: account('acct_A', true, { family_id: FAMILY_B }) } });
    expect(response.status).toBe(200);
    expect(mirror(FAMILY_B)).toMatchObject({ status: 'pending', charges_enabled: false });
    expect(mirror(FAMILY_A)).toMatchObject({ status: 'pending', charges_enabled: false });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('account.updated skipped'), { familyId: FAMILY_B, accountId: 'acct_A' });
    expect(db.table('stripe_webhook_events')).toEqual([expect.objectContaining({ stripe_event_id: 'evt_synthetic_1', status: 'processed' })]);
  });

  it('the family\'s own account is mirrored (control)', async () => {
    const response = await deliver({ type: 'account.updated', data: { object: account('acct_A', true, { family_id: FAMILY_A }) } });
    expect(response.status).toBe(200);
    expect(mirror(FAMILY_A)).toMatchObject({ status: 'enabled', charges_enabled: true });
    expect(console.warn).not.toHaveBeenCalled();
  });
});

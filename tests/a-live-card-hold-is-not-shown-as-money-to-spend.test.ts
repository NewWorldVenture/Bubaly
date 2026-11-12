import { readFileSync } from 'node:fs';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * Every function that moves a child's money decides by completed rows AND live
 * card holds (`processing`): wallet_reserve_card_auth (0155),
 * wallet_debit_spend_bucket (0342), and wallet_spendable_cents behind
 * wallet_transfer and wallet_decide_spend (0483). The figures a family is shown
 * as AVAILABLE counted completed rows only: the child wallet page's "available
 * in Spend", the send page's "available", and bucketBalanceCents, which a spend
 * request is checked against and whose figure it prints. With $10 in Spend and
 * an $8 card hold live, the page offered $10 to spend or send and the ledger
 * then refused anything over $2, naming a number the screen never showed.
 *
 * The available figures now count what the decisions count; the bucket's
 * balance and the wallet's total stay the money the wallet holds, holds and all.
 *
 * Finding N6 (child-money-scope). The database is in-memory; the pages are run
 * and the props they hand their views are read.
 */
const FAMILY = 'fam-1';
const WALLET = 'cw-1';

const requireUserContext = vi.fn();
const createServer = vi.fn();
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/wallet/family-wallet-status', () => ({ readFamilyWalletIsActive: async () => ({ data: { is_active: true }, error: null }) }));
vi.mock('@/components/wallet/child-detail-view', () => ({ ChildDetailView: () => null }));
vi.mock('@/components/wallet/send-money-view', () => ({ SendMoneyView: () => null }));
vi.mock('@/components/wallet/wallet-activation', () => ({ WalletActivation: () => null }));
vi.mock('@/components/ui/states', () => ({ ErrorState: () => null }));
vi.mock('@/components/app/app-not-found', () => ({ AppNotFound: () => null }));

const { bucketBalanceCents } = await import('@/lib/wallet/server');

/** The first element in a rendered tree that carries `prop`, and its props. */
function propsWith<T>(node: ReactNode, prop: string): T | null {
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<Record<string, unknown> & { children?: ReactNode }>;
  if (el.props[prop] !== undefined) return el.props as unknown as T;
  const kids = Array.isArray(el.props.children) ? el.props.children : [el.props.children];
  for (const kid of kids) {
    const hit = propsWith<T>(kid as ReactNode, prop);
    if (hit) return hit;
  }
  return null;
}

/** $10 in Spend, an $8 card hold live, and a $3 spend request waiting on a parent. */
function household(): InMemorySupabase {
  const db = createInMemorySupabase();
  db.seed('child_wallets', [{ id: WALLET, family_id: FAMILY, member_id: 'mem-kid', is_active: true }]);
  db.seed('family_members', [{ id: 'mem-kid', family_id: FAMILY, display_name: 'Ari', color: null }]);
  db.seed('wallet_buckets', [
    { id: 'b-spend', family_id: FAMILY, child_wallet_id: WALLET, kind: 'spend' },
    { id: 'b-save', family_id: FAMILY, child_wallet_id: WALLET, kind: 'save' },
  ]);
  db.seed('wallet_rules', [{ family_id: FAMILY, child_wallet_id: WALLET, split: null, require_approval_over_cents: 5000 }]);
  db.seed('wallet_goals', []);
  const row = (id: string, bucket: string, type: string, status: string, direction: string, cents: number) => ({
    id, family_id: FAMILY, child_wallet_id: WALLET, bucket_id: bucket, type, status, direction,
    amount_cents: cents, description: null, created_at: '2026-11-01T12:00:00.000Z', metadata: null,
  });
  db.seed('wallet_transactions', [
    row('t-topup', 'b-spend', 'parent_top_up', 'completed', 'credit', 1_000),
    row('t-save', 'b-save', 'parent_top_up', 'completed', 'credit', 500),
    row('t-hold', 'b-spend', 'card_spend', 'processing', 'debit', 800),
    row('t-asked', 'b-spend', 'card_spend', 'requires_parent_approval', 'debit', 300),
  ]);
  return db;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  requireUserContext.mockResolvedValue({
    active: { familyId: FAMILY, role: 'parent', member: { id: 'mem-parent' } },
    user: { id: 'user-1' },
  });
});

describe('a live card hold is not shown as money to spend', () => {
  it('the Spend balance a spend request is checked against, and prints, counts the hold', async () => {
    const db = household();

    const result = await bucketBalanceCents(db as unknown as Parameters<typeof bucketBalanceCents>[0], { familyId: FAMILY, childWalletId: WALLET, kind: 'spend' });

    // $10 less the live $8 hold. A request still waiting on a parent holds
    // nothing yet, as in every decision.
    expect(result).toEqual({ bucketId: 'b-spend', available: 200 });
  });

  it('the child wallet page offers what is left after the hold, and keeps the balance whole', async () => {
    createServer.mockResolvedValue(household());
    const { default: ChildWalletPage } = await import('@/app/(app)/wallet/children/[childId]/page');

    const props = propsWith<{ child: { total: number; spendable: number; buckets: Record<string, number> } }>(
      await ChildWalletPage({ params: Promise.resolve({ childId: WALLET }) }), 'child');

    expect(props!.child.spendable).toBe(200);
    expect(props!.child.buckets.spend).toBe(1_000);
    expect(props!.child.total).toBe(1_500);
  });

  it('the send page offers what is left after the hold', async () => {
    createServer.mockResolvedValue(household());
    const { default: SendMoneyPage } = await import('@/app/(app)/wallet/send/page');

    const props = propsWith<{ wallets: { id: string; spendBalance: number; total: number }[] }>(await SendMoneyPage(), 'wallets');

    expect(props!.wallets).toEqual([expect.objectContaining({ id: WALLET, spendBalance: 200, total: 1_500 })]);
  });

  it('every figure the child view calls available or spendable is that one', () => {
    const view = readFileSync('components/wallet/child-detail-view.tsx', 'utf8');

    expect(view.match(/const spendable = child\.spendable;/g)).toHaveLength(3);
    expect(view).toContain("{formatCents(child.spendable)} {t('childDetail.spendable')}");
    expect(view).not.toContain('child.buckets.spend');
  });
});

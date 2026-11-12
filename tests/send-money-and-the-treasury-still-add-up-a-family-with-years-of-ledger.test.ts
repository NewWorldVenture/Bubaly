// Send Money and the family treasury sum a family's whole wallet ledger on the
// page: Send Money with a ceiling of 3,000 rows family-wide, the treasury with
// 5,000. readAll answers a read past its ceiling as a FAILED read, so past it
// both pages lost every balance for good: Send Money offered each child as $0
// available, so a parent could no longer move money between children there,
// and the treasury showed every child at $0 under a warning. Every credit
// writes a ledger row per bucket it is split into, so a family on weekly
// allowances passes those ceilings in a few years. The child's wallet page sums
// the same ledger with a ceiling of 50,000 and kept showing the balances.
//
// Both pages now read as far as that page does (as the money coach does, N10).
// Past it they still report a failed read rather than total part of a ledger.
//
// Review item CMS-REV-2 (child-money-scope, on N10). The pages are run over the
// in-memory database with PostgREST's 1,000-row response cap, and the props
// they hand their views are read.
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000e2001';
const PARENT = '00000000-0000-4000-8000-0000000e2011';
const KIT = '00000000-0000-4000-8000-0000000e2021';
const LOU = '00000000-0000-4000-8000-0000000e2022';
const NOW = new Date('2026-11-10T15:00:00Z');
const BUCKETS = ['spend', 'save', 'give', 'invest'] as const;
/** Kit's allowances, a ledger row per bucket each week, for years; and Lou's few. */
const KIT_ROWS = 5_600;
const LOU_ROWS = 400;
const CENTS_EACH = 25;

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: PARENT },
    memberships: [],
    active: {
      familyId: FAMILY, role: 'parent',
      member: { id: 'member-parent', display_name: 'Dana' },
      family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string) => key,
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages: getMessages('en-US') }),
  };
});
vi.mock('@/components/wallet/send-money-view', () => ({ SendMoneyView: () => null }));
vi.mock('@/components/wallet/treasury-view', () => ({ TreasuryView: () => null }));
vi.mock('@/components/wallet/wallet-activation', () => ({ WalletActivation: () => null }));
vi.mock('@/components/ui/states', () => ({ ErrorState: () => null, EmptyState: () => null }));

const { default: SendMoneyPage } = await import('@/app/(app)/wallet/send/page');
const { default: WalletTreasuryPage } = await import('@/app/(app)/wallet/treasury/page');

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

/** What the page logged as a failed read of the ledger. */
const ledgerReadFailures = () => vi.mocked(console.error).mock.calls
  .filter(([message]) => typeof message === 'string' && message.includes('Wallet transactions read failed'));

let db: InMemorySupabase;

/** One wallet's allowance rows, a quarter in each bucket, eight hours apart. */
const allowances = (wallet: string, count: number, offset: number) => Array.from({ length: count }, (_, i) => ({
  id: `txn-${String(offset + i).padStart(6, '0')}`, family_id: FAMILY, child_wallet_id: wallet, bucket_id: `${wallet}-${BUCKETS[i % 4]}`,
  type: 'allowance', status: 'completed', direction: 'credit', amount_cents: CENTS_EACH,
  created_at: new Date(Date.UTC(2021, 0, 1) + (offset + i) * 8 * 3_600_000).toISOString(),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1_000 });
  h.db = db;
  db.seed('family_wallets', [{ id: 'fw', family_id: FAMILY, is_active: true }]);
  db.seed('family_members', [
    { id: 'member-parent', family_id: FAMILY, display_name: 'Dana', color: null },
    { id: 'member-kit', family_id: FAMILY, display_name: 'Kit', color: null },
    { id: 'member-lou', family_id: FAMILY, display_name: 'Lou', color: null },
  ]);
  db.seed('child_wallets', [
    { id: KIT, family_id: FAMILY, member_id: 'member-kit', is_active: true },
    { id: LOU, family_id: FAMILY, member_id: 'member-lou', is_active: true },
  ]);
  db.seed('wallet_buckets', [KIT, LOU].flatMap((wallet) => BUCKETS.map((kind) => ({ id: `${wallet}-${kind}`, family_id: FAMILY, child_wallet_id: wallet, kind }))));
  db.seed('wallet_goals', []);
  db.seed('wallet_rules', []);
  db.seed('wallet_transactions', [...allowances(KIT, KIT_ROWS, 0), ...allowances(LOU, LOU_ROWS, KIT_ROWS)]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Send Money and the treasury still add up a family with years of ledger', () => {
  const kitEach = (KIT_ROWS / 4) * CENTS_EACH;
  const louEach = (LOU_ROWS / 4) * CENTS_EACH;

  it('Send Money still offers each child\'s Spend past 3,000 rows, so a parent can still move it', async () => {
    const tree = await SendMoneyPage();

    const props = propsWith<{ wallets: { id: string; spendBalance: number; total: number }[] }>(tree, 'wallets');
    expect(props!.wallets).toEqual([
      expect.objectContaining({ id: KIT, name: 'Kit', spendBalance: kitEach, total: 4 * kitEach }),
      expect.objectContaining({ id: LOU, name: 'Lou', spendBalance: louEach, total: 4 * louEach }),
    ]);
    expect(ledgerReadFailures()).toEqual([]);
    expect(propsWith(tree, 'role'), 'no read is reported as failed').toBeNull();
  });

  it('the treasury still totals every child past 5,000 rows', async () => {
    const tree = await WalletTreasuryPage();

    const props = propsWith<{ familyTotal: number; wallets: { id: string; total: number; buckets: Record<string, number> }[] }>(tree, 'familyTotal');
    expect(props!.familyTotal).toBe(4 * (kitEach + louEach));
    expect(props!.wallets).toEqual([
      expect.objectContaining({ id: KIT, total: 4 * kitEach, buckets: { spend: kitEach, save: kitEach, give: kitEach, invest: kitEach, goal: 0 } }),
      expect.objectContaining({ id: LOU, total: 4 * louEach, buckets: { spend: louEach, save: louEach, give: louEach, invest: louEach, goal: 0 } }),
    ]);
    expect(ledgerReadFailures()).toEqual([]);
    expect(propsWith(tree, 'role'), 'no read is reported as failed').toBeNull();
  });
});

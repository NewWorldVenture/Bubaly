// A child places investment orders on their OWN wallet, never a sibling's.
//
// THE DEFECT. `placeInvestOrderAction` (app/(app)/wallet/invest/actions.ts)
// checked only that the wallet named by the caller was in the active family.
// The Invest page renders a trade panel on EVERY child's card, for every member,
// and `invest_orders` lets any family member INSERT a pending order (0220). So
// a child could tap Sell on a brother's card and queue the sale of his shares,
// or Buy with his Invest cash — and so could a teen, a caregiver or a guest,
// none of whom owns that wallet.
//
// The parent's approval queue then reads "<wallet owner> wants to sell …": it
// names the child whose money moves, not the one who asked. One tap on Approve
// spends the sibling's Invest bucket or sells his holdings.
//
// `requestAllowanceAction` and both redemption actions already refuse exactly
// this ("a child asks for themselves; a manager may ask on anyone's behalf");
// this was the money request that did not.
//
// WHAT IS ASSERTED: a non-manager's order on a wallet that is not theirs is
// refused before anything is read about that wallet's money or the Trust
// Engine is asked, and no order row is written. A child's order on their own
// wallet, and a parent's or adult's order on any child's wallet, still land.
// And the page, rendered the way a phone opens it, offers Buy / Sell / Request
// only on the cards the viewer may order on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { placeInvestOrderAction } from '@/app/(app)/wallet/invest/actions';
import WalletInvestPage from '@/app/(app)/wallet/invest/page';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { ToastProvider } from '@/components/ui/toast';
import { getMessages } from '@/lib/i18n/messages';
import { localeOrDefault } from '@/lib/i18n/locales';

const mocks = vi.hoisted(() => ({
  createServer: vi.fn(),
  requireUserContext: vi.fn(),
  evaluateTrust: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/trust/server', () => ({ evaluateTrust: mocks.evaluateTrust, roleOf: (role: string) => role }));
vi.mock('@/lib/trust/messages', () => ({ householdPolicyBlocked: () => 'household-policy-blocked' }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }), usePathname: () => '/wallet/invest' }));

const FAMILY = 'family-a';
const ASSET = 'asset-a';

// Two children with the same portfolio: Mia (the caller when she is the child)
// and her brother Leo. Each has $20 of Invest cash and 2 shares.
const MIA = { member: 'member-mia', wallet: 'wallet-mia', bucket: 'bucket-mia' };
const LEO = { member: 'member-leo', wallet: 'wallet-leo', bucket: 'bucket-leo' };

let db: InMemorySupabase;

function signInAs(role: string, memberId: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${memberId}` },
    active: { familyId: FAMILY, role, member: { id: memberId } },
  });
}

/** Everything an order could touch, to show a refusal touched none of it. */
const ledgers = () => structuredClone({
  orders: db.table('invest_orders'),
  transactions: db.table('wallet_transactions'),
  holdings: db.table('invest_holdings'),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', basis: 'role_default' } });
  db = createInMemorySupabase();
  vi.spyOn(db, 'from');
  mocks.createServer.mockResolvedValue(db);
  db.seed('child_wallets', [
    { id: MIA.wallet, family_id: FAMILY, member_id: MIA.member, is_active: true },
    { id: LEO.wallet, family_id: FAMILY, member_id: LEO.member, is_active: true },
  ]);
  db.seed('invest_assets', [{ id: ASSET, price_cents: 500, is_active: true }]);
  db.seed('wallet_buckets', [
    { id: MIA.bucket, family_id: FAMILY, child_wallet_id: MIA.wallet, kind: 'invest' },
    { id: LEO.bucket, family_id: FAMILY, child_wallet_id: LEO.wallet, kind: 'invest' },
  ]);
  db.seed('wallet_transactions', [
    { id: 'mia-cash', family_id: FAMILY, bucket_id: MIA.bucket, direction: 'credit', amount_cents: 2000, status: 'completed' },
    { id: 'leo-cash', family_id: FAMILY, bucket_id: LEO.bucket, direction: 'credit', amount_cents: 2000, status: 'completed' },
  ]);
  db.seed('invest_holdings', [
    { family_id: FAMILY, child_wallet_id: MIA.wallet, asset_id: ASSET, shares: 2 },
    { family_id: FAMILY, child_wallet_id: LEO.wallet, asset_id: ASSET, shares: 2 },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const order = (wallet: string, side: 'buy' | 'sell') =>
  placeInvestOrderAction({ childWalletId: wallet, assetId: ASSET, side, shares: 2 });

describe("a child's order on a sibling's wallet", () => {
  it.each(['buy', 'sell'] as const)('is refused for a %s, and nothing is queued for a parent to approve', async (side) => {
    signInAs('child', MIA.member);
    const before = ledgers();

    expect(await order(LEO.wallet, side)).toEqual({ ok: false, error: 'actions.notAuthorized' });

    expect(ledgers()).toEqual(before);
    expect(db.table('invest_orders')).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("is refused before Leo's cash or shares are read and before the Trust Engine is asked", async () => {
    signInAs('child', MIA.member);
    expect(await order(LEO.wallet, 'sell')).toEqual({ ok: false, error: 'actions.notAuthorized' });
    const read = vi.mocked(db.from).mock.calls.map(([table]) => table);
    expect(read).not.toContain('wallet_transactions');
    expect(read).not.toContain('invest_holdings');
    expect(mocks.evaluateTrust).not.toHaveBeenCalled();
  });

  it('is refused for a teen too', async () => {
    signInAs('teen', MIA.member);
    expect(await order(LEO.wallet, 'buy')).toEqual({ ok: false, error: 'actions.notAuthorized' });
    expect(db.table('invest_orders')).toEqual([]);
  });

  it.each(['caregiver', 'guest'])('is refused for a %s, who owns no child wallet at all', async (role) => {
    signInAs(role, `member-${role}`);
    for (const wallet of [MIA.wallet, LEO.wallet]) {
      expect(await order(wallet, 'sell')).toEqual({ ok: false, error: 'actions.notAuthorized' });
    }
    expect(db.table('invest_orders')).toEqual([]);
  });
});

describe('orders that are still allowed', () => {
  it.each(['buy', 'sell'] as const)('a child may %s on their own wallet; it waits for a parent', async (side) => {
    signInAs('child', MIA.member);
    expect(await order(MIA.wallet, side)).toEqual({ ok: true });
    expect(db.table('invest_orders')).toEqual([
      expect.objectContaining({ child_wallet_id: MIA.wallet, side, status: 'pending', requested_by: `user-${MIA.member}` }),
    ]);
  });

  it.each(['parent', 'adult'])('a %s may order on any child\'s wallet', async (role) => {
    signInAs(role, `member-${role}`);
    expect(await order(MIA.wallet, 'buy')).toEqual({ ok: true });
    expect(await order(LEO.wallet, 'sell')).toEqual({ ok: true });
    expect(db.table('invest_orders').map((row) => row.child_wallet_id)).toEqual([MIA.wallet, LEO.wallet]);
  });
});

/**
 * One load of /wallet/invest as the viewer, as text: each child's card, keyed
 * by the name at its top, holding the words of every control on it.
 */
async function openTheInvestPage(): Promise<Map<string, string>> {
  const tree = await WalletInvestPage();
  const html = renderToStaticMarkup(createElement(
    LocaleProvider,
    { locale: localeOrDefault('en-US'), source: 'cookie', messages: getMessages('en-US') } as Parameters<typeof LocaleProvider>[0],
    createElement(ToastProvider, null, tree as React.ReactElement),
  ));
  const cards = new Map<string, string>();
  for (const chunk of html.split('rounded-2xl border border-border bg-surface/40 p-4').slice(1)) {
    const name = chunk.match(/<p class="font-semibold">([^<]+)<\/p>/)?.[1];
    // A child's card says how much is "ready to invest"; the growth projector
    // below them shares the card styling and does not.
    if (name && chunk.includes('ready to invest')) cards.set(name, chunk.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '));
  }
  return cards;
}

describe('the Invest page offers an order only where one is allowed', () => {
  beforeEach(() => {
    db.seed('family_wallets', [{ id: 'fw', family_id: FAMILY, is_active: true }]);
    db.seed('family_members', [
      { id: MIA.member, family_id: FAMILY, display_name: 'Mia', color: null },
      { id: LEO.member, family_id: FAMILY, display_name: 'Leo', color: null },
    ]);
    db.replace('invest_assets', [{
      id: ASSET, symbol: 'IDX', name: 'Index fund', kind: 'fund', emoji: '📈', description: null,
      price_cents: 500, risk_level: 'low', is_active: true, sort_order: 1,
    }]);
  });

  it("shows Mia the order controls on her own card and not on her brother's", async () => {
    signInAs('child', MIA.member);
    const cards = await openTheInvestPage();
    expect([...cards.keys()]).toEqual(['Mia', 'Leo']);
    for (const control of ['Buy', 'Sell', 'Request']) {
      expect(cards.get('Mia'), control).toContain(` ${control} `);
      expect(cards.get('Leo'), control).not.toContain(` ${control} `);
    }
    // She can still look at Leo's portfolio and ask what an investment is.
    expect(cards.get('Leo')).toContain(' Explain ');
  });

  it.each(['caregiver', 'guest'])('shows a %s no order controls on any card', async (role) => {
    signInAs(role, `member-${role}`);
    const cards = await openTheInvestPage();
    expect(cards.size).toBe(2);
    for (const card of cards.values()) expect(card).not.toContain(' Request ');
  });

  it.each(['parent', 'adult'])('shows a %s the order controls on every child\'s card', async (role) => {
    signInAs(role, `member-${role}`);
    const cards = await openTheInvestPage();
    expect(cards.size).toBe(2);
    for (const card of cards.values()) expect(card).toContain(' Request ');
  });
});

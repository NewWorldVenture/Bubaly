import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

// DATA-023. A child's wallet page summed the child's total and bucket
// balances from its history list: the newest 200 ledger rows. Past 200 rows the
// figures were an arbitrary recent slice. Found by driving the page in a
// browser against a local production build (the MAIN-F-F08 retest): a teen
// with 1,200 seven-cent Invest credits ($84) was shown $14, and a $12.34
// top-up moved the total from $14 to $26.06.
//
// This runs the page itself over a store that answers any single read with at
// most 1,000 rows, as PostgREST does, and reads the figures it hands the view.

const CAP = 1_000;
const FAMILY = 'fam-1';
const WALLET = 'cw-1';

const requireUserContext = vi.fn();
const createServer = vi.fn();
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/components/wallet/child-detail-view', () => ({ ChildDetailView: () => null }));
vi.mock('@/components/ui/states', () => ({ ErrorState: () => null }));
vi.mock('@/components/app/app-not-found', () => ({ AppNotFound: () => null }));

type ChildProps = { child: { total: number; buckets: Record<string, number> }; history: unknown[] };

function viewProps(node: ReactNode): ChildProps | null {
  if (!isValidElement(node)) return null;
  const el = node as ReactElement<{ child?: unknown; children?: ReactNode }>;
  if (el.props.child) return el.props as unknown as ChildProps;
  const kids = Array.isArray(el.props.children) ? el.props.children : [el.props.children];
  for (const k of kids) {
    const hit = viewProps(k);
    if (hit) return hit;
  }
  return null;
}

/** `invest` credits of 7 cents each, plus a `spend` credit and debit, oldest first. */
function seeded(investCredits: number) {
  const db = createInMemorySupabase({ maxRows: CAP });
  db.seed('child_wallets', [{ id: WALLET, family_id: FAMILY, member_id: 'mem-kid', is_active: true }]);
  db.seed('family_members', [{ id: 'mem-kid', family_id: FAMILY, display_name: 'Ari', color: null }]);
  db.seed('wallet_buckets', [
    { id: 'b-spend', family_id: FAMILY, child_wallet_id: WALLET, kind: 'spend' },
    { id: 'b-invest', family_id: FAMILY, child_wallet_id: WALLET, kind: 'invest' },
  ]);
  db.seed('wallet_rules', [{ family_id: FAMILY, child_wallet_id: WALLET, split: null, require_approval_over_cents: 5000 }]);
  db.seed('wallet_goals', []);
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString();
  const row = (i: number, bucket: string, direction: string, cents: number) => ({
    id: `txn-${String(i).padStart(6, '0')}`, family_id: FAMILY, child_wallet_id: WALLET, bucket_id: bucket,
    type: 'parent_top_up', status: 'completed', direction, amount_cents: cents, description: null,
    created_at: at(i), metadata: null,
  });
  db.seed('wallet_transactions', [
    ...Array.from({ length: investCredits }, (_, i) => row(i, 'b-invest', 'credit', 7)),
    row(investCredits, 'b-spend', 'credit', 1_000),
    row(investCredits + 1, 'b-spend', 'debit', 250),
  ]);
  return db;
}

async function render(db: ReturnType<typeof seeded>) {
  createServer.mockResolvedValue(db);
  const { default: ChildWalletPage } = await import('@/app/(app)/wallet/children/[childId]/page');
  return viewProps(await ChildWalletPage({ params: Promise.resolve({ childId: WALLET }) }));
}

beforeEach(() => {
  requireUserContext.mockResolvedValue({
    active: { familyId: FAMILY, role: 'parent', member: { id: 'mem-parent' } },
    user: { id: 'user-1' },
  });
});

describe("a child's wallet page shows the balance of the whole ledger", () => {
  it('past the 200-row history list and past the 1,000-row cap', async () => {
    const props = await render(seeded(1_200));
    expect(props).not.toBeNull();
    // 1,200 × 7 = 8,400 invested; 1,000 − 250 = 750 to spend.
    expect(props!.child.buckets.invest).toBe(8_400);
    expect(props!.child.buckets.spend).toBe(750);
    expect(props!.child.total).toBe(9_150);
  });

  it('still lists only the newest 200 rows as history', async () => {
    const props = await render(seeded(1_200));
    expect(props!.history).toHaveLength(200);
  });

  it('a small ledger is unchanged', async () => {
    const props = await render(seeded(10));
    expect(props!.child.buckets.invest).toBe(70);
    expect(props!.child.total).toBe(820);
  });
});

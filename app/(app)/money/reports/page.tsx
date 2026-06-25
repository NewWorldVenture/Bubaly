import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withStripeTables, type StripeTables } from '@/lib/supabase/stripe-tables';
import { isManager } from '@/lib/constants/roles';
import { MoneyNav } from '@/components/money/money-nav';
import { formatCents } from '@/lib/wallet/ledger';
import { TrendingUp, TrendingDown, Wallet, CreditCard } from 'lucide-react';

export const metadata: Metadata = { title: 'Reports — Bubaly Money' };

export default async function MoneyReportsPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const db = withStripeTables(supabase);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [{ data: allTxns }, { data: monthTxns }, { data: auths }, { data: members }, { data: childWallets }] = await Promise.all([
    supabase.from('wallet_transactions').select('child_wallet_id, direction, amount_cents, type, status').eq('family_id', familyId).eq('status', 'completed'),
    supabase.from('wallet_transactions').select('child_wallet_id, direction, amount_cents, type').eq('family_id', familyId).eq('status', 'completed').gte('created_at', startOfMonth),
    db.from('stripe_authorizations').select('amount_cents, decision, merchant_category').eq('family_id', familyId),
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId),
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId).eq('is_active', true),
  ]);

  type StripeAuth = StripeTables['stripe_authorizations'];
  const typedAuths = (auths ?? []) as StripeAuth[];

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));
  const walletMember = new Map((childWallets ?? []).map((w) => [w.id, w.member_id]));

  // Compute per-child balance
  const balances = new Map<string, number>();
  for (const txn of allTxns ?? []) {
    if (!txn.child_wallet_id) continue;
    const curr = balances.get(txn.child_wallet_id) ?? 0;
    balances.set(txn.child_wallet_id, curr + (txn.direction === 'credit' ? txn.amount_cents : -txn.amount_cents));
  }

  // This month: inflows vs outflows
  let monthCredits = 0;
  let monthDebits = 0;
  const creditsByType: Record<string, number> = {};
  for (const txn of monthTxns ?? []) {
    if (txn.direction === 'credit') {
      monthCredits += txn.amount_cents;
      creditsByType[txn.type] = (creditsByType[txn.type] ?? 0) + txn.amount_cents;
    } else {
      monthDebits += txn.amount_cents;
    }
  }

  // Card spend by category
  const categorySpend: Record<string, number> = {};
  let approvedSpend = 0;
  let declinedAmount = 0;
  for (const auth of typedAuths) {
    if (auth.decision === 'approved') {
      approvedSpend += auth.amount_cents;
      const cat = auth.merchant_category ?? 'other';
      categorySpend[cat] = (categorySpend[cat] ?? 0) + auth.amount_cents;
    } else if (auth.decision === 'declined') {
      declinedAmount += auth.amount_cents;
    }
  }

  const topCategories = Object.entries(categorySpend).sort(([, a], [, b]) => b - a).slice(0, 5);
  const totalBalance = Array.from(balances.values()).reduce((s, b) => s + b, 0);

  return (
    <div className="space-y-6">
      <MoneyNav />

      <div>
        <h1 className="text-2xl font-bold text-fg">Reports</h1>
        <p className="text-sm text-muted">Family spending summary</p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <div className="mb-2 flex items-center gap-2 text-muted"><Wallet className="h-4 w-4" /><span className="text-xs">Total balance</span></div>
          <p className="text-xl font-bold text-fg">{formatCents(totalBalance)}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <div className="mb-2 flex items-center gap-2 text-green-500"><TrendingUp className="h-4 w-4" /><span className="text-xs">This month in</span></div>
          <p className="text-xl font-bold text-green-600">{formatCents(monthCredits)}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <div className="mb-2 flex items-center gap-2 text-red-400"><TrendingDown className="h-4 w-4" /><span className="text-xs">This month out</span></div>
          <p className="text-xl font-bold text-red-500">{formatCents(monthDebits)}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface/50 p-4">
          <div className="mb-2 flex items-center gap-2 text-muted"><CreditCard className="h-4 w-4" /><span className="text-xs">Card spend</span></div>
          <p className="text-xl font-bold text-fg">{formatCents(approvedSpend)}</p>
        </div>
      </div>

      {/* Per-child balances */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-fg">Balances by child</h2>
        <div className="rounded-xl border border-border bg-surface/50 divide-y divide-border">
          {(childWallets ?? []).map((w) => {
            const member = memberById.get(walletMember.get(w.id) ?? '');
            const balance = balances.get(w.id) ?? 0;
            return (
              <div key={w.id} className="flex items-center justify-between px-4 py-3">
                <p className="text-sm font-medium text-fg">{member?.display_name ?? 'Child'}</p>
                <p className={`text-sm font-semibold ${balance >= 0 ? 'text-fg' : 'text-red-500'}`}>{formatCents(balance)}</p>
              </div>
            );
          })}
        </div>
      </section>

      {/* Credit breakdown */}
      {Object.keys(creditsByType).length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold text-fg">Credits this month by type</h2>
          <div className="rounded-xl border border-border bg-surface/50 divide-y divide-border">
            {Object.entries(creditsByType).sort(([, a], [, b]) => b - a).map(([type, amount]) => (
              <div key={type} className="flex items-center justify-between px-4 py-3">
                <p className="text-sm font-medium capitalize text-fg">{type.replace(/_/g, ' ')}</p>
                <p className="text-sm font-semibold text-green-600">{formatCents(amount)}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Top card categories */}
      {topCategories.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold text-fg">Top spending categories (card)</h2>
          <div className="rounded-xl border border-border bg-surface/50 divide-y divide-border">
            {topCategories.map(([cat, amount]) => (
              <div key={cat} className="flex items-center justify-between px-4 py-3">
                <p className="text-sm font-medium capitalize text-fg">{cat.replace(/_/g, ' ')}</p>
                <p className="text-sm font-semibold text-fg">{formatCents(amount)}</p>
              </div>
            ))}
          </div>
          {declinedAmount > 0 && (
            <p className="mt-2 text-xs text-muted">{formatCents(declinedAmount)} blocked by spending controls.</p>
          )}
        </section>
      )}
    </div>
  );
}

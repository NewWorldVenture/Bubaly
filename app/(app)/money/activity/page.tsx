import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withStripeTables, type StripeTables } from '@/lib/supabase/stripe-tables';
import { MoneyNav } from '@/components/money/money-nav';
import { formatCents } from '@/lib/wallet/ledger';
import { ArrowDownLeft, ArrowUpRight, CheckCircle2, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Activity — Bubaly Money' };

export default async function MoneyActivityPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const db = withStripeTables(supabase);

  const [{ data: txns }, { data: auths }, { data: members }, { data: childWallets }] = await Promise.all([
    supabase.from('wallet_transactions').select('id, child_wallet_id, type, direction, amount_cents, description, created_at, status').eq('family_id', familyId).order('created_at', { ascending: false }).limit(100),
    db.from('stripe_authorizations').select('*').eq('family_id', familyId).order('authorized_at', { ascending: false }).limit(50),
    supabase.from('family_members').select('id, display_name, color').eq('family_id', familyId),
    supabase.from('child_wallets').select('id, member_id').eq('family_id', familyId),
  ]);

  type StripeAuth = StripeTables['stripe_authorizations'];
  const typedAuths = (auths ?? []) as StripeAuth[];

  const memberById = new Map((members ?? []).map((m) => [m.id, m]));
  const walletMember = new Map((childWallets ?? []).map((w) => [w.id, w.member_id]));

  function walletName(walletId: string | null) {
    if (!walletId) return 'Child';
    const memberId = walletMember.get(walletId);
    return memberId ? (memberById.get(memberId)?.display_name ?? 'Child') : 'Child';
  }

  return (
    <div className="space-y-6">
      <MoneyNav />

      <div>
        <h1 className="text-2xl font-bold text-fg">Activity</h1>
        <p className="text-sm text-muted">All transactions and card activity</p>
      </div>

      {/* Card authorizations */}
      {(auths ?? []).length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold text-fg">Card transactions</h2>
          <div className="rounded-xl border border-border bg-surface/50 divide-y divide-border">
            {typedAuths.map((auth) => (
              <div key={auth.id} className="flex items-center gap-3 px-4 py-3">
                <div className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white',
                  auth.decision === 'approved' ? 'bg-green-500' : 'bg-red-500',
                )}>
                  {auth.decision === 'approved' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{auth.merchant_name ?? 'Unknown'}</p>
                  <p className="text-xs text-muted capitalize">{auth.merchant_category?.replace(/_/g, ' ') ?? ''} · {new Date(auth.authorized_at).toLocaleDateString()}</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold text-fg">{formatCents(auth.amount_cents)}</p>
                  <p className={cn('text-xs font-medium', auth.decision === 'approved' ? 'text-green-600' : 'text-red-500')}>
                    {auth.decision ?? auth.status}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Wallet transactions */}
      <section>
        <h2 className="mb-3 text-base font-semibold text-fg">Wallet ledger</h2>
        {(txns ?? []).length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-muted text-sm">No transactions yet.</div>
        ) : (
          <div className="rounded-xl border border-border bg-surface/50 divide-y divide-border">
            {(txns ?? []).map((txn) => (
              <div key={txn.id} className="flex items-center gap-3 px-4 py-3">
                <div className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                  txn.direction === 'credit' ? 'bg-green-100 text-green-600' : 'bg-red-100 text-red-600',
                )}>
                  {txn.direction === 'credit' ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{txn.description || txn.type}</p>
                  <p className="text-xs text-muted">{walletName(txn.child_wallet_id)} · {new Date(txn.created_at).toLocaleDateString()}</p>
                </div>
                <span className={cn(
                  'text-sm font-semibold',
                  txn.direction === 'credit' ? 'text-green-600' : 'text-red-500',
                )}>
                  {txn.direction === 'credit' ? '+' : '-'}{formatCents(txn.amount_cents)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

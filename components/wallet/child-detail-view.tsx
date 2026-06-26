'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Plus, Target, PiggyBank, ShoppingBag, HandHeart, TrendingUp, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { EmptyState } from '@/components/ui/states';
import { formatCents, goalProgress, type BucketKind } from '@/lib/wallet/ledger';
import { txnTypeLabel, signedAmountCents, groupByDay, type ActivityTxn } from '@/lib/wallet/activity';
import { addFundsAction } from '@/app/(app)/wallet/actions';

const BUCKET_META: Record<BucketKind, { label: string; icon: typeof PiggyBank; cls: string; bar: string }> = {
  spend: { label: 'Spend', icon: ShoppingBag, cls: 'text-sky-500', bar: 'bg-sky-500' },
  save: { label: 'Save', icon: PiggyBank, cls: 'text-emerald-500', bar: 'bg-emerald-500' },
  give: { label: 'Give', icon: HandHeart, cls: 'text-rose-500', bar: 'bg-rose-500' },
  invest: { label: 'Invest', icon: TrendingUp, cls: 'text-violet-500', bar: 'bg-violet-500' },
  goal: { label: 'Goals', icon: Target, cls: 'text-amber-500', bar: 'bg-amber-500' },
};

const VISIBLE_BUCKETS: BucketKind[] = ['spend', 'save', 'give', 'invest'];
const QUICK_AMOUNTS = [5, 10, 20, 50];

type Goal = { id: string; title: string; target_cents: number; saved_cents: number; status: string };

export function ChildDetailView({ child, goals, history, canManage }: {
  child: { id: string; name: string; total: number; buckets: Record<BucketKind, number> };
  goals: Goal[];
  history: ActivityTxn[];
  canManage: boolean;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const groups = groupByDay(history);

  async function addFunds(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(parseFloat(amount || '0') * 100);
    if (cents <= 0) return toastError('Enter an amount greater than $0.');
    setBusy(true);
    const res = await addFundsAction({ childWalletId: child.id, amountCents: cents, description: 'Parent top-up' });
    setBusy(false);
    if (!res.ok) return toastError(res.error ?? 'Could not add funds');
    success(`Added ${formatCents(cents)} to ${child.name}`); setAmount(''); setAdding(false);
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <Link href="/wallet" className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" /> All wallets</Link>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{child.name}</h1>
          <p className="text-3xl font-extrabold text-brand">{formatCents(child.total)}</p>
        </div>
        {canManage && <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> Add funds</Button>}
      </div>

      {/* Allocation bar — instant read of where the balance sits */}
      {child.total > 0 && (
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-border/40" role="img" aria-label={`${child.name}'s balance allocation`}>
          {VISIBLE_BUCKETS.map((k) => {
            const pct = ((child.buckets[k] ?? 0) / child.total) * 100;
            if (pct <= 0) return null;
            return <div key={k} className={`h-full ${BUCKET_META[k].bar}`} style={{ width: `${pct}%` }} title={`${BUCKET_META[k].label}: ${Math.round(pct)}%`} />;
          })}
        </div>
      )}

      {/* Buckets */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {VISIBLE_BUCKETS.map((k) => {
          const m = BUCKET_META[k];
          return (
            <div key={k} className="rounded-2xl border border-border bg-surface/40 p-4">
              <p className={`flex items-center gap-1.5 text-xs font-medium ${m.cls}`}><m.icon className="h-3.5 w-3.5" /> {m.label}</p>
              <p className="mt-1 text-lg font-bold">{formatCents(child.buckets[k] ?? 0)}</p>
            </div>
          );
        })}
      </div>

      {/* Goals */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-base font-semibold"><Target className="h-4 w-4 text-brand" /> Goals</h2>
          <Link href="/wallet/goals" className="text-xs font-semibold text-brand">Manage goals →</Link>
        </div>
        {goals.length === 0 ? (
          <p className="text-sm text-muted">No goals yet. Create one on the Goals tab.</p>
        ) : (
          <div className="space-y-2">
            {goals.map((g) => {
              const pct = Math.round(goalProgress(g.saved_cents, g.target_cents) * 100);
              return (
                <div key={g.id} className="rounded-xl border border-border bg-surface/40 p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{g.title}{g.status === 'reached' ? ' 🎉' : ''}</span>
                    <span className="text-muted">{formatCents(g.saved_cents)} / {formatCents(g.target_cents)}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-border/50">
                    <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* History */}
      <div>
        <h2 className="mb-2 flex items-center gap-2 text-base font-semibold"><Receipt className="h-4 w-4 text-brand" /> History</h2>
        {history.length === 0 ? (
          <EmptyState icon={Receipt} title="No transactions yet" description="Top-ups, allowance, chores and gifts will show up here." />
        ) : (
          <div className="space-y-4">
            {groups.map((grp) => (
              <div key={grp.date}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{new Date(grp.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</h3>
                <div className="space-y-1.5">
                  {grp.txns.map((tx) => {
                    const signed = signedAmountCents(tx);
                    const credit = signed >= 0;
                    return (
                      <div key={tx.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface/40 px-3 py-2 text-sm">
                        <span className="min-w-0 truncate">{tx.description || txnTypeLabel(tx.type)} <span className="text-xs text-muted">· {txnTypeLabel(tx.type)}</span></span>
                        <span className={`shrink-0 font-semibold ${credit ? 'text-success' : 'text-danger'}`}>{credit ? '+' : '−'}{formatCents(Math.abs(signed))}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {adding && (
        <Modal open onClose={() => setAdding(false)} title={`Add funds to ${child.name}'s wallet`}>
          <form onSubmit={addFunds} className="space-y-3">
            <Field label="Amount ($)">{(id) => <Input id={id} type="number" step="0.01" min="0" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="20.00" autoFocus />}</Field>
            <div className="flex flex-wrap gap-2">
              {QUICK_AMOUNTS.map((q) => (
                <button key={q} type="button" onClick={() => setAmount(String(q))}
                  className="rounded-lg border border-border px-3 py-1.5 text-sm hover:border-brand/40 hover:text-brand transition">
                  ${q}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted">Allocated across Spend / Save / Give / Invest by this child&apos;s split rule.</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" loading={busy}>Add funds</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

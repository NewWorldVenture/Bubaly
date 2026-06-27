'use client';

import { useMemo, useState } from 'react';
import { Receipt, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { EmptyState } from '@/components/ui/states';
import { formatCents } from '@/lib/wallet/ledger';
import { txnTypeLabel, signedAmountCents, filterTxns, groupByDay, netCents, type ActivityTxn } from '@/lib/wallet/activity';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';

type Row = ActivityTxn & { childName: string | null };

const TYPES: { value: string; label: string }[] = [
  { value: '', label: 'All types' },
  ...['parent_top_up', 'allowance', 'chore_reward', 'gift_received', 'transfer', 'goal_transfer', 'babysitter_payment', 'card_spend', 'card_refund', 'adjustment', 'reversal'].map((v) => ({ value: v, label: txnTypeLabel(v) })),
];

function dayLabel(date: string): string {
  return new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function WalletActivityView({ rows, childOptions }: { rows: Row[]; childOptions: { id: string; name: string }[] }) {
  const [child, setChild] = useState('');
  const [type, setType] = useState('');
  const [direction, setDirection] = useState('');

  const filtered = useMemo(
    () => filterTxns(rows, { childWalletId: child || null, type: type || null, direction: (direction || null) as 'credit' | 'debit' | null }),
    [rows, child, type, direction],
  );
  const groups = useMemo(() => groupByDay(filtered), [filtered]);
  const net = useMemo(() => netCents(filtered), [filtered]);

  const selCls = 'h-9 rounded-lg border border-border bg-bg px-2 text-sm';

  return (
    <div>
      <WalletSubnav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-bold"><Receipt className="h-5 w-5 text-brand" /> Activity</h2>
        <div className="flex flex-wrap gap-2">
          <select value={child} onChange={(e) => setChild(e.target.value)} className={selCls} aria-label="Child">
            <option value="">All children</option>
            {childOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)} className={selCls} aria-label="Type">
            {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <select value={direction} onChange={(e) => setDirection(e.target.value)} className={selCls} aria-label="Direction">
            <option value="">In &amp; out</option>
            <option value="credit">Money in</option>
            <option value="debit">Money out</option>
          </select>
        </div>
      </div>

      <div className="mb-4 rounded-2xl border border-border bg-surface/40 p-4">
        <p className="text-xs text-muted">Net for this view ({filtered.length} transaction{filtered.length === 1 ? '' : 's'})</p>
        <p className={`text-2xl font-bold ${net >= 0 ? 'text-success' : 'text-danger'}`}>{net >= 0 ? '+' : '−'}{formatCents(Math.abs(net))}</p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Receipt} title="No transactions" description="Wallet activity will appear here as money moves in and out." />
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <div key={g.date}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{dayLabel(g.date)}</h3>
              <div className="space-y-2">
                {g.txns.map((tx) => {
                  const signed = signedAmountCents(tx);
                  const credit = signed >= 0;
                  return (
                    <div key={tx.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3">
                      <div className={`rounded-lg p-1.5 ${credit ? 'bg-success/15 text-success' : 'bg-danger/15 text-danger'}`}>
                        {credit ? <ArrowDownLeft className="h-4 w-4" /> : <ArrowUpRight className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{tx.description || txnTypeLabel(tx.type)}</p>
                        <p className="text-xs text-muted">
                          {txnTypeLabel(tx.type)}{tx.childName ? ` · ${tx.childName}` : ''}{tx.status !== 'completed' ? ` · ${tx.status.replace(/_/g, ' ')}` : ''}
                        </p>
                      </div>
                      <p className={`shrink-0 text-sm font-semibold ${credit ? 'text-success' : 'text-danger'}`}>{credit ? '+' : '−'}{formatCents(Math.abs(signed))}</p>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

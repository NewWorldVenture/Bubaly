'use client';

import { useMemo, useState } from 'react';
import { Receipt, ArrowDownLeft, ArrowUpRight, Download } from 'lucide-react';
import { EmptyState } from '@/components/ui/states';
import { formatCents as formatCentsIn } from '@/lib/wallet/ledger';
import { txnTypeLabel, txnTypeKey, txnStatusKey, signedAmountCents, filterTxns, groupByDay, netCents, toStatementCsv, statementFilename, type ActivityTxn } from '@/lib/wallet/activity';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { useFamilyClock, useFormat } from '@/components/i18n/use-format';
import type { Format } from '@/lib/utils/format';

type Row = ActivityTxn & { childName: string | null };

const TYPES = ['parent_top_up', 'allowance', 'chore_reward', 'gift_received', 'transfer', 'goal_transfer', 'babysitter_payment', 'card_spend', 'card_refund', 'adjustment', 'reversal'];

// A ledger day is a DATE, rendered as written (TIME-003).
const dayLabelWith = (fmtDate: Format['fmtDate']) => (date: string): string => fmtDate(date, 'EEE, MMM d, yyyy');

export function WalletActivityView({ rows, childOptions }: { rows: Row[]; childOptions: { id: string; name: string }[] }) {
  const locale = useLocale();
  const dayLabel = dayLabelWith(useFormat().fmtDate);
  // Money follows the reader; the currency stays the money's own.
  const formatCents = (cents: number, currency?: string) =>
    formatCentsIn(cents, currency, locale.code);
  const tr = useTranslations();
  // Types and statuses in the reader's language; the English label is only the
  // fallback for a value the catalogue does not name.
  const typeLabel = (type: string) => { const key = txnTypeKey(type); return key ? tr(key) : txnTypeLabel(type); };
  const statusLabel = (status: string) => { const key = txnStatusKey(status); return key ? tr(key) : status.replace(/_/g, ' '); };
  const [child, setChild] = useState('');
  const [type, setType] = useState('');
  const [direction, setDirection] = useState('');

  const filtered = useMemo(
    () => filterTxns(rows, { childWalletId: child || null, type: type || null, direction: (direction || null) as 'credit' | 'debit' | null }),
    [rows, child, type, direction],
  );
  const familyZone = useFamilyClock().timeZone;
  const groups = useMemo(() => groupByDay(filtered, familyZone), [filtered, familyZone]);
  const net = useMemo(() => netCents(filtered), [filtered]);

  function downloadStatement() {
    // Export exactly what's in view (respects the active filters). Pure CSV +
    // a client-side Blob download — no server round-trip, no external deps.
    const csv = toStatementCsv(filtered);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = statementFilename();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  const selCls = 'h-9 rounded-lg border border-border bg-bg px-2 text-sm';

  return (
    <div>
      <WalletSubnav />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        {/* The page's title: the activated wallet's activity page had no <h1>. */}
        <h1 className="flex items-center gap-2 text-lg font-bold"><Receipt className="h-5 w-5 text-brand-text" /> {tr('activity.activity')}</h1>
        <div className="flex flex-wrap gap-2">
          <select value={child} onChange={(e) => setChild(e.target.value)} className={selCls} aria-label={tr('activity.child')}>
            <option value="">{tr('activity.allChildren')}</option>
            {childOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)} className={selCls} aria-label={tr('activity.type')}>
            <option value="">{tr('walletTxn.allTypes')}</option>
            {TYPES.map((v) => <option key={v} value={v}>{typeLabel(v)}</option>)}
          </select>
          <select value={direction} onChange={(e) => setDirection(e.target.value)} className={selCls} aria-label={tr('activity.direction')}>
            <option value="">{tr('activity.inAmpOut')}</option>
            <option value="credit">{tr('activity.moneyIn')}</option>
            <option value="debit">{tr('activity.moneyOut')}</option>
          </select>
          <button
            type="button"
            onClick={downloadStatement}
            disabled={filtered.length === 0}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-3 text-sm font-medium hover:bg-elevated disabled:opacity-50"
            aria-label={tr('activity.downloadStatementAsCsv')}
          >
            <Download className="h-4 w-4" /> {tr('activity.statement')}
          </button>
        </div>
      </div>

      <div className="mb-4 rounded-2xl border border-border bg-surface/40 p-4">
        <p className="text-xs text-muted">{tr('activity.netForThisView')}{filtered.length} transaction{filtered.length === 1 ? '' : 's'})</p>
        <p className={`text-2xl font-bold ${net >= 0 ? 'text-success' : 'text-danger'}`}>{net >= 0 ? '+' : '−'}{formatCents(Math.abs(net))}</p>
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon={Receipt} title={tr('activity.noTransactions')} description={tr('activityView.walletActivityWillAppearHere')} />
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
                        <p className="truncate text-sm font-medium">{tx.description || typeLabel(tx.type)}</p>
                        <p className="text-xs text-muted">
                          {typeLabel(tx.type)}{tx.childName ? ` · ${tx.childName}` : ''}{tx.status !== 'completed' ? ` · ${statusLabel(tx.status)}` : ''}
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

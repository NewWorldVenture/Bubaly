'use client';

import { useState, useMemo } from 'react';
import {
  CheckCircle2, AlertTriangle, AlertOctagon, TrendingUp, TrendingDown, Scale,
  Clock, RotateCcw, Wallet, Filter,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { anomalyLabel, type ReconReport, type Anomaly, type AnomalyKind } from '@/lib/wallet/reconcile';
import { useTranslations } from '@/components/i18n/locale-provider';

const SEVERITY_STYLE: Record<Anomaly['severity'], { icon: typeof AlertOctagon; cls: string; chip: string }> = {
  high: { icon: AlertOctagon, cls: 'border-danger/30 bg-danger/5', chip: 'bg-danger/15 text-danger' },
  medium: { icon: AlertTriangle, cls: 'border-amber-500/30 bg-amber-500/5', chip: 'bg-amber-500/15 text-amber-500' },
  low: { icon: AlertTriangle, cls: 'border-border bg-surface/40', chip: 'bg-border/60 text-muted' },
};

export function ReconciliationClient({ report }: { report: ReconReport }) {
  const t = useTranslations();
  const [filter, setFilter] = useState<'all' | Anomaly['severity']>('all');

  const grouped = useMemo(() => {
    const m = new Map<AnomalyKind, Anomaly[]>();
    for (const a of report.anomalies) {
      const arr = m.get(a.kind) ?? [];
      arr.push(a); m.set(a.kind, arr);
    }
    return m;
  }, [report.anomalies]);

  const filtered = useMemo(
    () => filter === 'all' ? report.anomalies : report.anomalies.filter((a) => a.severity === filter),
    [report.anomalies, filter],
  );

  const highCount = report.anomalies.filter((a) => a.severity === 'high').length;
  const medCount = report.anomalies.filter((a) => a.severity === 'medium').length;
  const lowCount = report.anomalies.filter((a) => a.severity === 'low').length;

  return (
    <div className="space-y-6">
      {/* Health banner */}
      <div className={cn('flex items-center gap-4 rounded-2xl border p-5',
        report.healthy ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-danger/30 bg-danger/5')}>
        <div className={cn('grid h-12 w-12 flex-shrink-0 place-items-center rounded-2xl',
          report.healthy ? 'bg-emerald-500/15' : 'bg-danger/15')}>
          {report.healthy
            ? <CheckCircle2 className="h-6 w-6 text-emerald-400" />
            : <AlertOctagon className="h-6 w-6 text-danger" />}
        </div>
        <div className="flex-1">
          <p className="text-lg font-bold">
            {report.healthy ? 'Ledger is healthy' : `${highCount} critical anomal${highCount === 1 ? 'y' : 'ies'} found`}
          </p>
          <p className="text-sm text-muted">
            {t('adminWalletReconciliationReconciliationClient.checked')} {report.totalTxns.toLocaleString()} {t('adminWalletReconciliationReconciliationClient.transactionsAcross')} {report.walletsChecked} wallets.
            {report.healthy
              ? ' No critical integrity issues — derived balances and reversals reconcile.'
              : ' Review the anomalies below.'}
          </p>
        </div>
      </div>

      {/* Volume stats */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label={t('adminWalletReconciliationReconciliationClient.creditVolume')} value={formatCents(report.creditVolumeCents)} icon={TrendingUp} color="text-emerald-400" />
        <StatCard label={t('adminWalletReconciliationReconciliationClient.debitVolume')} value={formatCents(report.debitVolumeCents)} icon={TrendingDown} color="text-rose-400" />
        <StatCard label={t('adminWalletReconciliationReconciliationClient.netPosition')} value={formatCents(report.netCents)} icon={Scale} color="text-brand-text" />
        <StatCard label={t('adminWalletReconciliationReconciliationClient.pending')} value={String(report.pendingCount)} icon={Clock} color="text-amber-400" />
      </div>

      {/* Anomaly severity summary */}
      <div className="grid grid-cols-3 gap-3">
        <SeverityCard label={t('adminWalletReconciliationReconciliationClient.critical')} count={highCount} active={filter === 'high'} onClick={() => setFilter(filter === 'high' ? 'all' : 'high')} tone="high" />
        <SeverityCard label={t('adminWalletReconciliationReconciliationClient.warnings')} count={medCount} active={filter === 'medium'} onClick={() => setFilter(filter === 'medium' ? 'all' : 'medium')} tone="medium" />
        <SeverityCard label={t('adminWalletReconciliationReconciliationClient.info')} count={lowCount} active={filter === 'low'} onClick={() => setFilter(filter === 'low' ? 'all' : 'low')} tone="low" />
      </div>

      {/* Anomaly list */}
      {report.anomalies.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border border-border bg-surface/40 py-12 text-center">
          <CheckCircle2 className="mb-3 h-10 w-10 text-emerald-400" />
          <p className="text-sm font-semibold">{t('adminWalletReconciliationReconciliationClient.everythingReconciles')}</p>
          <p className="mt-1 text-xs text-muted">{t('adminWalletReconciliationReconciliationClient.noAnomaliesDetectedAcrossTheLedger')}</p>
        </div>
      ) : (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
              <Filter className="h-4 w-4" /> {t('adminWalletReconciliationReconciliationClient.anomalies')} {filter !== 'all' && `· ${filter}`}
            </h2>
            <p className="text-xs text-muted">{filtered.length} shown</p>
          </div>
          <div className="space-y-2">
            {filtered.map((a, i) => {
              const style = SEVERITY_STYLE[a.severity];
              const Icon = style.icon;
              return (
                <div key={i} className={cn('flex items-start gap-3 rounded-2xl border p-4', style.cls)}>
                  <Icon className={cn('mt-0.5 h-5 w-5 flex-shrink-0',
                    a.severity === 'high' ? 'text-danger' : a.severity === 'medium' ? 'text-amber-500' : 'text-muted')} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold">{anomalyLabel(a.kind)}</p>
                      <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide', style.chip)}>
                        {a.severity}
                      </span>
                    </div>
                    <p className="mt-0.5 break-words text-xs text-muted">{a.detail}</p>
                    {a.childWalletId && (
                      <p className="mt-1 flex items-center gap-1 text-[10px] text-muted">
                        <Wallet className="h-3 w-3" /> wallet {a.childWalletId.slice(0, 8)}…
                      </p>
                    )}
                  </div>
                  {a.amountCents != null && (
                    <p className={cn('flex-shrink-0 text-sm font-bold',
                      a.amountCents < 0 ? 'text-danger' : 'text-fg')}>
                      {formatCents(a.amountCents)}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Reversal summary footer */}
      <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 text-sm text-muted">
        <RotateCcw className="h-4 w-4 text-brand-text" />
        <span>{report.reversalCount} {t('adminWalletReconciliationReconciliationClient.reversalTransaction')}{report.reversalCount === 1 ? '' : 's'} {t('adminWalletReconciliationReconciliationClient.inTheLedgerCorrectionsAreMade')}</span>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, color }: { label: string; value: string; icon: typeof Wallet; color: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <Icon className={cn('h-5 w-5', color)} />
      <div className="mt-2 text-xl font-bold">{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

function SeverityCard({ label, count, active, onClick, tone }: {
  label: string; count: number; active: boolean; onClick: () => void; tone: Anomaly['severity'];
}) {
  const toneCls = tone === 'high' ? 'text-danger' : tone === 'medium' ? 'text-amber-500' : 'text-muted';
  return (
    <button type="button" onClick={onClick}
      className={cn('rounded-2xl border p-4 text-left transition',
        active ? 'border-brand bg-brand/5' : 'border-border bg-surface/40 hover:border-brand/30')}>
      <div className={cn('text-2xl font-black', count > 0 ? toneCls : 'text-muted')}>{count}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </button>
  );
}

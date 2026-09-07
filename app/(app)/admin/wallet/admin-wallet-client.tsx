'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Wallet, Users, Gift, ShieldCheck, TrendingUp, TrendingDown, Scale, Flag, ScrollText,
} from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { adminToggleFeatureFlagAction } from '@/app/(app)/admin/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type FlagRow = { key: string; enabled: boolean; description: string | null };
export type AuditRow = {
  id: string; familyId: string; action: string; entityType: string | null; detail: string | null; createdAt: string;
};
type Stats = {
  activeWallets: number; childWallets: number; pendingGifts: number; pendingApprovals: number;
  creditVolumeCents: number; debitVolumeCents: number; netCents: number;
};

// Stripe flags require business/legal approval — flag them visually so an admin
// doesn't flip them on before the Stripe service layer exists.
const STRIPE_FLAGS = new Set([
  'stripe_payments_enabled', 'stripe_connect_enabled', 'stripe_treasury_enabled',
  'stripe_issuing_enabled', 'physical_cards_enabled', 'custom_card_designs_enabled',
]);

export function AdminWalletClient({ stats, flags, audit }: { stats: Stats; flags: FlagRow[]; audit: AuditRow[] }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busyKey, setBusyKey] = useState<string | null>(null);

  async function toggle(flag: FlagRow) {
    if (busyKey) return;
    setBusyKey(flag.key);
    const res = await adminToggleFeatureFlagAction(flag.key, !flag.enabled);
    setBusyKey(null);
    if (!res.ok) return toastError(res.error ?? 'Could not update flag');
    success(`${flag.key} ${!flag.enabled ? 'enabled' : 'disabled'}`);
    router.refresh();
  }

  const STAT_CARDS = [
    { label: 'Active Wallets', value: String(stats.activeWallets), icon: Wallet, color: 'text-brand-text' },
    { label: 'Child Wallets', value: String(stats.childWallets), icon: Users, color: 'text-blue-400' },
    { label: 'Pending Gifts', value: String(stats.pendingGifts), icon: Gift, color: 'text-pink-400' },
    { label: 'Pending Approvals', value: String(stats.pendingApprovals), icon: ShieldCheck, color: 'text-amber-400' },
  ];

  return (
    <div className="space-y-6">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {STAT_CARDS.map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-surface/40 p-4">
            <s.icon className={cn('h-5 w-5', s.color)} />
            <div className="mt-2 text-2xl font-bold">{s.value}</div>
            <div className="text-[11px] text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Ledger volume */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <div className="flex items-center gap-2 text-xs text-muted"><TrendingUp className="h-4 w-4 text-green-400" /> {t('adminWalletAdminWalletClient.totalCredits')}</div>
          <div className="mt-1 text-xl font-bold text-green-400">{formatCents(stats.creditVolumeCents)}</div>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <div className="flex items-center gap-2 text-xs text-muted"><TrendingDown className="h-4 w-4 text-rose-400" /> {t('adminWalletAdminWalletClient.totalDebits')}</div>
          <div className="mt-1 text-xl font-bold text-rose-400">{formatCents(stats.debitVolumeCents)}</div>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <div className="flex items-center gap-2 text-xs text-muted"><Scale className="h-4 w-4 text-brand-text" /> {t('adminWalletAdminWalletClient.netOutstanding')}</div>
          <div className="mt-1 text-xl font-bold">{formatCents(stats.netCents)}</div>
        </div>
      </div>
      <p className="-mt-3 text-[11px] text-muted">
        Net outstanding = total credits − total debits across all families&apos; immutable ledgers
        (the sum of every child&apos;s current balance).
      </p>

      {/* Feature flags */}
      <div>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Flag className="h-4 w-4" /> {t('adminWalletAdminWalletClient.featureFlags')}</h2>
        <div className="overflow-hidden rounded-2xl border border-border bg-surface/40 divide-y divide-border/50">
          {flags.map((flag) => {
            const isStripe = STRIPE_FLAGS.has(flag.key);
            return (
              <div key={flag.key} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="text-xs font-semibold">{flag.key}</code>
                    {isStripe && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber-400">{t('adminWalletClient.stripeNeedsApproval')}</span>
                    )}
                  </div>
                  {flag.description && <div className="mt-0.5 text-[11px] text-muted">{flag.description}</div>}
                </div>
                <button onClick={() => toggle(flag)} disabled={busyKey === flag.key}
                  className={cn('relative h-6 w-11 flex-shrink-0 rounded-full transition disabled:opacity-50',
                    flag.enabled ? (isStripe ? 'bg-amber-500' : 'bg-brand') : 'bg-elevated')}>
                  <div className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', flag.enabled ? 'left-[22px]' : 'left-0.5')} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recent audit */}
      <div>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><ScrollText className="h-4 w-4" /> {t('adminWalletAdminWalletClient.recentWalletActivity')}</h2>
        {audit.length === 0 ? (
          <p className="rounded-2xl border border-border bg-surface/40 p-4 text-sm text-muted">{t('adminWalletAdminWalletClient.noWalletAuditActivityYet')}</p>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/40 divide-y divide-border/50">
            {audit.map((a) => (
              <div key={a.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-brand/10">
                  <Wallet className="h-4 w-4 text-brand-text" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{a.detail ?? a.action}</div>
                  <div className="text-[11px] text-muted">
                    <code>{a.action}</code>{a.entityType ? ` · ${a.entityType}` : ''} · {new Date(a.createdAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

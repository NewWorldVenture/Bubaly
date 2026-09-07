'use client';

// Wallet settings — per-child allocation rules. Sets the bucket split (Spend /
// Save / Give / Invest, must sum to 100%), gift auto-accept, and the parent
// approval threshold. Drives how every credit (top-up, allowance, chore, gift)
// is allocated by `creditChildWallet`.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SlidersHorizontal, ShieldCheck, Gift, Save } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { formatCents, type Split } from '@/lib/wallet/ledger';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { saveWalletRuleAction } from '@/app/(app)/wallet/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type ChildRuleRow = {
  childWalletId: string; name: string; color: string | null;
  split: Split; autoAcceptGifts: boolean; requireApprovalOverCents: number;
};

const BUCKETS: { key: keyof Split; label: string; color: string }[] = [
  { key: 'spend',  label: 'Spend',  color: 'bg-blue-500' },
  { key: 'save',   label: 'Save',   color: 'bg-green-500' },
  { key: 'give',   label: 'Give',   color: 'bg-pink-500' },
  { key: 'invest', label: 'Invest', color: 'bg-violet-500' },
];

export function WalletSettingsView({ rows, canManage }: { rows: ChildRuleRow[]; canManage: boolean }) {
  const t = useTranslations();
  return (
    <div className="module-page">
      <PageHeader title={t('walletSettings.familyWallet')} description={t('walletSettingsView.setHowEachChildS')} />
      <WalletSubnav />

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-border bg-surface/40 p-4 text-sm text-muted">
          {t('walletSettings.noChildWalletsYetActivateThe')}
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => <ChildRuleCard key={row.childWalletId} row={row} canManage={canManage} />)}
        </div>
      )}
    </div>
  );
}

function ChildRuleCard({ row, canManage }: { row: ChildRuleRow; canManage: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [split, setSplit] = useState<Split>(row.split);
  const [autoAccept, setAutoAccept] = useState(row.autoAcceptGifts);
  const [threshold, setThreshold] = useState((row.requireApprovalOverCents / 100).toString());
  const [saving, setSaving] = useState(false);

  const sum = split.spend + split.save + split.give + split.invest;
  const dirty = sum !== 100
    || split.spend !== row.split.spend || split.save !== row.split.save
    || split.give !== row.split.give || split.invest !== row.split.invest
    || autoAccept !== row.autoAcceptGifts
    || Math.round(parseFloat(threshold || '0') * 100) !== row.requireApprovalOverCents;

  function setBucket(key: keyof Split, value: number) {
    setSplit((s) => ({ ...s, [key]: Math.max(0, Math.min(100, value)) }));
  }

  async function save() {
    if (saving) return;
    if (sum !== 100) return toastError(`Split must total 100% (currently ${sum}%).`);
    const requireApprovalOverCents = Math.round(parseFloat(threshold || '0') * 100);
    if (!Number.isFinite(requireApprovalOverCents) || requireApprovalOverCents < 0) return toastError('Enter a valid approval threshold.');
    setSaving(true);
    const res = await saveWalletRuleAction({
      childWalletId: row.childWalletId, split, autoAcceptGifts: autoAccept, requireApprovalOverCents,
    });
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Could not save settings');
    success(`${row.name}'s wallet settings saved`);
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex items-center gap-3">
        <Avatar name={row.name} color={row.color ?? undefined} size={36} />
        <div className="flex-1">
          <div className="text-sm font-semibold">{row.name}</div>
          <div className="text-[11px] text-muted">{t('walletSettings.allocationApprovalRules')}</div>
        </div>
      </div>

      {/* Split bar */}
      <div className="mt-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-xs font-semibold"><SlidersHorizontal className="h-3.5 w-3.5" /> {t('walletSettings.bucketSplit')}</span>
          <span className={cn('text-xs font-bold', sum === 100 ? 'text-green-400' : 'text-amber-400')}>{sum}%</span>
        </div>
        <div className="flex h-2.5 overflow-hidden rounded-full bg-elevated">
          {BUCKETS.map((b) => split[b.key] > 0 && (
            <div key={b.key} className={cn('h-full transition-all', b.color)} style={{ width: `${split[b.key]}%` }} />
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {BUCKETS.map((b) => (
            <div key={b.key} className="rounded-xl border border-border bg-background/40 p-2.5">
              <div className="mb-1 flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-full', b.color)} />
                <span className="text-[11px] font-medium text-muted">{b.label}</span>
              </div>
              <div className="flex items-center gap-1">
                <input type="number" min={0} max={100} value={split[b.key]} disabled={!canManage}
                  onChange={(e) => setBucket(b.key, parseInt(e.target.value || '0', 10))}
                  className="w-full rounded-lg border border-border bg-surface px-2 py-1 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60" />
                <span className="text-xs text-muted">%</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Toggles */}
      <div className="mt-4 space-y-2">
        <button type="button" disabled={!canManage} onClick={() => setAutoAccept((v) => !v)}
          className="flex w-full items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-2.5 text-left transition hover:bg-elevated disabled:opacity-60">
          <Gift className="h-4 w-4 flex-shrink-0 text-pink-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t('walletSettings.autoAcceptGifts')}</div>
            <div className="text-[11px] text-muted">{t('walletSettings.giftsApplyInstantlyWithoutParentApproval')}</div>
          </div>
          <div className={cn('relative h-6 w-11 flex-shrink-0 rounded-full transition', autoAccept ? 'bg-brand' : 'bg-elevated')}>
            <div className={cn('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', autoAccept ? 'left-[22px]' : 'left-0.5')} />
          </div>
        </button>

        <div className="flex items-center gap-3 rounded-xl border border-border bg-background/40 px-3 py-2.5">
          <ShieldCheck className="h-4 w-4 flex-shrink-0 text-amber-400" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t('walletSettings.approvalThreshold')}</div>
            <div className="text-[11px] text-muted">{t('walletSettings.spendsAboveThisNeedAParent')}</div>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted">$</span>
            <input type="number" min={0} step="5" value={threshold} disabled={!canManage}
              onChange={(e) => setThreshold(e.target.value)}
              className="w-20 rounded-lg border border-border bg-surface px-2 py-1 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand/30 disabled:opacity-60" />
          </div>
        </div>
      </div>

      {canManage && (
        <div className="mt-4 flex items-center justify-end gap-2">
          {sum !== 100 && <span className="text-[11px] text-amber-400">{t('walletSettings.splitMustTotal100')}</span>}
          <Button onClick={save} loading={saving} disabled={!dirty || sum !== 100}>
            <Save className="h-3.5 w-3.5" /> {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </div>
  );
}

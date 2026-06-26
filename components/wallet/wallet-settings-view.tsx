'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Settings, SlidersHorizontal, ShieldCheck, CircleDollarSign } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Avatar } from '@/components/ui/avatar';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { formatCents, DEFAULT_SPLIT, type Split } from '@/lib/wallet/ledger';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { updateWalletRuleAction } from '@/app/(app)/wallet/actions';

export type ChildWalletRule = {
  childWalletId: string;
  name: string;
  split: Split;
  autoAcceptGifts: boolean;
  requireApprovalOverCents: number;
};

const BUCKETS: { key: keyof Split; label: string; color: string }[] = [
  { key: 'spend', label: 'Spend', color: 'bg-blue-500' },
  { key: 'save', label: 'Save', color: 'bg-emerald-500' },
  { key: 'give', label: 'Give', color: 'bg-rose-500' },
  { key: 'invest', label: 'Invest', color: 'bg-amber-500' },
];

type Props = { rules: ChildWalletRule[]; canManage: boolean };

export function WalletSettingsView({ rules, canManage }: Props) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [editing, setEditing] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { split: Split; autoAccept: boolean; approvalThreshold: string }>>({});
  const [saving, setSaving] = useState(false);

  function startEdit(rule: ChildWalletRule) {
    setDrafts(d => ({
      ...d,
      [rule.childWalletId]: {
        split: { ...rule.split },
        autoAccept: rule.autoAcceptGifts,
        approvalThreshold: String(rule.requireApprovalOverCents / 100),
      },
    }));
    setEditing(rule.childWalletId);
  }

  function setPercent(walletId: string, key: keyof Split, value: number) {
    setDrafts(d => {
      const current = d[walletId];
      if (!current) return d;
      const clamped = Math.max(0, Math.min(100, Math.round(value)));
      return { ...d, [walletId]: { ...current, split: { ...current.split, [key]: clamped } } };
    });
  }

  function splitTotal(walletId: string) {
    const draft = drafts[walletId];
    if (!draft) return 100;
    return draft.split.spend + draft.split.save + draft.split.give + draft.split.invest;
  }

  async function save(walletId: string) {
    const draft = drafts[walletId];
    if (!draft) return;
    const total = splitTotal(walletId);
    if (Math.abs(total - 100) > 0.01) {
      toastError(`Percentages must sum to 100 (currently ${total})`);
      return;
    }
    setSaving(true);
    const threshold = parseFloat(draft.approvalThreshold);
    const res = await updateWalletRuleAction({
      childWalletId: walletId,
      split: draft.split,
      autoAcceptGifts: draft.autoAccept,
      requireApprovalOverCents: Number.isFinite(threshold) ? Math.round(threshold * 100) : 5000,
    });
    setSaving(false);
    if (!res.ok) { toastError(res.error ?? 'Save failed'); return; }
    success('Wallet settings saved');
    setEditing(null);
    router.refresh();
  }

  return (
    <div className="module-page">
      <PageHeader title="Wallet Settings" description="Per-child allocation splits and approval rules." />
      <WalletSubnav />

      {rules.length === 0 && (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <Settings className="mx-auto mb-3 h-8 w-8 text-muted" />
          <p className="font-semibold text-fg">No child wallets found</p>
          <p className="mt-1 text-sm text-muted">Activate the Family Wallet first to configure per-child settings.</p>
        </div>
      )}

      <div className="space-y-4">
        {rules.map((rule) => {
          const isEditing = editing === rule.childWalletId;
          const draft = drafts[rule.childWalletId];
          const displaySplit = isEditing && draft ? draft.split : rule.split;
          const total = isEditing ? splitTotal(rule.childWalletId) : 100;
          const overBudget = Math.abs(total - 100) > 0.01;

          return (
            <div key={rule.childWalletId} className="rounded-2xl border border-border bg-surface/40 overflow-hidden">
              {/* Header */}
              <div className="flex items-center gap-3 p-4">
                <Avatar name={rule.name} size={36} className="rounded-full" />
                <div className="flex-1">
                  <p className="font-semibold text-fg">{rule.name}</p>
                  <p className="text-xs text-muted">
                    Spend {rule.split.spend}% · Save {rule.split.save}% · Give {rule.split.give}% · Invest {rule.split.invest}%
                  </p>
                </div>
                {canManage && !isEditing && (
                  <button onClick={() => startEdit(rule)} className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-1.5 text-xs font-medium text-muted hover:border-brand/40 hover:text-brand">
                    <SlidersHorizontal className="h-3.5 w-3.5" /> Edit
                  </button>
                )}
              </div>

              {/* Split bar */}
              <div className="px-4 pb-3">
                <div className="flex h-2 w-full overflow-hidden rounded-full">
                  {BUCKETS.map((b) => (
                    <div key={b.key} className={cn('transition-all', b.color)} style={{ width: `${displaySplit[b.key]}%` }} />
                  ))}
                </div>
              </div>

              {/* Edit form */}
              {isEditing && draft && (
                <div className="border-t border-border p-4 space-y-4">
                  <div>
                    <p className="mb-2 text-sm font-medium flex items-center gap-1.5">
                      <SlidersHorizontal className="h-4 w-4" /> Bucket allocation
                      <span className={cn('ml-auto text-xs font-semibold', overBudget ? 'text-red-400' : 'text-emerald-400')}>
                        {total}% {overBudget ? '— must equal 100' : '✓'}
                      </span>
                    </p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {BUCKETS.map((b) => (
                        <div key={b.key}>
                          <label className="mb-1 flex items-center gap-1.5 text-xs font-medium">
                            <span className={cn('h-2.5 w-2.5 rounded-full', b.color)} />
                            {b.label}
                          </label>
                          <div className="relative">
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={draft.split[b.key]}
                              onChange={(e) => setPercent(rule.childWalletId, b.key, parseFloat(e.target.value) || 0)}
                              className="h-9 w-full rounded-lg border border-border bg-bg pr-6 pl-3 text-sm"
                            />
                            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted">%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-sm font-medium flex items-center gap-1.5">
                      <CircleDollarSign className="h-4 w-4" /> Approval rules
                    </p>
                    <div className="space-y-2">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={draft.autoAccept}
                          onChange={(e) => setDrafts(d => ({ ...d, [rule.childWalletId]: { ...d[rule.childWalletId], autoAccept: e.target.checked } }))}
                          className="rounded"
                        />
                        <span className="text-sm">Auto-accept gifts (skip parent approval)</span>
                      </label>
                      <div className="flex items-center gap-2">
                        <label className="text-sm text-muted whitespace-nowrap">Require approval over</label>
                        <div className="relative w-28">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted">$</span>
                          <input
                            type="number"
                            min="0"
                            step="5"
                            value={draft.approvalThreshold}
                            onChange={(e) => setDrafts(d => ({ ...d, [rule.childWalletId]: { ...d[rule.childWalletId], approvalThreshold: e.target.value } }))}
                            className="h-9 w-full rounded-lg border border-border bg-bg pl-6 pr-2 text-sm"
                          />
                        </div>
                        <span className="text-sm text-muted">per transaction</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex gap-2 pt-1">
                    <button onClick={() => setEditing(null)} className="flex-1 rounded-xl border border-border py-2 text-sm font-medium text-muted hover:text-fg">Cancel</button>
                    <button
                      onClick={() => save(rule.childWalletId)}
                      disabled={saving || overBudget}
                      className={cn('flex-1 rounded-xl py-2 text-sm font-semibold text-white transition', saving || overBudget ? 'bg-brand/40' : 'bg-brand hover:bg-brand/90')}
                    >
                      {saving ? 'Saving…' : 'Save settings'}
                    </button>
                  </div>
                </div>
              )}

              {/* Auto-accept + approval summary when not editing */}
              {!isEditing && (
                <div className="border-t border-border px-4 py-2.5 flex gap-4 text-xs text-muted">
                  <span className="flex items-center gap-1">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    {rule.autoAcceptGifts ? 'Gifts auto-accepted' : 'Gifts need approval'}
                  </span>
                  <span>Approve transactions over {formatCents(rule.requireApprovalOverCents)}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

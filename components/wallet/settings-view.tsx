'use client';

// Family Wallet settings — the per-child allocation editor ("Parents decide how
// money is automatically divided"). Edits wallet_rules.split (must total 100%);
// new credits allocate by this rule via the immutable ledger. 100% Supabase-wired
// through saveWalletSplitAction.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SlidersHorizontal, RotateCcw, PiggyBank, ShoppingBag, HandHeart, TrendingUp } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { DEFAULT_SPLIT, SPLIT_ORDER, allocate, splitTotal, isValidSplit, formatCents, type Split } from '@/lib/wallet/ledger';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import { saveWalletSplitAction } from '@/app/(app)/wallet/actions';

export type SplitChild = { id: string; name: string; color: string | null; split: Split };

const BUCKET_META: Record<keyof Split, { label: string; icon: typeof PiggyBank; cls: string }> = {
  save: { label: 'Save', icon: PiggyBank, cls: 'text-emerald-500' },
  spend: { label: 'Spend', icon: ShoppingBag, cls: 'text-sky-500' },
  give: { label: 'Give', icon: HandHeart, cls: 'text-rose-500' },
  invest: { label: 'Invest', icon: TrendingUp, cls: 'text-violet-500' },
};
const PREVIEW_CENTS = 10000; // $100 sample

export function WalletSettingsView({ childWallets, canManage }: { childWallets: SplitChild[]; canManage: boolean }) {
  return (
    <div>
      <WalletSubnav />
      <PageHeader title="Allocation" description="Decide how each child's incoming money is automatically divided. Every gift, allowance and chore reward splits this way — instantly." />
      {childWallets.length === 0 ? (
        <EmptyState icon={SlidersHorizontal} title="No child wallets yet" description="Add child members and activate the Family Wallet to set allocations." />
      ) : (
        <div className="mt-4 space-y-4">
          {childWallets.map((c) => <ChildSplitCard key={c.id} child={c} canManage={canManage} />)}
        </div>
      )}
    </div>
  );
}

function ChildSplitCard({ child, canManage }: { child: SplitChild; canManage: boolean }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [split, setSplit] = useState<Split>(child.split);
  const [saving, setSaving] = useState(false);

  const total = splitTotal(split);
  const valid = isValidSplit(split);
  const dirty = SPLIT_ORDER.some((k) => split[k] !== child.split[k]);
  const preview = valid ? allocate(PREVIEW_CENTS, split) : null;

  function setBucket(k: keyof Split, raw: string) {
    const n = Math.max(0, Math.min(100, Math.round(Number(raw) || 0)));
    setSplit((s) => ({ ...s, [k]: n }));
  }

  async function save() {
    if (!valid) return toastError('Percentages must total 100%.');
    setSaving(true);
    const res = await saveWalletSplitAction({ childWalletId: child.id, split });
    setSaving(false);
    if (!res.ok) return toastError(res.error ?? 'Could not save allocation');
    success(`Allocation saved for ${child.name}`);
    router.refresh();
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Avatar name={child.name} color={child.color ?? undefined} size={36} className="rounded-full" />
          <p className="font-semibold">{child.name}</p>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${total === 100 ? 'bg-success/15 text-success' : 'bg-amber-500/15 text-amber-500'}`}>
          {total}% {total === 100 ? '✓' : 'of 100%'}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SPLIT_ORDER.map((k) => {
          const m = BUCKET_META[k];
          return (
            <label key={k} className="rounded-xl border border-border bg-bg/40 p-3">
              <span className={`flex items-center gap-1.5 text-xs font-medium ${m.cls}`}><m.icon className="h-3.5 w-3.5" /> {m.label}</span>
              <span className="mt-2 flex items-center gap-1">
                <input
                  type="number" min={0} max={100} value={split[k]} disabled={!canManage}
                  onChange={(e) => setBucket(k, e.target.value)}
                  className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-lg font-bold focus-ring disabled:opacity-60"
                />
                <span className="text-muted">%</span>
              </span>
              {preview && <span className="mt-1 block text-[11px] text-muted">{formatCents(preview[k])} of $100</span>}
            </label>
          );
        })}
      </div>

      {canManage && (
        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button" onClick={() => setSplit(DEFAULT_SPLIT)}
            className="inline-flex items-center gap-1 text-xs text-muted hover:text-fg"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Balanced (40/40/10/10)
          </button>
          <Button onClick={save} loading={saving} disabled={!valid || !dirty}>Save allocation</Button>
        </div>
      )}
    </div>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '@/components/ui/toast';
import { ArrowLeft, Snowflake, Unlock, X, CheckCircle2, XCircle, Save } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { freezeCardAction, unfreezeCardAction, cancelCardAction, updateCardControlsAction } from '@/app/(app)/money/actions';
import type { CardControls } from '@/lib/stripe/issuing';

type CardData = {
  cardId: string;
  type: 'virtual' | 'physical';
  status: 'active' | 'inactive' | 'canceled';
  last4: string | null;
  brand: string | null;
  expMonth: number | null;
  expYear: number | null;
  memberName: string;
  memberColor: string | null;
};

type ControlsData = {
  daily_limit_cents: number | null;
  weekly_limit_cents: number | null;
  monthly_limit_cents: number | null;
  per_txn_limit_cents: number | null;
  allow_online: boolean;
  allow_in_store: boolean;
  allow_atm: boolean;
  blocked_categories: string[];
  parent_approval_threshold_cents: number | null;
} | null;

type AuthData = {
  id: string;
  status: 'pending' | 'approved' | 'declined' | 'reversed' | 'closed';
  decision: 'approved' | 'declined' | null;
  amountCents: number;
  merchantName: string | null;
  merchantCategory: string | null;
  authorizedAt: string;
};

type Props = {
  card: CardData;
  controls: ControlsData;
  authorizations: AuthData[];
};

export function CardDetail({ card, controls, authorizations }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  // Controls form state
  const [daily, setDaily] = useState(controls?.daily_limit_cents ? String(controls.daily_limit_cents / 100) : '');
  const [weekly, setWeekly] = useState(controls?.weekly_limit_cents ? String(controls.weekly_limit_cents / 100) : '');
  const [monthly, setMonthly] = useState(controls?.monthly_limit_cents ? String(controls.monthly_limit_cents / 100) : '');
  const [perTxn, setPerTxn] = useState(controls?.per_txn_limit_cents ? String(controls.per_txn_limit_cents / 100) : '');
  const [allowOnline, setAllowOnline] = useState(controls?.allow_online ?? true);
  const [allowInStore, setAllowInStore] = useState(controls?.allow_in_store ?? true);
  const [allowAtm, setAllowAtm] = useState(controls?.allow_atm ?? false);
  const [threshold, setThreshold] = useState(controls?.parent_approval_threshold_cents ? String(controls.parent_approval_threshold_cents / 100) : '');
  const [saved, setSaved] = useState(false);

  async function handleFreeze() {
    setBusy('freeze');
    const res = await freezeCardAction({ cardId: card.cardId });
    setBusy(null);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    toastSuccess('Card frozen');
    startTransition(() => router.refresh());
  }

  async function handleUnfreeze() {
    setBusy('unfreeze');
    const res = await unfreezeCardAction({ cardId: card.cardId });
    setBusy(null);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    toastSuccess('Card unfrozen');
    startTransition(() => router.refresh());
  }

  async function handleCancel() {
    setBusy('cancel');
    const res = await cancelCardAction({ cardId: card.cardId });
    setBusy(null);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    router.push('/money/cards');
  }

  async function handleSaveControls() {
    setBusy('save');
    const updated: CardControls = {
      dailyLimitCents: daily ? Math.round(parseFloat(daily) * 100) : undefined,
      weeklyLimitCents: weekly ? Math.round(parseFloat(weekly) * 100) : undefined,
      monthlyLimitCents: monthly ? Math.round(parseFloat(monthly) * 100) : undefined,
      perTransactionLimitCents: perTxn ? Math.round(parseFloat(perTxn) * 100) : undefined,
      allowOnline,
      allowInStore,
      allowAtm,
      blockedCategories: controls?.blocked_categories ?? [],
      parentApprovalThresholdCents: threshold ? Math.round(parseFloat(threshold) * 100) : undefined,
    };
    const res = await updateCardControlsAction({ cardId: card.cardId, controls: updated });
    setBusy(null);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    toastSuccess('Spending controls saved');
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  const isCanceled = card.status === 'canceled';

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/money/cards" className="rounded-lg p-2 text-muted hover:bg-elevated">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <h1 className="text-2xl font-bold text-fg">Card details</h1>
      </div>

      {/* Card visual */}
      <div
        className="relative h-44 w-72 rounded-2xl p-5 text-white shadow-xl overflow-hidden"
        style={{ background: card.memberColor ? `linear-gradient(135deg, ${card.memberColor}, ${card.memberColor}99)` : 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
      >
        <div className="mb-6 flex items-start justify-between">
          <div>
            <p className="text-xs opacity-70">BUBALY</p>
            <p className="font-bold">{card.memberName}</p>
          </div>
          <span className={cn(
            'rounded-full px-2 py-0.5 text-xs font-semibold',
            card.status === 'active' ? 'bg-white/20' : card.status === 'inactive' ? 'bg-amber-400/30' : 'bg-red-400/30',
          )}>
            {card.status === 'inactive' ? 'Frozen' : card.status}
          </span>
        </div>
        <p className="mb-3 font-mono text-lg tracking-widest">•••• •••• •••• {card.last4 ?? '????'}</p>
        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs opacity-70">EXPIRES</p>
            <p className="text-sm">{card.expMonth ?? '??'}/{String(card.expYear ?? '??').slice(-2)}</p>
          </div>
          <p className="text-lg font-bold opacity-80">{card.brand ?? 'VISA'}</p>
        </div>
      </div>

      {/* Card actions */}
      {!isCanceled && (
        <div className="flex flex-wrap gap-2">
          {card.status === 'active' && (
            <button onClick={handleFreeze} disabled={busy === 'freeze'}
              className="inline-flex items-center gap-2 rounded-xl border border-border px-4 py-2 text-sm font-medium text-fg hover:bg-elevated disabled:opacity-50">
              <Snowflake className="h-4 w-4 text-blue-500" />
              {busy === 'freeze' ? 'Freezing…' : 'Freeze card'}
            </button>
          )}
          {card.status === 'inactive' && (
            <button onClick={handleUnfreeze} disabled={busy === 'unfreeze'}
              className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-50">
              <Unlock className="h-4 w-4" />
              {busy === 'unfreeze' ? 'Unfreezing…' : 'Unfreeze card'}
            </button>
          )}
          {cancelConfirm ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-red-600">Cancel permanently?</span>
              <button onClick={handleCancel} disabled={busy === 'cancel'}
                className="rounded-xl bg-red-500 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50">
                {busy === 'cancel' ? 'Canceling…' : 'Yes, cancel'}
              </button>
              <button onClick={() => setCancelConfirm(false)} className="text-sm text-muted hover:text-fg">Nevermind</button>
            </div>
          ) : (
            <button onClick={() => setCancelConfirm(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/30">
              <X className="h-4 w-4" /> Cancel card
            </button>
          )}
        </div>
      )}

      {/* Spending controls */}
      {!isCanceled && (
        <section className="rounded-xl border border-border bg-surface/50 p-5 space-y-4">
          <h2 className="font-semibold text-fg">Spending controls</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Daily limit', value: daily, onChange: setDaily },
              { label: 'Weekly limit', value: weekly, onChange: setWeekly },
              { label: 'Monthly limit', value: monthly, onChange: setMonthly },
              { label: 'Per-transaction', value: perTxn, onChange: setPerTxn },
              { label: 'Parent approval above', value: threshold, onChange: setThreshold },
            ].map((field) => (
              <div key={field.label}>
                <label className="mb-1 block text-xs font-medium text-muted">{field.label}</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted">$</span>
                  <input
                    type="number" min="0" step="1"
                    value={field.value}
                    onChange={(e) => field.onChange(e.target.value)}
                    className="w-full rounded-xl border border-border bg-surface px-7 py-2 text-sm outline-none focus:border-brand"
                    placeholder="No limit"
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted">Allowed channels</p>
            {[
              { label: 'Online purchases', value: allowOnline, onChange: setAllowOnline },
              { label: 'In-store purchases', value: allowInStore, onChange: setAllowInStore },
              { label: 'ATM withdrawals', value: allowAtm, onChange: setAllowAtm },
            ].map((toggle) => (
              <label key={toggle.label} className="flex cursor-pointer items-center justify-between py-1">
                <span className="text-sm text-fg">{toggle.label}</span>
                <button
                  onClick={() => toggle.onChange(!toggle.value)}
                  className={cn(
                    'relative h-5 w-9 rounded-full transition',
                    toggle.value ? 'bg-brand' : 'bg-elevated',
                  )}
                >
                  <span className={cn(
                    'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform',
                    toggle.value ? 'translate-x-4' : 'translate-x-0.5',
                  )} />
                </button>
              </label>
            ))}
          </div>

          <button
            onClick={handleSaveControls}
            disabled={busy === 'save'}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60"
          >
            {saved ? <CheckCircle2 className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {busy === 'save' ? 'Saving…' : saved ? 'Saved!' : 'Save controls'}
          </button>
        </section>
      )}

      {/* Authorization history */}
      {authorizations.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold text-fg">Authorization history</h2>
          <div className="rounded-xl border border-border bg-surface/50 divide-y divide-border">
            {authorizations.map((auth) => (
              <div key={auth.id} className="flex items-center gap-3 px-4 py-3">
                <div className={cn(
                  'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white',
                  auth.decision === 'approved' ? 'bg-green-500' : 'bg-red-500',
                )}>
                  {auth.decision === 'approved' ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{auth.merchantName ?? 'Unknown'}</p>
                  <p className="text-xs text-muted capitalize">{auth.merchantCategory?.replace(/_/g, ' ') ?? ''} · {new Date(auth.authorizedAt).toLocaleDateString()}</p>
                </div>
                <span className="text-sm font-semibold text-fg">{formatCents(auth.amountCents)}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { CreditCard, Plus, Lock, Unlock, X, Settings, ChevronDown, ChevronUp, Snowflake, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { freezeCardAction, unfreezeCardAction, cancelCardAction, createCardAction } from '@/app/(app)/money/actions';
import type { CardControls } from '@/lib/stripe/issuing';

const DEFAULT_CONTROLS: CardControls = {
  allowOnline: true,
  allowInStore: true,
  allowAtm: false,
  blockedCategories: [],
  dailyLimitCents: undefined,
  weeklyLimitCents: undefined,
  monthlyLimitCents: undefined,
  perTransactionLimitCents: undefined,
  parentApprovalThresholdCents: undefined,
};

type CardView = {
  id: string;
  card_id: string;
  child_wallet_id: string | null;
  type: string;
  status: string;
  last4: string | null;
  brand: string | null;
  exp_month: number | null;
  exp_year: number | null;
  memberName: string;
  memberColor: string | null;
  controls: {
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
};

type WalletOption = { id: string; memberId: string; memberName: string };
type DesignOption = { id: string; name: string; stripeDesignId: string | null; requiresPhysical: boolean };

type Props = {
  cards: CardView[];
  wallets: WalletOption[];
  manager: boolean;
  isReady: boolean;
  designs: DesignOption[];
};

export function CardManager({ cards, wallets, manager, isReady, designs }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showOrder, setShowOrder] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState<string | null>(null);

  // Order card form state
  const [orderWallet, setOrderWallet] = useState(wallets[0]?.id ?? '');
  const [orderType, setOrderType] = useState<'virtual' | 'physical'>('virtual');
  const [orderDesign, setOrderDesign] = useState('');
  const [dailyLimit, setDailyLimit] = useState('');
  const [memberName, setMemberName] = useState('');

  function toastError(msg: string) {
    alert(`Error: ${msg}`);
  }

  async function handleFreeze(cardId: string) {
    setBusy(cardId + '_freeze');
    const res = await freezeCardAction({ cardId });
    setBusy(null);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    startTransition(() => router.refresh());
  }

  async function handleUnfreeze(cardId: string) {
    setBusy(cardId + '_unfreeze');
    const res = await unfreezeCardAction({ cardId });
    setBusy(null);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    startTransition(() => router.refresh());
  }

  async function handleCancel(cardId: string) {
    setBusy(cardId + '_cancel');
    const res = await cancelCardAction({ cardId });
    setBusy(null);
    setCancelConfirm(null);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    startTransition(() => router.refresh());
  }

  async function handleOrderCard() {
    if (!orderWallet || !memberName.trim()) { toastError('Select a child and enter a name'); return; }
    setBusy('order');
    const controls: CardControls = {
      ...DEFAULT_CONTROLS,
      dailyLimitCents: dailyLimit ? Math.round(parseFloat(dailyLimit) * 100) : undefined,
    };
    const wallet = wallets.find((w) => w.id === orderWallet);
    const res = await createCardAction({
      childWalletId: orderWallet,
      type: orderType,
      controls,
      designId: orderDesign || undefined,
      memberName: memberName.trim(),
      billingAddress: {
        line1: '123 Family St',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94102',
        country: 'US',
      },
    });
    setBusy(null);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    setShowOrder(false);
    startTransition(() => router.refresh());
  }

  const activeCards = cards.filter((c) => c.status !== 'canceled');
  const canceledCards = cards.filter((c) => c.status === 'canceled');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-fg">Cards</h1>
          <p className="text-sm text-muted">{activeCards.length} active card{activeCards.length !== 1 ? 's' : ''}</p>
        </div>
        {manager && isReady && (
          <button
            onClick={() => setShowOrder(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90"
          >
            <Plus className="h-4 w-4" /> Order card
          </button>
        )}
      </div>

      {!isReady && manager && (
        <div className="rounded-xl border border-border bg-surface/50 p-6 text-center">
          <CreditCard className="mx-auto mb-3 h-8 w-8 text-muted" />
          <p className="font-medium text-fg">Complete setup to issue cards</p>
          <p className="mt-1 text-sm text-muted">Complete Stripe verification to issue debit cards.</p>
          <a href="/money/setup" className="mt-3 inline-block text-sm text-brand hover:underline">Complete setup →</a>
        </div>
      )}

      {activeCards.length === 0 && isReady && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <CreditCard className="mx-auto mb-3 h-8 w-8 text-muted" />
          <p className="font-medium text-fg">No cards yet</p>
          <p className="mt-1 text-sm text-muted">Order a virtual or physical debit card for each child.</p>
          {manager && (
            <button onClick={() => setShowOrder(true)} className="mt-3 text-sm text-brand hover:underline">
              Order first card →
            </button>
          )}
        </div>
      )}

      <div className="space-y-3">
        {activeCards.map((card) => {
          const isExpanded = expanded === card.card_id;
          const isBusy = busy?.startsWith(card.card_id);
          return (
            <div key={card.card_id} className="rounded-xl border border-border bg-surface/50 overflow-hidden">
              <div className="flex items-center gap-4 p-4">
                {/* Card visual */}
                <div
                  className="flex h-12 w-16 shrink-0 items-center justify-center rounded-lg text-white text-xs font-bold shadow-md"
                  style={{ background: card.memberColor ? `linear-gradient(135deg, ${card.memberColor}, ${card.memberColor}88)` : 'linear-gradient(135deg, #6366f1, #8b5cf6)' }}
                >
                  {card.brand ?? 'VISA'}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-semibold text-fg">{card.memberName}</p>
                    <span className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium',
                      card.status === 'active' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : card.status === 'inactive' ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                        : 'bg-surface text-muted',
                    )}>
                      {card.status === 'inactive' ? 'Frozen' : card.status}
                    </span>
                    <span className="text-xs text-muted capitalize">{card.type}</span>
                  </div>
                  <p className="text-sm text-muted font-mono">
                    ••••{card.last4 ?? '????'}
                    {card.exp_month && card.exp_year && ` · ${card.exp_month}/${String(card.exp_year).slice(-2)}`}
                  </p>
                </div>

                {manager && (
                  <div className="flex items-center gap-1">
                    {card.status === 'active' && (
                      <button
                        onClick={() => handleFreeze(card.card_id)}
                        disabled={!!isBusy}
                        title="Freeze card"
                        className="rounded-lg p-2 text-muted hover:bg-elevated hover:text-fg disabled:opacity-50"
                      >
                        <Snowflake className="h-4 w-4" />
                      </button>
                    )}
                    {card.status === 'inactive' && (
                      <button
                        onClick={() => handleUnfreeze(card.card_id)}
                        disabled={!!isBusy}
                        title="Unfreeze card"
                        className="rounded-lg p-2 text-brand hover:bg-elevated disabled:opacity-50"
                      >
                        <Unlock className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => setExpanded(isExpanded ? null : card.card_id)}
                      className="rounded-lg p-2 text-muted hover:bg-elevated"
                    >
                      {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                  </div>
                )}
              </div>

              {/* Expanded controls */}
              {isExpanded && manager && (
                <div className="border-t border-border bg-surface/30 p-4 space-y-3">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted">Spending controls</h4>
                  {card.controls ? (
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      {card.controls.daily_limit_cents && (
                        <div className="rounded-lg bg-elevated px-3 py-2">
                          <p className="text-xs text-muted">Daily limit</p>
                          <p className="font-medium text-fg">${(card.controls.daily_limit_cents / 100).toFixed(2)}</p>
                        </div>
                      )}
                      {card.controls.per_txn_limit_cents && (
                        <div className="rounded-lg bg-elevated px-3 py-2">
                          <p className="text-xs text-muted">Per transaction</p>
                          <p className="font-medium text-fg">${(card.controls.per_txn_limit_cents / 100).toFixed(2)}</p>
                        </div>
                      )}
                      <div className="rounded-lg bg-elevated px-3 py-2">
                        <p className="text-xs text-muted">Online</p>
                        <p className="font-medium text-fg">{card.controls.allow_online ? 'Allowed' : 'Blocked'}</p>
                      </div>
                      <div className="rounded-lg bg-elevated px-3 py-2">
                        <p className="text-xs text-muted">ATM</p>
                        <p className="font-medium text-fg">{card.controls.allow_atm ? 'Allowed' : 'Blocked'}</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">No controls set.</p>
                  )}

                  <div className="flex gap-2 pt-2">
                    <a href={`/money/cards/${card.card_id}`}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted hover:bg-elevated">
                      <Settings className="h-3 w-3" /> Manage controls
                    </a>
                    {cancelConfirm === card.card_id ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-red-600">Cancel permanently?</span>
                        <button
                          onClick={() => handleCancel(card.card_id)}
                          disabled={!!isBusy}
                          className="rounded-lg bg-red-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                        >
                          {isBusy ? 'Canceling…' : 'Confirm'}
                        </button>
                        <button onClick={() => setCancelConfirm(null)} className="text-xs text-muted hover:text-fg">
                          Nevermind
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setCancelConfirm(card.card_id)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-800 dark:hover:bg-red-950/30"
                      >
                        <X className="h-3 w-3" /> Cancel card
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Order card modal */}
      {showOrder && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setShowOrder(false)}>
          <div className="w-full max-w-md rounded-t-2xl border border-border bg-bg p-6 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-bold text-fg">Order a new card</h3>
            <div className="space-y-4">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Child</label>
                <select
                  value={orderWallet}
                  onChange={(e) => setOrderWallet(e.target.value)}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand"
                >
                  {wallets.map((w) => <option key={w.id} value={w.id}>{w.memberName}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Cardholder name</label>
                <input
                  type="text"
                  value={memberName}
                  onChange={(e) => setMemberName(e.target.value)}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand"
                  placeholder="Full name on card"
                />
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Card type</label>
                <div className="flex gap-2">
                  {(['virtual', 'physical'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => setOrderType(t)}
                      className={cn(
                        'flex-1 rounded-xl border py-2.5 text-sm font-medium capitalize transition',
                        orderType === t ? 'border-brand bg-brand text-white' : 'border-border text-fg hover:bg-elevated',
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Daily spending limit (optional)</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
                  <input
                    type="number" min="1" max="500" step="1"
                    value={dailyLimit}
                    onChange={(e) => setDailyLimit(e.target.value)}
                    className="w-full rounded-xl border border-border bg-surface pl-7 pr-3 py-2.5 text-sm outline-none focus:border-brand"
                    placeholder="No limit"
                  />
                </div>
              </div>
              {designs.length > 0 && (
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted">Card design</label>
                  <select
                    value={orderDesign}
                    onChange={(e) => setOrderDesign(e.target.value)}
                    className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand"
                  >
                    <option value="">Standard design</option>
                    {designs.filter((d) => orderType === 'physical' || !d.requiresPhysical).map((d) => (
                      <option key={d.id} value={d.stripeDesignId ?? ''}>{d.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="mt-6 flex gap-3">
              <button onClick={() => setShowOrder(false)} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-medium text-muted hover:bg-elevated">
                Cancel
              </button>
              <button
                onClick={handleOrderCard}
                disabled={busy === 'order'}
                className="flex-1 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60"
              >
                {busy === 'order' ? 'Ordering…' : 'Order card'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

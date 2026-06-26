'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import {
  CreditCard, Wallet, TrendingUp, ArrowUpRight, ArrowDownLeft,
  CheckCircle2, XCircle, Clock, Plus, RefreshCw, Zap, ShieldCheck
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { MoneyNav } from '@/components/money/money-nav';
import { CapabilityGate } from '@/components/money/capability-gate';
import { useToast } from '@/components/ui/toast';
import type { StripeCapabilityMatrix } from '@/lib/stripe/capabilities';
import type { WalletTier } from '@/lib/wallet/fees';
import { computeFunding } from '@/lib/wallet/fees';
import {
  activateMoneyAction,
  syncConnectAccountAction,
  refreshCapabilitiesAction,
  createTopupSessionAction,
} from '@/app/(app)/money/actions';

type WalletView = {
  id: string;
  memberId: string;
  memberName: string;
  memberColor: string | null;
  balanceCents: number;
  cards: { cardId: string; type: 'virtual' | 'physical'; status: 'active' | 'inactive' | 'canceled'; last4: string | null; brand: string | null }[];
};

type TxnView = {
  id: string;
  childWalletId: string;
  type: string;
  direction: 'credit' | 'debit';
  amountCents: number;
  description: string;
  createdAt: string;
};

type AuthView = {
  id: string;
  authorizationId: string;
  cardId: string;
  status: 'pending' | 'approved' | 'declined' | 'reversed' | 'closed';
  decision: 'approved' | 'declined' | null;
  amountCents: number;
  merchantName: string | null;
  merchantCategory: string | null;
  authorizedAt: string;
};

type Props = {
  manager: boolean;
  tier: WalletTier;
  capabilities: StripeCapabilityMatrix;
  connectedAccount: { account_id: string; status: string; charges_enabled: boolean; payouts_enabled: boolean } | null;
  wallets: WalletView[];
  recentTransactions: TxnView[];
  recentAuthorizations: AuthView[];
  topupSuccess?: boolean;
};

export function MoneyDashboard({
  manager,
  tier,
  capabilities,
  connectedAccount,
  wallets,
  recentTransactions,
  recentAuthorizations,
  topupSuccess = false,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const { success: toastSuccess, error: toastError } = useToast();

  useEffect(() => {
    if (topupSuccess) {
      toastSuccess('Funds added! The wallet balance will update shortly.');
      // Remove the query param without a full page reload
      const url = new URL(window.location.href);
      url.searchParams.delete('topup');
      window.history.replaceState({}, '', url.toString());
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [topupFor, setTopupFor] = useState<WalletView | null>(null);
  const [topupAmount, setTopupAmount] = useState('');

  const notSetup = !connectedAccount;
  const setupIncomplete = connectedAccount && !connectedAccount.charges_enabled;
  const isReady = connectedAccount?.charges_enabled;

  const totalBalance = wallets.reduce((s, w) => s + w.balanceCents, 0);
  const totalCards = wallets.reduce((s, w) => s + w.cards.filter((c) => c.status === 'active').length, 0);

  async function handleActivate() {
    setBusy('activate');
    const res = await activateMoneyAction();
    setBusy(null);
    if (!res.ok) { toastError(res.error ?? 'Could not activate'); return; }
    router.push('/money/setup');
  }

  async function handleSync() {
    setBusy('sync');
    const res = await syncConnectAccountAction();
    setBusy(null);
    if (!res.ok) { toastError(res.error ?? 'Sync failed'); return; }
    toastSuccess('Account synced');
    startTransition(() => router.refresh());
  }

  async function handleRefreshCaps() {
    setBusy('caps');
    await refreshCapabilitiesAction();
    setBusy(null);
    toastSuccess('Capabilities refreshed');
    startTransition(() => router.refresh());
  }

  async function handleTopup() {
    if (!topupFor) return;
    const cents = Math.round(parseFloat(topupAmount) * 100);
    if (!cents || cents < 100) { toastError('Minimum top-up is $1.00'); return; }

    setBusy('topup');
    const res = await createTopupSessionAction({
      childWalletId: topupFor.id,
      childName: topupFor.memberName,
      amountCents: cents,
    });
    setBusy(null);
    if (!res.ok || !res.url) { toastError(res.error ?? 'Could not start payment'); return; }
    window.location.href = res.url;
  }

  return (
    <div className="space-y-6">
      <MoneyNav />

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-fg">Bubaly Money</h1>
          <p className="text-sm text-muted">Family financial operating system</p>
        </div>
        <div className="flex items-center gap-2">
          {manager && (
            <span className={cn(
              'inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium',
              capabilities.stripeMode === 'live'
                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                : capabilities.stripeMode === 'test'
                ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
                : 'bg-surface text-muted',
            )}>
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              {capabilities.stripeMode === 'live' ? 'Live' : capabilities.stripeMode === 'test' ? 'Test mode' : 'Not configured'}
            </span>
          )}
        </div>
      </div>

      {/* Setup CTA — not yet activated */}
      {manager && notSetup && (
        <div className="rounded-2xl border-2 border-dashed border-brand/30 bg-brand/5 p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-brand/10">
            <Wallet className="h-7 w-7 text-brand" />
          </div>
          <h2 className="mb-2 text-xl font-bold text-fg">Set up Bubaly Money</h2>
          <p className="mb-6 text-sm text-muted max-w-md mx-auto">
            Give every child a real spending wallet with prepaid debit cards, spending controls, and instant transfers — all parent-managed.
          </p>
          <button
            onClick={handleActivate}
            disabled={busy === 'activate'}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-6 py-3 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60"
          >
            <Zap className="h-4 w-4" />
            {busy === 'activate' ? 'Setting up…' : 'Get started'}
          </button>
        </div>
      )}

      {/* Setup incomplete — needs KYC */}
      {manager && setupIncomplete && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 dark:border-amber-800 dark:bg-amber-950/30">
          <div className="flex items-start gap-4">
            <ShieldCheck className="mt-0.5 h-6 w-6 shrink-0 text-amber-500" />
            <div className="flex-1">
              <h3 className="mb-1 font-semibold text-amber-900 dark:text-amber-100">Complete your account verification</h3>
              <p className="mb-4 text-sm text-amber-800 dark:text-amber-300">
                Stripe requires identity verification before you can accept payments and issue debit cards.
                This takes about 5 minutes.
              </p>
              <div className="flex gap-3">
                <a href="/money/setup"
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700">
                  Complete verification
                </a>
                <button
                  onClick={handleSync}
                  disabled={busy === 'sync'}
                  className="inline-flex items-center gap-2 rounded-lg border border-amber-300 px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:text-amber-200"
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', busy === 'sync' && 'animate-spin')} />
                  Refresh status
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Live dashboard */}
      {(isReady || wallets.length > 0) && (
        <>
          {/* Stats row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Total balance" value={formatCents(totalBalance)} icon={<Wallet className="h-4 w-4" />} />
            <StatCard label="Active cards" value={String(totalCards)} icon={<CreditCard className="h-4 w-4" />} />
            <StatCard label="Children" value={String(wallets.length)} icon={<TrendingUp className="h-4 w-4" />} />
            <StatCard label="Plan" value={tier === 'plus' ? 'Plus' : tier === 'basic' ? 'Basic' : 'Free'} icon={<Zap className="h-4 w-4" />} />
          </div>

          {/* Child wallet cards */}
          <div>
            <h2 className="mb-3 text-base font-semibold text-fg">Child wallets</h2>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {wallets.map((w) => (
                <WalletCard
                  key={w.id}
                  wallet={w}
                  manager={manager}
                  isReady={!!isReady}
                  onTopup={() => { setTopupFor(w); setTopupAmount(''); }}
                />
              ))}
            </div>
          </div>

          {/* Recent transactions */}
          {recentTransactions.length > 0 && (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-fg">Recent activity</h2>
                <a href="/money/activity" className="text-xs text-brand hover:underline">View all</a>
              </div>
              <div className="rounded-xl border border-border bg-surface/50 divide-y divide-border">
                {recentTransactions.slice(0, 8).map((txn) => {
                  const wallet = wallets.find((w) => w.id === txn.childWalletId);
                  return (
                    <div key={txn.id} className="flex items-center gap-3 px-4 py-3">
                      <div className={cn(
                        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                        txn.direction === 'credit' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-rose-500/10 text-rose-500',
                      )}>
                        {txn.direction === 'credit'
                          ? <ArrowDownLeft className="h-4 w-4" />
                          : <ArrowUpRight className="h-4 w-4" />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-fg">{txn.description || txn.type}</p>
                        <p className="text-xs text-muted">{wallet?.memberName ?? 'Child'}</p>
                      </div>
                      <span className={cn(
                        'text-sm font-semibold',
                        txn.direction === 'credit' ? 'text-emerald-500' : 'text-rose-500',
                      )}>
                        {txn.direction === 'credit' ? '+' : '-'}{formatCents(txn.amountCents)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Real-time authorizations */}
          {recentAuthorizations.length > 0 && (
            <div>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-base font-semibold text-fg">Card activity</h2>
                <CapabilityGate capability={capabilities.realtimeAuthorizations}>
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-500">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Real-time
                  </span>
                </CapabilityGate>
              </div>
              <div className="rounded-xl border border-border bg-surface/50 divide-y divide-border">
                {recentAuthorizations.slice(0, 6).map((auth) => (
                  <div key={auth.id} className="flex items-center gap-3 px-4 py-3">
                    <div className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white',
                      auth.decision === 'approved' ? 'bg-emerald-500' : 'bg-rose-500',
                    )}>
                      {auth.decision === 'approved'
                        ? <CheckCircle2 className="h-4 w-4" />
                        : <XCircle className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">{auth.merchantName ?? 'Unknown merchant'}</p>
                      <p className="text-xs text-muted capitalize">{auth.merchantCategory?.replace(/_/g, ' ') ?? auth.status}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-fg">{formatCents(auth.amountCents)}</p>
                      <p className={cn('text-xs font-medium', auth.decision === 'approved' ? 'text-emerald-500' : 'text-rose-500')}>
                        {auth.decision ?? auth.status}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Refresh capabilities (manager only, after setup) */}
      {manager && connectedAccount && (
        <div className="flex justify-end">
          <button
            onClick={handleRefreshCaps}
            disabled={busy === 'caps'}
            className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg"
          >
            <RefreshCw className={cn('h-3 w-3', busy === 'caps' && 'animate-spin')} />
            Refresh capabilities
          </button>
        </div>
      )}

      {/* Top-up modal */}
      {topupFor && (() => {
        const parsedAmt = parseFloat(topupAmount);
        const amtCents = (parsedAmt > 0 && Number.isFinite(parsedAmt)) ? Math.round(parsedAmt * 100) : 0;
        const fee = amtCents > 0 ? computeFunding(amtCents, tier) : null;
        return (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setTopupFor(null)}>
          <div className="w-full max-w-sm rounded-t-2xl border border-border bg-bg p-6 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-1 text-lg font-bold text-fg">Add funds</h3>
            <p className="mb-4 text-sm text-muted">Top up {topupFor.memberName}&apos;s wallet via secure Stripe Checkout.</p>

            <div className="mb-3 flex gap-2">
              {[5, 10, 20, 50].map((amt) => (
                <button
                  key={amt}
                  onClick={() => setTopupAmount(String(amt))}
                  className={cn(
                    'flex-1 rounded-lg border py-2 text-sm font-semibold transition',
                    topupAmount === String(amt)
                      ? 'border-brand bg-brand text-white'
                      : 'border-border text-fg hover:bg-elevated',
                  )}
                >
                  ${amt}
                </button>
              ))}
            </div>

            <div className="mb-4">
              <label className="mb-1.5 block text-xs font-medium text-muted">Custom amount</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
                <input
                  type="number"
                  min="1" max="500" step="0.01"
                  value={topupAmount}
                  onChange={(e) => setTopupAmount(e.target.value)}
                  className="w-full rounded-xl border border-border bg-surface px-8 py-2.5 text-sm outline-none focus:border-brand"
                  placeholder="0.00"
                />
              </div>
            </div>

            {fee && (
              <div className="mb-4 rounded-xl bg-elevated p-3 text-xs space-y-1">
                <div className="flex justify-between text-muted">
                  <span>{topupFor.memberName} receives</span>
                  <span className="font-medium text-fg">{formatCents(fee.amountCents)}</span>
                </div>
                <div className="flex justify-between text-muted">
                  <span>Processing fee</span>
                  <span>{formatCents(fee.processingCents)}</span>
                </div>
                {fee.serviceFeeCents > 0 && (
                  <div className="flex justify-between text-muted">
                    <span>Bubaly fee ({tier} plan)</span>
                    <span>{formatCents(fee.serviceFeeCents)}</span>
                  </div>
                )}
                <div className="flex justify-between border-t border-border pt-1 font-semibold text-fg">
                  <span>You pay</span>
                  <span>{formatCents(fee.totalChargedCents)}</span>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setTopupFor(null)}
                className="flex-1 rounded-xl border border-border py-2.5 text-sm font-medium text-muted hover:bg-elevated"
              >
                Cancel
              </button>
              <button
                onClick={handleTopup}
                disabled={busy === 'topup'}
                className="flex-1 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60"
              >
                {busy === 'topup' ? 'Redirecting…' : 'Add funds'}
              </button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface/50 p-4">
      <div className="mb-2 flex items-center gap-2 text-muted">{icon}<span className="text-xs">{label}</span></div>
      <p className="text-xl font-bold text-fg">{value}</p>
    </div>
  );
}

function WalletCard({ wallet, manager, isReady, onTopup }: {
  wallet: WalletView;
  manager: boolean;
  isReady: boolean;
  onTopup: () => void;
}) {
  const activeCards = wallet.cards.filter((c) => c.status === 'active');
  const initials = wallet.memberName.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);

  return (
    <div className="rounded-xl border border-border bg-surface/50 p-4">
      <div className="mb-4 flex items-center gap-3">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white text-sm font-bold"
          style={{ backgroundColor: wallet.memberColor ?? '#6366f1' }}
        >
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-fg">{wallet.memberName}</p>
          <p className="text-xs text-muted">{activeCards.length} active card{activeCards.length !== 1 ? 's' : ''}</p>
        </div>
      </div>

      <div className="mb-4">
        <p className="text-xs text-muted">Balance</p>
        <p className="text-2xl font-bold text-fg">{formatCents(wallet.balanceCents)}</p>
      </div>

      {activeCards.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {activeCards.slice(0, 2).map((card) => (
            <div key={card.cardId} className="flex items-center justify-between rounded-lg bg-elevated px-3 py-2 text-xs">
              <span className="flex items-center gap-1.5 text-muted capitalize">
                <CreditCard className="h-3 w-3" /> {card.type}
              </span>
              <span className="font-mono font-medium text-fg">••••{card.last4 ?? '????'}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        {manager && isReady && (
          <button
            onClick={onTopup}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand/90"
          >
            <Plus className="h-3 w-3" /> Add funds
          </button>
        )}
        <a
          href={`/money/cards`}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted hover:bg-elevated"
        >
          <CreditCard className="h-3 w-3" /> Cards
        </a>
      </div>
    </div>
  );
}

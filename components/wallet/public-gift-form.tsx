'use client';

// Public gift form (no auth) — a relative picks an amount, adds a note, and
// is redirected to Stripe Checkout (when Stripe is configured) or submits a
// pending pledge the family approves manually.
import { useState } from 'react';
import { Gift, Check, Info } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { computeFunding } from '@/lib/wallet/fees';
import type { WalletTier } from '@/lib/wallet/fees';
import { submitGiftPledgeAction } from '@/app/gift/actions';

export function PublicGiftForm({
  token,
  suggestedCents,
  childName,
  tier = 'free',
  stripeEnabled = false,
}: {
  token: string;
  suggestedCents: number[];
  childName: string;
  tier?: WalletTier;
  stripeEnabled?: boolean;
}) {
  const [amount, setAmount] = useState<number | null>(suggestedCents[0] ?? null);
  const [custom, setCustom] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFees, setShowFees] = useState(false);

  const effectiveCents = custom ? Math.round(Number(custom) * 100) : amount;
  const feeBreakdown = (stripeEnabled && effectiveCents && effectiveCents > 0)
    ? computeFunding(effectiveCents, tier)
    : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Please enter your name.');
    if (!effectiveCents || effectiveCents <= 0) return setError('Pick or enter an amount.');
    setLoading(true);
    const res = await submitGiftPledgeAction({ token, giverName: name, amountCents: effectiveCents, message });
    setLoading(false);
    if (!res.ok) return setError(res.error ?? 'Could not send your gift.');
    if (res.checkoutUrl) {
      window.location.href = res.checkoutUrl;
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="flex w-full flex-col items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-8 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15">
          <Check className="h-7 w-7 text-emerald-400" />
        </div>
        <p className="text-lg font-bold">Thank you! 🎉</p>
        <p className="text-sm text-muted">
          Your {effectiveCents ? formatCents(effectiveCents) : ''} gift to {childName} was sent.
          The family will add it to their wallet.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="w-full space-y-4 rounded-2xl border border-border bg-surface/40 p-5">
      <div>
        <label className="mb-1.5 block text-sm font-medium">
          How much would you like to give to {childName}?
        </label>
        <div className="grid grid-cols-3 gap-2">
          {suggestedCents.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => { setAmount(c); setCustom(''); }}
              className={cn(
                'rounded-xl border-2 py-3 text-sm font-bold transition',
                amount === c && !custom
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-border hover:border-brand/40',
              )}
            >
              {formatCents(c)}
            </button>
          ))}
        </div>
        <input
          type="number"
          min="1"
          max="1000"
          step="1"
          inputMode="decimal"
          value={custom}
          onChange={(e) => { setCustom(e.target.value); setAmount(null); }}
          placeholder="Or enter a custom amount ($)"
          className="mt-2 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm"
        />
      </div>

      {/* Fee breakdown — only shown when Stripe is configured */}
      {feeBreakdown && (
        <div className="rounded-xl bg-elevated p-3 text-xs">
          <button
            type="button"
            className="mb-1.5 flex w-full items-center justify-between text-xs text-muted"
            onClick={() => setShowFees((v) => !v)}
          >
            <span className="flex items-center gap-1">
              <Info className="h-3 w-3" />
              {childName} receives {formatCents(feeBreakdown.amountCents)}
            </span>
            <span className="font-semibold text-fg">You pay {formatCents(feeBreakdown.totalChargedCents)}</span>
          </button>
          {showFees && (
            <div className="space-y-1 border-t border-border pt-1.5">
              <div className="flex justify-between text-muted">
                <span>Gift amount</span>
                <span>{formatCents(feeBreakdown.amountCents)}</span>
              </div>
              <div className="flex justify-between text-muted">
                <span>Processing fee</span>
                <span>{formatCents(feeBreakdown.processingCents)}</span>
              </div>
              {feeBreakdown.serviceFeeCents > 0 && (
                <div className="flex justify-between text-muted">
                  <span>Platform fee</span>
                  <span>{formatCents(feeBreakdown.serviceFeeCents)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name (e.g. Grandma, Uncle John)"
        className="h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm"
      />
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Add a message (optional)"
        className="min-h-[70px] w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm"
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <button
        type="submit"
        disabled={loading}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-50 transition"
      >
        <Gift className="h-4 w-4" />
        {loading
          ? (stripeEnabled ? 'Opening checkout…' : 'Sending…')
          : stripeEnabled
          ? `Send ${feeBreakdown ? formatCents(feeBreakdown.totalChargedCents) : 'a gift'} to ${childName}`
          : `Send gift to ${childName}`}
      </button>
      <p className="text-center text-[11px] text-muted">
        {stripeEnabled
          ? 'You will be redirected to Stripe for secure payment.'
          : 'No charge is made now — the family confirms the gift.'}
      </p>
    </form>
  );
}

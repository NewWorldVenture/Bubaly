'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Send, ChevronRight, X } from 'lucide-react';
import Link from 'next/link';
import { Avatar } from '@/components/ui/avatar';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { sendMoneyAction } from '@/app/(app)/wallet/actions';

export type SendChild = {
  id: string;
  name: string;
  color: string | null;
  spendBalance: number;
  total: number;
};

type Step = 'from' | 'to' | 'amount' | 'confirm';

export function SendMoneyView({ wallets, canManage }: { wallets: SendChild[]; canManage: boolean }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [step, setStep] = useState<Step>('from');
  const [fromChild, setFromChild] = useState<SendChild | null>(null);
  const [toChild, setToChild] = useState<SendChild | null>(null);
  const [amountDisplay, setAmountDisplay] = useState('0');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  const amountCents = Math.round(parseFloat(amountDisplay) * 100) || 0;
  const isValidAmount = amountCents > 0 && fromChild != null && amountCents <= (fromChild.spendBalance > 0 ? fromChild.spendBalance : fromChild.total);

  // Numpad input
  const pressKey = useCallback((key: string) => {
    setAmountDisplay((prev) => {
      if (key === 'del') {
        const next = prev.slice(0, -1);
        return next === '' || next === '0.' ? '0' : next;
      }
      if (key === '.') {
        if (prev.includes('.')) return prev;
        return prev + '.';
      }
      // digit
      if (prev === '0') return key;
      // limit to 2 decimal places
      const dotIdx = prev.indexOf('.');
      if (dotIdx >= 0 && prev.length - dotIdx > 2) return prev;
      return prev + key;
    });
  }, []);

  async function send() {
    if (!fromChild || !toChild || amountCents <= 0) return;
    setSending(true);
    const res = await sendMoneyAction({
      fromChildWalletId: fromChild.id,
      toChildWalletId: toChild.id,
      amountCents,
      note: note.trim() || undefined,
    });
    setSending(false);
    if (!res.ok) return toastError(res.error ?? 'Transfer failed');
    success(`Sent ${formatCents(amountCents)} to ${toChild.name}`);
    router.push('/wallet');
  }

  return (
    <div className="mx-auto max-w-md">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-4">
        <Link href="/wallet" className="rounded-xl p-2 hover:bg-elevated transition">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-bold">Send Money</h1>
      </div>

      {/* Step: Pick sender */}
      {step === 'from' && (
        <div className="space-y-3 px-4">
          <p className="text-sm font-semibold text-muted">From which wallet?</p>
          {wallets.length < 2 ? (
            <div className="rounded-2xl border border-border bg-surface/40 p-6 text-center text-sm text-muted">
              Need at least 2 child wallets to send money between them.
            </div>
          ) : (
            <div className="space-y-2">
              {wallets.map((c) => (
                <button key={c.id} type="button"
                  onClick={() => { setFromChild(c); setStep('to'); }}
                  className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 text-left transition hover:border-brand/40 hover:bg-brand/5">
                  <Avatar name={c.name} color={c.color ?? undefined} size={44} className="rounded-full flex-shrink-0" />
                  <div className="flex-1">
                    <p className="font-semibold">{c.name}</p>
                    <p className="text-sm text-muted">{formatCents(c.spendBalance > 0 ? c.spendBalance : c.total)} available</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Step: Pick recipient */}
      {step === 'to' && fromChild && (
        <div className="space-y-3 px-4">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setStep('from')} className="text-sm text-brand-text hover:underline">← Back</button>
            <p className="text-sm font-semibold text-muted">Send to…</p>
          </div>
          <div className="mb-2 flex items-center gap-3 rounded-xl border border-brand/20 bg-brand/5 px-4 py-2.5">
            <Avatar name={fromChild.name} color={fromChild.color ?? undefined} size={32} className="rounded-full" />
            <div>
              <p className="text-xs text-muted">From</p>
              <p className="text-sm font-semibold">{fromChild.name} · {formatCents(fromChild.spendBalance > 0 ? fromChild.spendBalance : fromChild.total)}</p>
            </div>
          </div>
          <div className="space-y-2">
            {wallets.filter((c) => c.id !== fromChild.id).map((c) => (
              <button key={c.id} type="button"
                onClick={() => { setToChild(c); setStep('amount'); }}
                className="flex w-full items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 text-left transition hover:border-brand/40 hover:bg-brand/5">
                <Avatar name={c.name} color={c.color ?? undefined} size={44} className="rounded-full flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-semibold">{c.name}</p>
                  <p className="text-sm text-muted">{formatCents(c.total)} balance</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted" />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step: Amount */}
      {step === 'amount' && fromChild && toChild && (
        <div className="flex flex-col items-center px-4">
          <button type="button" onClick={() => setStep('to')} className="mb-4 self-start text-sm text-brand-text hover:underline">← Back</button>

          {/* Sender → recipient header */}
          <div className="mb-6 flex items-center gap-3">
            <div className="flex flex-col items-center gap-1">
              <Avatar name={fromChild.name} color={fromChild.color ?? undefined} size={40} className="rounded-full" />
              <p className="text-[11px] text-muted">{fromChild.name}</p>
            </div>
            <Send className="h-4 w-4 text-brand-text" />
            <div className="flex flex-col items-center gap-1">
              <Avatar name={toChild.name} color={toChild.color ?? undefined} size={40} className="rounded-full" />
              <p className="text-[11px] text-muted">{toChild.name}</p>
            </div>
          </div>

          {/* Amount display */}
          <div className="mb-2 text-center">
            <p className="text-5xl font-black tracking-tight">
              <span className="text-3xl text-muted">$</span>{amountDisplay}
            </p>
            {fromChild.spendBalance > 0 && (
              <p className="mt-1 text-xs text-muted">{formatCents(fromChild.spendBalance)} in Spend bucket</p>
            )}
          </div>

          {/* Quick amounts */}
          <div className="mb-4 flex gap-2">
            {[5, 10, 20, 50].map((d) => (
              <button key={d} type="button"
                onClick={() => setAmountDisplay(String(d))}
                className="rounded-full border border-border px-3 py-1 text-sm font-semibold hover:border-brand hover:text-brand-text transition">
                ${d}
              </button>
            ))}
          </div>

          {/* Numpad */}
          <div className="mb-4 grid w-full max-w-xs grid-cols-3 gap-2">
            {['1','2','3','4','5','6','7','8','9','.','0','del'].map((k) => (
              <button key={k} type="button" onClick={() => pressKey(k)}
                className={cn('rounded-2xl border border-border py-4 text-xl font-bold transition active:scale-95',
                  k === 'del' ? 'text-muted text-base hover:bg-elevated' : 'hover:bg-elevated hover:border-brand/30')}>
                {k === 'del' ? '⌫' : k}
              </button>
            ))}
          </div>

          {/* Note */}
          <div className="mb-4 w-full max-w-xs">
            <input
              type="text" placeholder="Add a note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={80}
              className="h-10 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring"
            />
          </div>

          <button type="button" onClick={() => setStep('confirm')}
            disabled={!isValidAmount}
            className="w-full max-w-xs rounded-2xl bg-brand py-3.5 text-base font-bold text-white transition hover:bg-brand/90 disabled:cursor-not-allowed disabled:opacity-50">
            Continue
          </button>
          {amountCents > 0 && !isValidAmount && (
            <p className="mt-2 text-center text-xs text-danger">Insufficient balance</p>
          )}
        </div>
      )}

      {/* Step: Confirm */}
      {step === 'confirm' && fromChild && toChild && (
        <div className="flex flex-col items-center px-4">
          <button type="button" onClick={() => setStep('amount')} className="mb-6 self-start text-sm text-brand-text hover:underline">← Back</button>

          <div className="mb-6 w-full rounded-2xl border border-border bg-surface/40 p-5">
            <p className="mb-4 text-center text-sm font-semibold text-muted">Review transfer</p>
            <div className="flex items-center justify-between gap-4">
              <div className="flex flex-col items-center gap-2">
                <Avatar name={fromChild.name} color={fromChild.color ?? undefined} size={52} className="rounded-full" />
                <p className="text-sm font-semibold">{fromChild.name}</p>
              </div>
              <div className="flex flex-col items-center">
                <p className="text-2xl font-black">{formatCents(amountCents)}</p>
                <Send className="mt-1 h-5 w-5 text-brand-text" />
              </div>
              <div className="flex flex-col items-center gap-2">
                <Avatar name={toChild.name} color={toChild.color ?? undefined} size={52} className="rounded-full" />
                <p className="text-sm font-semibold">{toChild.name}</p>
              </div>
            </div>
            {note && (
              <p className="mt-4 text-center text-sm text-muted">&ldquo;{note}&rdquo;</p>
            )}
            <p className="mt-4 text-center text-[11px] text-muted">
              Debits {fromChild.name}&apos;s Spend bucket · allocated across {toChild.name}&apos;s buckets
            </p>
          </div>

          <button type="button" onClick={send} disabled={sending}
            className="w-full rounded-2xl bg-brand py-3.5 text-base font-bold text-white transition hover:bg-brand/90 disabled:opacity-60">
            {sending ? 'Sending…' : `Send ${formatCents(amountCents)}`}
          </button>
          <button type="button" onClick={() => router.push('/wallet')}
            className="mt-3 w-full rounded-2xl border border-border py-3 text-sm font-semibold transition hover:bg-elevated">
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Users, DollarSign, Clock } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { payBabysitterAction } from '@/app/(app)/money/actions';

type Caregiver = { id: string; name: string; role: string; color: string | null };
type PayLog = {
  id: string;
  memberId: string;
  amountCents: number;
  hours: number | null;
  note: string | null;
  recipient: string;
  createdAt: string;
};

type Props = {
  manager: boolean;
  caregivers: Caregiver[];
  paymentLogs: PayLog[];
};

export function BabysitterView({ manager, caregivers, paymentLogs }: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const { success: toastSuccess, error: toastError } = useToast();
  const [showPay, setShowPay] = useState(false);
  const [payTo, setPayTo] = useState(caregivers[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function handlePay() {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!cents || cents < 100) { toastError('Minimum payment is $1.00'); return; }
    setBusy(true);
    const caregiver = caregivers.find((c) => c.id === payTo);
    const res = await payBabysitterAction({
      memberId: payTo,
      amountCents: cents,
      hours: hours ? parseFloat(hours) : undefined,
      note: note.trim() || undefined,
    });
    setBusy(false);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    toastSuccess(`Payment logged for ${caregiver?.name ?? 'caregiver'}`);
    setShowPay(false);
    setAmount('');
    setHours('');
    setNote('');
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-fg">Babysitters</h1>
          <p className="text-sm text-muted">Track and log caregiver payments</p>
        </div>
        {manager && caregivers.length > 0 && (
          <button
            onClick={() => setShowPay(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90"
          >
            <DollarSign className="h-4 w-4" /> Log payment
          </button>
        )}
      </div>

      {caregivers.length === 0 && (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Users className="mx-auto mb-3 h-8 w-8 text-muted" />
          <p className="font-medium text-fg">No caregivers yet</p>
          <p className="mt-1 text-sm text-muted">Add caregivers or adults to your family to track payments.</p>
        </div>
      )}

      {caregivers.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {caregivers.map((c) => {
            const payments = paymentLogs.filter((l) => l.memberId === c.id);
            const total = payments.reduce((s, p) => s + p.amountCents, 0);
            const initials = c.name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2);
            return (
              <div key={c.id} className="rounded-xl border border-border bg-surface/50 p-4">
                <div className="mb-3 flex items-center gap-3">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white text-sm font-bold"
                    style={{ backgroundColor: c.color ?? '#6366f1' }}
                  >
                    {initials}
                  </div>
                  <div>
                    <p className="font-semibold text-fg">{c.name}</p>
                    <p className="text-xs capitalize text-muted">{c.role}</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div className="rounded-lg bg-elevated px-3 py-2">
                    <p className="text-xs text-muted">Total paid</p>
                    <p className="font-bold text-fg">{formatCents(total)}</p>
                  </div>
                  <div className="rounded-lg bg-elevated px-3 py-2">
                    <p className="text-xs text-muted">Payments</p>
                    <p className="font-bold text-fg">{payments.length}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Payment history */}
      {paymentLogs.length > 0 && (
        <section>
          <h2 className="mb-3 text-base font-semibold text-fg">Payment history</h2>
          <div className="rounded-xl border border-border bg-surface/50 divide-y divide-border">
            {paymentLogs.map((log) => (
              <div key={log.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500">
                  <DollarSign className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">{log.recipient}</p>
                  <p className="text-xs text-muted">
                    {log.hours ? `${log.hours}h · ` : ''}
                    {log.note ? `"${log.note}" · ` : ''}
                    {new Date(log.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <span className="text-sm font-semibold text-emerald-500">{formatCents(log.amountCents)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Pay modal */}
      {showPay && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setShowPay(false)}>
          <div className="w-full max-w-sm rounded-t-2xl border border-border bg-bg p-6 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-4 text-lg font-bold text-fg">Log babysitter payment</h3>
            <div className="space-y-3">
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Caregiver</label>
                <select value={payTo} onChange={(e) => setPayTo(e.target.value)}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand">
                  {caregivers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted">$</span>
                  <input type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)}
                    className="w-full rounded-xl border border-border bg-surface px-8 py-2.5 text-sm outline-none focus:border-brand"
                    placeholder="0.00" />
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Hours (optional)</label>
                <div className="relative">
                  <Clock className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted" />
                  <input type="number" min="0.5" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)}
                    className="w-full rounded-xl border border-border bg-surface px-8 py-2.5 text-sm outline-none focus:border-brand"
                    placeholder="e.g. 3.5" />
                </div>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-medium text-muted">Note (optional)</label>
                <input type="text" value={note} onChange={(e) => setNote(e.target.value)}
                  className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand"
                  placeholder="Friday night, school play" />
              </div>
            </div>
            <div className="mt-4 flex gap-3">
              <button onClick={() => setShowPay(false)} className="flex-1 rounded-xl border border-border py-2.5 text-sm font-medium text-muted hover:bg-elevated">
                Cancel
              </button>
              <button onClick={handlePay} disabled={busy}
                className="flex-1 rounded-xl bg-brand py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60">
                {busy ? 'Saving…' : 'Log payment'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

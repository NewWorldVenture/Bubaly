'use client';

// Babysitter management — profiles (name, rate, contact) + payment tracking with
// receipts. In ledger-MVP mode payments are recorded for bookkeeping (no payout
// rail yet); Stripe payouts plug in later behind feature flags.
import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Baby, Plus, Pencil, Trash2, DollarSign, Clock, X, Phone, Mail } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input, Textarea } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import {
  saveBabysitterAction, archiveBabysitterAction, recordBabysitterPaymentAction,
} from '@/app/(app)/wallet/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type BabysitterRow = {
  id: string; name: string; phone: string | null; email: string | null;
  rateCents: number | null; notes: string | null;
};
export type PaymentRow = {
  id: string; babysitterId: string | null; hours: number | null; rateCents: number | null;
  tipCents: number; amountCents: number; status: string; createdAt: string;
};

export function BabysittersView({ sitters, payments, canManage }: {
  sitters: BabysitterRow[]; payments: PaymentRow[]; canManage: boolean;
}) {
  const t = useTranslations();
  const tr = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [editing, setEditing] = useState<BabysitterRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<BabysitterRow | null>(null);

  const nameById = useMemo(() => new Map(sitters.map((s) => [s.id, s.name])), [sitters]);
  const totalPaid = useMemo(() => payments.filter((p) => p.status === 'completed').reduce((sum, p) => sum + p.amountCents, 0), [payments]);

  async function archive(s: BabysitterRow) {
    const res = await archiveBabysitterAction({ id: s.id });
    if (!res.ok) return toastError(res.error ?? 'Could not remove');
    success('Babysitter removed');
    router.refresh();
  }

  return (
    <div className="module-page">
      <PageHeader
        title={tr('babysitters.familyWallet')}
        description="Keep babysitter contacts and track every payment in one place."
        action={canManage ? <Button onClick={() => setAdding(true)}><Plus className="h-4 w-4" /> {tr('babysitters.addSitter')}</Button> : undefined}
      />
      <WalletSubnav />

      {/* Stats */}
      <div className="mb-5 grid grid-cols-3 gap-3">
        {[
          { label: 'Sitters', value: String(sitters.length), icon: '👶' },
          { label: 'Payments', value: String(payments.length), icon: '🧾' },
          { label: 'Total Paid', value: formatCents(totalPaid), icon: '💵' },
        ].map((s) => (
          <div key={s.label} className="rounded-2xl border border-border bg-surface/40 p-4">
            <div className="text-xl">{s.icon}</div>
            <div className="mt-1 text-lg font-bold">{s.value}</div>
            <div className="text-[11px] text-muted">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Sitter list */}
      {sitters.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border border-border bg-surface/40 py-12 text-center">
          <div className="mb-3 grid h-14 w-14 place-items-center rounded-full bg-brand/10">
            <Baby className="h-6 w-6 text-brand-text opacity-60" />
          </div>
          <p className="text-sm font-semibold">{tr('babysitters.noBabysittersYet')}</p>
          <p className="mt-1 text-xs text-muted">{tr('babysitters.addASitterToTrackPayments')}</p>
          {canManage && (
            <button onClick={() => setAdding(true)} className="mt-4 flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-xs font-semibold text-white hover:bg-brand/90 transition">
              <Plus className="h-3.5 w-3.5" /> {tr('babysitters.addSitter')}
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {sitters.map((s) => {
            const sitterPayments = payments.filter((p) => p.babysitterId === s.id && p.status === 'completed');
            const paid = sitterPayments.reduce((sum, p) => sum + p.amountCents, 0);
            return (
              <div key={s.id} className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4">
                <Avatar name={s.name} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{s.name}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
                    {s.rateCents != null && <span>{formatCents(s.rateCents)}/hr</span>}
                    {s.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{s.phone}</span>}
                    {s.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{s.email}</span>}
                    {paid > 0 && <span className="text-green-400">{formatCents(paid)} paid</span>}
                  </div>
                </div>
                {canManage && (
                  <div className="flex flex-shrink-0 items-center gap-1">
                    <button onClick={() => setPaying(s)} className="rounded-lg bg-green-500/15 px-2.5 py-1.5 text-xs font-semibold text-green-400 hover:bg-green-500/25 transition" title={t('babysittersView.recordPayment')}>
                      <DollarSign className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => setEditing(s)} className="rounded-lg p-1.5 text-muted hover:text-fg hover:bg-elevated transition" title={t('babysittersView.edit')}>
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => archive(s)} className="rounded-lg p-1.5 text-muted hover:text-red-400 hover:bg-elevated transition" title={t('babysittersView.remove')}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Recent payments */}
      {payments.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-semibold">{tr('babysitters.recentPayments')}</h2>
          <div className="overflow-hidden rounded-2xl border border-border bg-surface/40 divide-y divide-border/50">
            {payments.slice(0, 15).map((p) => (
              <div key={p.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg bg-green-500/10">
                  <DollarSign className="h-4 w-4 text-green-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{p.babysitterId ? nameById.get(p.babysitterId) ?? 'Babysitter' : 'Babysitter'}</div>
                  <div className="flex items-center gap-2 text-[11px] text-muted">
                    {p.hours != null && <span className="flex items-center gap-0.5"><Clock className="h-2.5 w-2.5" />{p.hours}h</span>}
                    {p.tipCents > 0 && <span>+{formatCents(p.tipCents)} tip</span>}
                    <span>{new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  </div>
                </div>
                <div className="text-sm font-bold">{formatCents(p.amountCents)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modals */}
      {(adding || editing) && (
        <SitterModal sitter={editing} onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); router.refresh(); }} />
      )}
      {paying && (
        <PaymentModal sitter={paying} onClose={() => setPaying(null)}
          onSaved={() => { setPaying(null); router.refresh(); }} />
      )}
    </div>
  );
}

function SitterModal({ sitter, onClose, onSaved }: {
  sitter: BabysitterRow | null; onClose: () => void; onSaved: () => void;
}) {
  const t = useTranslations();
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const phone = String(form.get('phone') ?? '').trim();
    const email = String(form.get('email') ?? '').trim();
    const rateStr = String(form.get('rate') ?? '').trim();
    const notes = String(form.get('notes') ?? '').trim();
    if (!name) return toastError('Enter a name');
    const rateCents = rateStr ? Math.round(parseFloat(rateStr) * 100) : undefined;

    setLoading(true);
    const res = await saveBabysitterAction({ id: sitter?.id, name, phone, email, rateCents, notes });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not save');
    onSaved();
  }

  return (
    <Modal open title={sitter ? 'Edit Babysitter' : 'Add Babysitter'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('babysitters.name')} required>{(id) => <Input id={id} name="name" autoFocus defaultValue={sitter?.name ?? ''} placeholder={t('babysittersView.jamieRivera')} />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('babysitters.phone')}>{(id) => <Input id={id} name="phone" defaultValue={sitter?.phone ?? ''} placeholder="+1 555 …" />}</Field>
          <Field label={tr('babysitters.hourlyRate')}>{(id) => <Input id={id} name="rate" type="number" min="0" step="0.5" defaultValue={sitter?.rateCents != null ? (sitter.rateCents / 100).toString() : ''} placeholder="20" />}</Field>
        </div>
        <Field label={tr('babysitters.email')}>{(id) => <Input id={id} name="email" type="email" defaultValue={sitter?.email ?? ''} placeholder="jamie@example.com" />}</Field>
        <Field label={tr('babysitters.notes')}>{(id) => <Textarea id={id} name="notes" rows={2} defaultValue={sitter?.notes ?? ''} placeholder={t('babysittersView.greatWithToddlersAvailableWeekends')} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('babysitters.cancel')}</Button>
          <Button type="submit" loading={loading}>{loading ? 'Saving…' : sitter ? 'Save Changes' : 'Add Sitter'}</Button>
        </div>
      </form>
    </Modal>
  );
}

function PaymentModal({ sitter, onClose, onSaved }: {
  sitter: BabysitterRow; onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [hours, setHours] = useState('');
  const [tip, setTip] = useState('');
  const rate = sitter.rateCents ?? 0;

  const computed = useMemo(() => {
    const h = parseFloat(hours) || 0;
    const t = Math.round((parseFloat(tip) || 0) * 100);
    return Math.round(h * rate) + t;
  }, [hours, tip, rate]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const overrideStr = String(form.get('amount') ?? '').trim();
    const amountCents = overrideStr ? Math.round(parseFloat(overrideStr) * 100) : computed;
    if (!amountCents || amountCents <= 0) return toastError('Enter hours or a payment amount');
    const h = parseFloat(hours) || undefined;
    const tipCents = Math.round((parseFloat(tip) || 0) * 100);

    setLoading(true);
    const res = await recordBabysitterPaymentAction({
      babysitterId: sitter.id, hours: h, rateCents: sitter.rateCents ?? undefined, tipCents, amountCents,
    });
    setLoading(false);
    if (!res.ok) return toastError(res.error ?? 'Could not record payment');
    onSaved();
  }

  return (
    <Modal open title={`Pay ${sitter.name}`} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('babysitters.hours')}>{(id) => <Input id={id} name="hours" type="number" min="0" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} placeholder="3" />}</Field>
          <Field label={tr('babysitters.tip')}>{(id) => <Input id={id} name="tip" type="number" min="0" step="0.5" value={tip} onChange={(e) => setTip(e.target.value)} placeholder="5" />}</Field>
        </div>
        {rate > 0 && (
          <div className="flex items-center justify-between rounded-xl border border-border bg-surface/40 px-4 py-2.5 text-sm">
            <span className="text-muted">{tr('babysitters.computed')}{formatCents(rate)}/hr)</span>
            <span className="font-bold">{formatCents(computed)}</span>
          </div>
        )}
        <Field label={tr('babysitters.orEnterExactAmount')}>{(id) => <Input id={id} name="amount" type="number" min="0" step="0.5" placeholder={rate > 0 ? (computed / 100).toFixed(2) : '60'} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('babysitters.cancel')}</Button>
          <Button type="submit" loading={loading}>{loading ? 'Recording…' : 'Record Payment'}</Button>
        </div>
      </form>
    </Modal>
  );
}

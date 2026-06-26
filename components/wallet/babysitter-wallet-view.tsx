'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Users, Plus, DollarSign, Clock, Phone, Mail, Pencil, X, ChevronDown, ChevronUp } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Modal } from '@/components/ui/modal';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { WalletSubnav } from '@/components/wallet/wallet-subnav';
import {
  upsertBabysitterAction,
  deactivateBabysitterAction,
  logBabysitterPaymentAction,
} from '@/app/(app)/wallet/actions';

export type BabysitterProfile = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  rateCents: number | null;
  notes: string | null;
};

export type BabysitterPayment = {
  id: string;
  babysitterId: string | null;
  hours: number | null;
  rateCents: number | null;
  tipCents: number;
  amountCents: number;
  createdAt: string;
};

type Props = {
  canManage: boolean;
  babysitters: BabysitterProfile[];
  payments: BabysitterPayment[];
};

const EMPTY_FORM = { name: '', phone: '', email: '', rate: '', notes: '' };

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-fg">{label}</label>
      {children}
    </div>
  );
}

export function BabysitterWalletView({ canManage, babysitters, payments }: Props) {
  const router = useRouter();
  const { success, error: toastError } = useToast();

  const [profileModal, setProfileModal] = useState<BabysitterProfile | 'new' | null>(null);
  const [payModal, setPayModal] = useState<BabysitterProfile | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState(EMPTY_FORM);
  const [payForm, setPayForm] = useState({ hours: '', rate: '', tip: '', amount: '' });

  function openNew() {
    setForm(EMPTY_FORM);
    setProfileModal('new');
  }

  function openEdit(b: BabysitterProfile) {
    setForm({
      name: b.name,
      phone: b.phone ?? '',
      email: b.email ?? '',
      rate: b.rateCents ? String(b.rateCents / 100) : '',
      notes: b.notes ?? '',
    });
    setProfileModal(b);
  }

  function openPay(b: BabysitterProfile) {
    setPayForm({ hours: '', rate: b.rateCents ? String(b.rateCents / 100) : '', tip: '', amount: '' });
    setPayModal(b);
  }

  function calcAmount() {
    const hours = parseFloat(payForm.hours);
    const rate = parseFloat(payForm.rate);
    const tip = parseFloat(payForm.tip) || 0;
    if (hours > 0 && rate > 0) {
      const computed = Math.round(hours * rate * 100 + tip * 100);
      setPayForm(f => ({ ...f, amount: (computed / 100).toFixed(2) }));
    }
  }

  async function saveProfile() {
    const isEdit = profileModal !== 'new';
    setSaving(true);
    const res = await upsertBabysitterAction({
      id: isEdit ? (profileModal as BabysitterProfile).id : undefined,
      name: form.name,
      phone: form.phone || null,
      email: form.email || null,
      rateCents: form.rate ? Math.round(parseFloat(form.rate) * 100) : null,
      notes: form.notes || null,
    });
    setSaving(false);
    if (!res.ok) { toastError(res.error ?? 'Save failed'); return; }
    success(isEdit ? 'Babysitter updated' : 'Babysitter added');
    setProfileModal(null);
    router.refresh();
  }

  async function deactivate(id: string, name: string) {
    if (!confirm(`Remove ${name}? Their payment history is kept.`)) return;
    const res = await deactivateBabysitterAction({ id });
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    success('Babysitter removed');
    router.refresh();
  }

  async function logPayment() {
    if (!payModal) return;
    const cents = Math.round(parseFloat(payForm.amount) * 100);
    if (!cents || cents < 100) { toastError('Minimum payment is $1.00'); return; }
    setSaving(true);
    const res = await logBabysitterPaymentAction({
      babysitterId: payModal.id,
      hours: payForm.hours ? parseFloat(payForm.hours) : null,
      rateCents: payForm.rate ? Math.round(parseFloat(payForm.rate) * 100) : null,
      tipCents: payForm.tip ? Math.round(parseFloat(payForm.tip) * 100) : 0,
      amountCents: cents,
    });
    setSaving(false);
    if (!res.ok) { toastError(res.error ?? 'Failed'); return; }
    success(`Payment logged for ${payModal.name}`);
    setPayModal(null);
    router.refresh();
  }

  const paymentsByBabysitter = new Map<string, BabysitterPayment[]>();
  for (const p of payments) {
    if (!p.babysitterId) continue;
    const arr = paymentsByBabysitter.get(p.babysitterId) ?? [];
    arr.push(p);
    paymentsByBabysitter.set(p.babysitterId, arr);
  }

  return (
    <div className="module-page">
      <PageHeader title="Babysitters" description="Manage caregivers and log payments." />
      <WalletSubnav />

      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted">{babysitters.length} caregiver{babysitters.length !== 1 ? 's' : ''}</p>
        {canManage && (
          <button onClick={openNew} className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand/90">
            <Plus className="h-4 w-4" /> Add babysitter
          </button>
        )}
      </div>

      {babysitters.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border p-10 text-center">
          <Users className="mx-auto mb-3 h-8 w-8 text-muted" />
          <p className="font-semibold text-fg">No babysitters yet</p>
          <p className="mt-1 text-sm text-muted">Add your first caregiver to start tracking payments.</p>
          {canManage && (
            <button onClick={openNew} className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90">
              <Plus className="h-4 w-4" /> Add babysitter
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {babysitters.map((b) => {
            const bPayments = paymentsByBabysitter.get(b.id) ?? [];
            const totalPaid = bPayments.reduce((s, p) => s + p.amountCents, 0);
            const isExpanded = expanded === b.id;
            return (
              <div key={b.id} className="rounded-2xl border border-border bg-surface/40 overflow-hidden">
                <div className="flex items-center gap-3 p-4">
                  <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-brand/10 text-brand font-semibold text-sm">
                    {b.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-fg">{b.name}</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted mt-0.5">
                      {b.rateCents && <span>{formatCents(b.rateCents)}/hr</span>}
                      {b.phone && <span className="flex items-center gap-1"><Phone className="h-3 w-3" />{b.phone}</span>}
                      {b.email && <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{b.email}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {bPayments.length > 0 && (
                      <button
                        onClick={() => setExpanded(isExpanded ? null : b.id)}
                        className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-muted hover:bg-elevated hover:text-fg"
                      >
                        {formatCents(totalPaid)} total
                        {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                      </button>
                    )}
                    {canManage && (
                      <>
                        <button onClick={() => openPay(b)} className="rounded-lg bg-emerald-500/10 px-2.5 py-1.5 text-xs font-semibold text-emerald-400 hover:bg-emerald-500/20">
                          Pay
                        </button>
                        <button onClick={() => openEdit(b)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => deactivate(b.id, b.name)} className="rounded-lg p-1.5 text-muted hover:bg-red-500/10 hover:text-red-400">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {isExpanded && bPayments.length > 0 && (
                  <div className="border-t border-border divide-y divide-border">
                    {bPayments.map((p) => (
                      <div key={p.id} className="flex items-center justify-between px-4 py-2.5 text-sm">
                        <div>
                          <span className="font-medium text-fg">{formatCents(p.amountCents)}</span>
                          {p.hours && <span className="ml-2 text-xs text-muted">{p.hours}h</span>}
                          {p.tipCents > 0 && <span className="ml-2 text-xs text-muted">+{formatCents(p.tipCents)} tip</span>}
                        </div>
                        <span className="text-xs text-muted">{new Date(p.createdAt).toLocaleDateString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit profile modal */}
      <Modal open={profileModal !== null} onClose={() => setProfileModal(null)} title={profileModal === 'new' ? 'Add babysitter' : 'Edit babysitter'}>
        <div className="space-y-3 p-4">
          <LabeledField label="Name *">
            <Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Jane Smith" />
          </LabeledField>
          <div className="grid grid-cols-2 gap-3">
            <LabeledField label="Phone">
              <Input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} placeholder="(555) 123-4567" />
            </LabeledField>
            <LabeledField label="Hourly rate ($)">
              <Input type="number" min="0" step="0.25" value={form.rate} onChange={e => setForm(f => ({ ...f, rate: e.target.value }))} placeholder="18.00" />
            </LabeledField>
          </div>
          <LabeledField label="Email">
            <Input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="jane@example.com" />
          </LabeledField>
          <LabeledField label="Notes">
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              placeholder="Preferred contact, special instructions…"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm min-h-[60px]"
            />
          </LabeledField>
          <div className="flex gap-2 pt-1">
            <button onClick={() => setProfileModal(null)} className="flex-1 rounded-xl border border-border py-2 text-sm font-medium text-muted hover:text-fg">Cancel</button>
            <button onClick={saveProfile} disabled={saving || !form.name.trim()} className={cn('flex-1 rounded-xl py-2 text-sm font-semibold text-white transition', saving || !form.name.trim() ? 'bg-brand/40' : 'bg-brand hover:bg-brand/90')}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Log payment modal */}
      <Modal open={payModal !== null} onClose={() => setPayModal(null)} title={`Pay ${payModal?.name ?? ''}`}>
        <div className="space-y-3 p-4">
          <div className="grid grid-cols-2 gap-3">
            <LabeledField label="Hours worked">
              <Input
                type="number" min="0" step="0.25"
                value={payForm.hours}
                onChange={e => setPayForm(f => ({ ...f, hours: e.target.value }))}
                onBlur={calcAmount}
                placeholder="3.5"
              />
            </LabeledField>
            <LabeledField label="Rate ($/hr)">
              <Input
                type="number" min="0" step="0.25"
                value={payForm.rate}
                onChange={e => setPayForm(f => ({ ...f, rate: e.target.value }))}
                onBlur={calcAmount}
                placeholder="18.00"
              />
            </LabeledField>
          </div>
          <LabeledField label="Tip ($)">
            <Input type="number" min="0" step="1" value={payForm.tip} onChange={e => setPayForm(f => ({ ...f, tip: e.target.value }))} placeholder="0" />
          </LabeledField>
          <LabeledField label="Total amount ($) *">
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted pointer-events-none" />
              <Input
                type="number" min="0" step="0.01"
                value={payForm.amount}
                onChange={e => setPayForm(f => ({ ...f, amount: e.target.value }))}
                placeholder="0.00"
                className="pl-8"
              />
            </div>
          </LabeledField>
          <p className="text-xs text-muted flex items-center gap-1">
            <Clock className="h-3 w-3" /> Payment is tracked for records only — no money moves from the wallet.
          </p>
          <div className="flex gap-2 pt-1">
            <button onClick={() => setPayModal(null)} className="flex-1 rounded-xl border border-border py-2 text-sm font-medium text-muted hover:text-fg">Cancel</button>
            <button onClick={logPayment} disabled={saving || !payForm.amount} className={cn('flex-1 rounded-xl py-2 text-sm font-semibold text-white transition', saving || !payForm.amount ? 'bg-brand/40' : 'bg-brand hover:bg-brand/90')}>
              {saving ? 'Logging…' : 'Log payment'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

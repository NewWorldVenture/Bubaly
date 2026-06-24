'use client';

import { useMemo, useState } from 'react';
import {
  ShieldCheck, Plus, Pencil, Trash2, AlertTriangle, Clock, ExternalLink,
  DollarSign, RotateCw,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { isManager } from '@/lib/constants/roles';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { LoadingBlock, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { cn } from '@/lib/utils/cn';
import {
  groupByExpiry, renewalStats, daysToExpiry, isExpired, rollForward,
  RENEWAL_STATUS_LABELS, EXPIRY_BUCKET_LABELS,
  type RenewalLike, type ExpiryBucket,
} from '@/lib/renewals/expiry';
import type { Tables, RenewalStatus } from '@/lib/database.types';

type Renewal = Tables<'renewals'>;

const CATEGORIES = ['id', 'passport', 'license', 'registration', 'warranty', 'insurance', 'subscription', 'other'];
const CATEGORY_LABELS: Record<string, string> = {
  id: 'ID', passport: 'Passport', license: 'License', registration: 'Registration',
  warranty: 'Warranty', insurance: 'Insurance', subscription: 'Subscription', other: 'Other',
};
const BUCKET_ORDER: ExpiryBucket[] = ['expired', 'soon', 'upcoming', 'done'];
const BUCKET_ACCENT: Record<ExpiryBucket, string> = {
  expired: 'text-rose-400', soon: 'text-amber-400', upcoming: 'text-sky-400', done: 'text-emerald-400',
};

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const blank = {
  id: '', member_id: '', title: '', category: 'id', expires_at: '', reminder_days: 30,
  cost: '', url: '', status: 'active' as RenewalStatus, notes: '',
};

export function RenewalsModule() {
  const { familyId, userId, members, role } = useApp();
  const { success, error: toastError } = useToast();
  const canEdit = isManager(role);

  const [showDone, setShowDone] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const { data: renewals, loading, error } = useRealtimeQuery<Renewal>({
    table: 'renewals', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('renewals').select('*').eq('family_id', familyId).order('expires_at'),
  });

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;
  const tk = todayKey();

  const stats = useMemo(() => renewalStats((renewals ?? []) as RenewalLike[], tk), [renewals, tk]);
  const grouped = useMemo(() => groupByExpiry((renewals ?? []) as RenewalLike[], tk), [renewals, tk]);
  const byId = useMemo(() => new Map((renewals ?? []).map((r) => [r.id, r])), [renewals]);

  function openNew() { setForm({ ...blank }); setModalOpen(true); }
  function openEdit(r: Renewal) {
    setForm({
      id: r.id, member_id: r.member_id ?? '', title: r.title, category: r.category ?? 'other',
      expires_at: r.expires_at, reminder_days: r.reminder_days, cost: r.cost != null ? String(r.cost) : '',
      url: r.url ?? '', status: r.status, notes: r.notes ?? '',
    });
    setModalOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { toastError('Title is required'); return; }
    if (!form.expires_at) { toastError('Expiry date is required'); return; }
    setSaving(true);
    const sb = createClient();
    const fields = {
      member_id: form.member_id || null,
      title: form.title.trim(),
      category: form.category || null,
      expires_at: form.expires_at,
      reminder_days: Math.max(0, Math.round(form.reminder_days)),
      cost: form.cost ? Number(form.cost) : null,
      url: form.url.trim() || null,
      status: form.status,
      notes: form.notes.trim() || null,
    };
    const { error: err } = form.id
      ? await sb.from('renewals').update(fields).eq('id', form.id)
      : await sb.from('renewals').insert({ ...fields, family_id: familyId, created_by: userId });
    setSaving(false);
    if (err) { toastError(err.message); return; }
    success(form.id ? 'Renewal updated' : 'Renewal added');
    setModalOpen(false);
  }

  // Mark renewed → roll the expiry forward a year and keep it active.
  async function markRenewed(r: Renewal) {
    const sb = createClient();
    const { error: err } = await sb.from('renewals').update({
      expires_at: rollForward(r.expires_at, 12), status: 'active',
    }).eq('id', r.id);
    if (err) { toastError(err.message); return; }
    success('Renewed for another year');
  }

  async function remove(r: Renewal) {
    if (!confirm(`Delete "${r.title}"?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('renewals').delete().eq('id', r.id);
    if (err) { toastError(err.message); return; }
    success('Renewal deleted');
  }

  const fmtDate = (key: string) => new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const countdown = (r: Renewal) => {
    const d = daysToExpiry(r as RenewalLike, tk);
    if (d < 0) return `${Math.abs(d)}d ago`;
    if (d === 0) return 'today';
    return `in ${d}d`;
  };

  if (loading) return <LoadingBlock label="Loading renewals…" />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load renewals'} />;

  const buckets = showDone ? BUCKET_ORDER : BUCKET_ORDER.filter((b) => b !== 'done');

  return (
    <div>
      <PageHeader
        title="Renewals & Expirations"
        description="Track IDs, licenses, registrations, warranties, and subscriptions before they lapse."
        action={<div className="flex items-center gap-2"><AiInsight kind="renewals" iconOnly />{canEdit && <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add renewal</Button>}</div>}
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="rounded-2xl bg-surface/50 border border-border p-4 text-center">
          <div className="text-2xl font-bold text-fg">{stats.active}</div>
          <div className="text-xs text-muted mt-0.5">Tracked</div>
        </div>
        <div className={cn('rounded-2xl border p-4 text-center', stats.expiringSoon > 0 ? 'bg-amber-500/5 border-amber-500/30' : 'bg-surface/50 border-border')}>
          <div className={cn('text-2xl font-bold', stats.expiringSoon > 0 ? 'text-amber-400' : 'text-fg')}>{stats.expiringSoon}</div>
          <div className="text-xs text-muted mt-0.5">Expiring soon</div>
        </div>
        <div className={cn('rounded-2xl border p-4 text-center', stats.expired > 0 ? 'bg-rose-500/5 border-rose-500/30' : 'bg-surface/50 border-border')}>
          <div className={cn('text-2xl font-bold', stats.expired > 0 ? 'text-rose-400' : 'text-fg')}>{stats.expired}</div>
          <div className="text-xs text-muted mt-0.5">Expired</div>
        </div>
      </div>

      <div className="flex items-center justify-end mb-4">
        <label className="flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="h-4 w-4 rounded border-border" />
          Show renewed / closed
        </label>
      </div>

      {(renewals ?? []).length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Nothing tracked yet"
          description={canEdit ? 'Add the documents, licenses, and warranties you want to be reminded about before they expire.' : 'No renewals have been added yet.'}
          action={canEdit && <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add renewal</Button>} />
      ) : (
        <div className="space-y-6">
          {buckets.map((bucket) => {
            const list = grouped[bucket];
            if (list.length === 0) return null;
            return (
              <div key={bucket}>
                <h2 className={cn('text-sm font-semibold uppercase tracking-wider mb-2.5 flex items-center gap-2', BUCKET_ACCENT[bucket])}>
                  {bucket === 'expired' && <AlertTriangle className="h-4 w-4" />}
                  {bucket === 'soon' && <Clock className="h-4 w-4" />}
                  {EXPIRY_BUCKET_LABELS[bucket]} <span className="text-muted font-normal">({list.length})</span>
                </h2>
                <div className="space-y-2">
                  {list.map((row) => {
                    const r = byId.get(row.id)!;
                    const expired = isExpired(row, tk);
                    return (
                      <div key={r.id} className={cn('rounded-xl border p-4', expired ? 'border-rose-500/30 bg-rose-500/[0.03]' : 'border-border bg-surface/50')}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-fg">{r.title}</span>
                              {r.category && <span className="text-[10px] uppercase tracking-wide rounded bg-brand/10 text-brand px-1.5 py-0.5">{CATEGORY_LABELS[r.category] ?? r.category}</span>}
                              {r.status !== 'active' && <span className="text-[10px] uppercase tracking-wide rounded border border-border text-muted px-1.5 py-0.5">{RENEWAL_STATUS_LABELS[r.status]}</span>}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                              <span className={cn('inline-flex items-center gap-1', expired && 'text-rose-400')}><Clock className="h-3.5 w-3.5" />Expires {fmtDate(r.expires_at)} · {countdown(r)}</span>
                              {r.member_id && <span className="inline-flex items-center gap-1"><Avatar name={memberName(r.member_id) ?? '?'} size={14} />{memberName(r.member_id)}</span>}
                              {r.cost != null && <span className="inline-flex items-center gap-0.5"><DollarSign className="h-3.5 w-3.5" />{r.cost}</span>}
                              {r.url && <a href={r.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline"><ExternalLink className="h-3.5 w-3.5" />Renew</a>}
                            </div>
                            {r.notes && <p className="mt-1.5 text-sm text-fg/80">{r.notes}</p>}
                          </div>
                          {canEdit && (
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {r.status === 'active' && (
                                <button onClick={() => markRenewed(r)} aria-label="Mark renewed" title="Renew for another year" className="p-1.5 rounded-lg text-muted hover:text-emerald-400 hover:bg-elevated"><RotateCw className="h-4 w-4" /></button>
                              )}
                              <button onClick={() => openEdit(r)} aria-label="Edit" className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-elevated"><Pencil className="h-4 w-4" /></button>
                              <button onClick={() => remove(r)} aria-label="Delete" className="p-1.5 rounded-lg text-muted hover:text-rose-400 hover:bg-elevated"><Trash2 className="h-4 w-4" /></button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={form.id ? 'Edit renewal' : 'Add renewal'}>
        <form onSubmit={save} className="space-y-4">
          <Field label="What expires?" required>
            {(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Passport — Mom" autoFocus />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              {(id) => (
                <Select id={id} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                </Select>
              )}
            </Field>
            <Field label="For">
              {(id) => (
                <Select id={id} value={form.member_id} onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}>
                  <option value="">Whole family</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Expires on" required>
              {(id) => <Input id={id} type="date" value={form.expires_at} onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))} />}
            </Field>
            <Field label="Remind me (days before)">
              {(id) => <Input id={id} type="number" min={0} value={form.reminder_days} onChange={(e) => setForm((f) => ({ ...f, reminder_days: Number(e.target.value) }))} />}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Renewal cost ($)">
              {(id) => <Input id={id} type="number" min={0} step="0.01" value={form.cost} onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))} placeholder="0.00" />}
            </Field>
            <Field label="Status">
              {(id) => (
                <Select id={id} value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as RenewalStatus }))}>
                  {(Object.keys(RENEWAL_STATUS_LABELS) as RenewalStatus[]).map((s) => <option key={s} value={s}>{RENEWAL_STATUS_LABELS[s]}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Renewal link">
            {(id) => <Input id={id} type="url" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://…" />}
          </Field>
          <Field label="Notes">
            {(id) => <Textarea id={id} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Policy #, account, where the document lives…" />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Add renewal'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

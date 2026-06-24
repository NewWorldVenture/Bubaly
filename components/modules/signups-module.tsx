'use client';

import { useMemo, useState } from 'react';
import {
  CalendarClock, Plus, Pencil, Trash2, AlertTriangle, Clock, ExternalLink,
  DollarSign, Check,
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
  groupByUrgency, opportunityStats, daysToDeadline, isMissed,
  OPPORTUNITY_STATUS_LABELS, URGENCY_BUCKET_LABELS,
  type OpportunityLike, type UrgencyBucket,
} from '@/lib/opportunities/deadlines';
import type { Tables, OpportunityStatus } from '@/lib/database.types';

type Opportunity = Tables<'opportunities'>;

const CATEGORIES = ['camp', 'school', 'sports', 'activity', 'class', 'other'];
const BUCKET_ORDER: UrgencyBucket[] = ['missed', 'closing_soon', 'upcoming', 'no_deadline', 'done'];
const BUCKET_ACCENT: Record<UrgencyBucket, string> = {
  missed: 'text-rose-400', closing_soon: 'text-amber-400', upcoming: 'text-sky-400',
  no_deadline: 'text-muted', done: 'text-emerald-400',
};
const STATUS_STYLES: Record<OpportunityStatus, string> = {
  interested: 'text-slate-300 bg-slate-500/10 border-slate-500/30',
  registered: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  waitlisted: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  passed: 'text-muted bg-slate-500/10 border-slate-500/30',
  missed: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
};

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const blank = {
  id: '', member_id: '', title: '', category: 'camp', url: '', cost: '',
  opens_at: '', deadline: '', status: 'interested' as OpportunityStatus, notes: '',
};

export function SignupsModule() {
  const { familyId, userId, members, role } = useApp();
  const { success, error: toastError } = useToast();
  const canEdit = isManager(role);

  const [showDone, setShowDone] = useState(false);
  const [memberFilter, setMemberFilter] = useState('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const { data: opps, loading, error } = useRealtimeQuery<Opportunity>({
    table: 'opportunities', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('opportunities').select('*').eq('family_id', familyId).order('deadline', { nullsFirst: false }),
  });

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;
  const tk = todayKey();

  const visible = useMemo(() => {
    let list = opps ?? [];
    if (memberFilter !== 'all') list = list.filter((o) => o.member_id === memberFilter);
    return list;
  }, [opps, memberFilter]);

  const stats = useMemo(() => opportunityStats(visible as OpportunityLike[], tk), [visible, tk]);
  const grouped = useMemo(() => groupByUrgency(visible as OpportunityLike[], tk), [visible, tk]);
  const oppById = useMemo(() => new Map((opps ?? []).map((o) => [o.id, o])), [opps]);

  function openNew() { setForm({ ...blank }); setModalOpen(true); }
  function openEdit(o: Opportunity) {
    setForm({
      id: o.id, member_id: o.member_id ?? '', title: o.title, category: o.category ?? 'other',
      url: o.url ?? '', cost: o.cost != null ? String(o.cost) : '', opens_at: o.opens_at ?? '',
      deadline: o.deadline ?? '', status: o.status, notes: o.notes ?? '',
    });
    setModalOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { toastError('Title is required'); return; }
    setSaving(true);
    const sb = createClient();
    const fields = {
      member_id: form.member_id || null,
      title: form.title.trim(),
      category: form.category || null,
      url: form.url.trim() || null,
      cost: form.cost ? Number(form.cost) : null,
      opens_at: form.opens_at || null,
      deadline: form.deadline || null,
      status: form.status,
      notes: form.notes.trim() || null,
    };
    const { error: err } = form.id
      ? await sb.from('opportunities').update(fields).eq('id', form.id)
      : await sb.from('opportunities').insert({ ...fields, family_id: familyId, created_by: userId });
    setSaving(false);
    if (err) { toastError(err.message); return; }
    success(form.id ? 'Signup updated' : 'Signup added');
    setModalOpen(false);
  }

  async function setStatus(o: Opportunity, status: OpportunityStatus) {
    const sb = createClient();
    const { error: err } = await sb.from('opportunities').update({ status }).eq('id', o.id);
    if (err) toastError(err.message);
  }

  async function remove(o: Opportunity) {
    if (!confirm(`Delete "${o.title}"?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('opportunities').delete().eq('id', o.id);
    if (err) { toastError(err.message); return; }
    success('Signup deleted');
  }

  const fmtDate = (key: string | null) => key ? new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const countdownLabel = (o: Opportunity) => {
    const d = daysToDeadline(o as OpportunityLike, tk);
    if (d == null) return null;
    if (d < 0) return `${Math.abs(d)}d ago`;
    if (d === 0) return 'Today';
    return `in ${d}d`;
  };

  if (loading) return <LoadingBlock label="Loading signups…" />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load signups'} />;

  const buckets = showDone ? BUCKET_ORDER : BUCKET_ORDER.filter((b) => b !== 'done');

  return (
    <div>
      <PageHeader
        title="Registrations & Signups"
        description="Never miss a camp, school, or activity registration deadline again."
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="signups" iconOnly />
            {canEdit && <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add signup</Button>}
          </div>
        }
      />

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <div className="rounded-2xl bg-surface/50 border border-border p-4 text-center">
          <div className="text-2xl font-bold text-fg">{stats.open}</div>
          <div className="text-xs text-muted mt-0.5">Open</div>
        </div>
        <div className={cn('rounded-2xl border p-4 text-center', stats.closingSoon > 0 ? 'bg-amber-500/5 border-amber-500/30' : 'bg-surface/50 border-border')}>
          <div className={cn('text-2xl font-bold', stats.closingSoon > 0 ? 'text-amber-400' : 'text-fg')}>{stats.closingSoon}</div>
          <div className="text-xs text-muted mt-0.5">Closing soon</div>
        </div>
        <div className={cn('rounded-2xl border p-4 text-center', stats.missed > 0 ? 'bg-rose-500/5 border-rose-500/30' : 'bg-surface/50 border-border')}>
          <div className={cn('text-2xl font-bold', stats.missed > 0 ? 'text-rose-400' : 'text-fg')}>{stats.missed}</div>
          <div className="text-xs text-muted mt-0.5">Missed</div>
        </div>
        <div className="rounded-2xl bg-surface/50 border border-border p-4 text-center">
          <div className="text-2xl font-bold text-emerald-400">{stats.registered}</div>
          <div className="text-xs text-muted mt-0.5">Registered</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-1.5 mb-5">
        {[{ id: 'all', label: 'Everyone' }, ...members.map((m) => ({ id: m.id, label: m.display_name }))].map((opt) => (
          <button key={opt.id} onClick={() => setMemberFilter(opt.id)}
            className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition', memberFilter === opt.id ? 'bg-brand text-white' : 'bg-surface/50 text-muted hover:text-fg border border-border')}>
            {opt.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="h-4 w-4 rounded border-border" />
          Show decided
        </label>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={CalendarClock} title="No signups tracked"
          description={canEdit ? 'Add camp, school, and activity registrations to track their deadlines.' : 'No signups have been added yet.'}
          action={canEdit && <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add signup</Button>} />
      ) : (
        <div className="space-y-6">
          {buckets.map((bucket) => {
            const list = grouped[bucket];
            if (list.length === 0) return null;
            return (
              <div key={bucket}>
                <h2 className={cn('text-sm font-semibold uppercase tracking-wider mb-2.5 flex items-center gap-2', BUCKET_ACCENT[bucket])}>
                  {bucket === 'missed' && <AlertTriangle className="h-4 w-4" />}
                  {bucket === 'closing_soon' && <Clock className="h-4 w-4" />}
                  {URGENCY_BUCKET_LABELS[bucket]} <span className="text-muted font-normal">({list.length})</span>
                </h2>
                <div className="space-y-2">
                  {list.map((row) => {
                    const o = oppById.get(row.id)!;
                    const missed = isMissed(row, tk);
                    return (
                      <div key={o.id} className={cn('rounded-xl border p-4', missed ? 'border-rose-500/30 bg-rose-500/[0.03]' : 'border-border bg-surface/50')}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-fg">{o.title}</span>
                              {o.category && <span className="text-[10px] uppercase tracking-wide rounded bg-brand/10 text-brand px-1.5 py-0.5">{o.category}</span>}
                              <span className={cn('text-[10px] uppercase tracking-wide rounded border px-1.5 py-0.5', STATUS_STYLES[o.status])}>{OPPORTUNITY_STATUS_LABELS[o.status]}</span>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                              {o.member_id && <span className="inline-flex items-center gap-1"><Avatar name={memberName(o.member_id) ?? '?'} size={14} />{memberName(o.member_id)}</span>}
                              {o.deadline && <span className={cn('inline-flex items-center gap-1', missed && 'text-rose-400')}><CalendarClock className="h-3.5 w-3.5" />Deadline {fmtDate(o.deadline)} · {countdownLabel(o)}</span>}
                              {o.cost != null && <span className="inline-flex items-center gap-0.5"><DollarSign className="h-3.5 w-3.5" />{o.cost}</span>}
                              {o.url && <a href={o.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand hover:underline"><ExternalLink className="h-3.5 w-3.5" />Register</a>}
                            </div>
                            {o.notes && <p className="mt-1.5 text-sm text-fg/80">{o.notes}</p>}
                          </div>
                          {canEdit && (
                            <div className="flex items-center gap-1 flex-shrink-0">
                              {o.status !== 'registered' && (
                                <button onClick={() => setStatus(o, 'registered')} aria-label="Mark registered" className="p-1.5 rounded-lg text-muted hover:text-emerald-400 hover:bg-elevated"><Check className="h-4 w-4" /></button>
                              )}
                              <button onClick={() => openEdit(o)} aria-label="Edit" className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-elevated"><Pencil className="h-4 w-4" /></button>
                              <button onClick={() => remove(o)} aria-label="Delete" className="p-1.5 rounded-lg text-muted hover:text-rose-400 hover:bg-elevated"><Trash2 className="h-4 w-4" /></button>
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
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={form.id ? 'Edit signup' : 'Add signup'}>
        <form onSubmit={save} className="space-y-4">
          <Field label="What is it?" required>
            {(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Summer soccer camp" autoFocus />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              {(id) => (
                <Select id={id} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}>
                  {CATEGORIES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
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
            <Field label="Registration opens">
              {(id) => <Input id={id} type="date" value={form.opens_at} onChange={(e) => setForm((f) => ({ ...f, opens_at: e.target.value }))} />}
            </Field>
            <Field label="Deadline">
              {(id) => <Input id={id} type="date" value={form.deadline} onChange={(e) => setForm((f) => ({ ...f, deadline: e.target.value }))} />}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cost ($)">
              {(id) => <Input id={id} type="number" min={0} step="0.01" value={form.cost} onChange={(e) => setForm((f) => ({ ...f, cost: e.target.value }))} placeholder="0.00" />}
            </Field>
            <Field label="Status">
              {(id) => (
                <Select id={id} value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as OpportunityStatus }))}>
                  {(Object.keys(OPPORTUNITY_STATUS_LABELS) as OpportunityStatus[]).map((s) => <option key={s} value={s}>{OPPORTUNITY_STATUS_LABELS[s]}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Registration link">
            {(id) => <Input id={id} type="url" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://…" />}
          </Field>
          <Field label="Notes">
            {(id) => <Textarea id={id} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Spots limited, bring forms…" />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Add signup'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

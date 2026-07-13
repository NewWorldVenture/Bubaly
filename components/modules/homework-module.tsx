'use client';

import { useMemo, useState } from 'react';
import {
  BookOpen, Plus, Pencil, Trash2, Check, AlertTriangle, Clock,
  CircleDashed, GraduationCap,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { cn } from '@/lib/utils/cn';
import {
  groupByDue, homeworkStats, isOverdue, HOMEWORK_STATUS_LABELS, DUE_BUCKET_LABELS,
  type HomeworkLike, type DueBucket,
} from '@/lib/homework/board';
import type { Tables, HomeworkStatus } from '@/lib/database.types';

type Homework = Tables<'homework_assignments'>;

const BUCKET_ORDER: DueBucket[] = ['overdue', 'today', 'upcoming', 'no_date', 'done'];
const BUCKET_ACCENT: Record<DueBucket, string> = {
  overdue: 'text-rose-400', today: 'text-amber-400', upcoming: 'text-sky-400',
  no_date: 'text-muted', done: 'text-emerald-400',
};
const NEXT_STATUS: Record<HomeworkStatus, HomeworkStatus> = {
  assigned: 'in_progress', in_progress: 'done', done: 'assigned', submitted: 'assigned',
};

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const blank = { id: '', member_id: '', subject: '', title: '', details: '', due_at: '', status: 'assigned' as HomeworkStatus };

export function HomeworkModule() {
  const { familyId, userId, members, role } = useApp();
  const { success, error: toastError } = useToast();
  void role;

  const [memberFilter, setMemberFilter] = useState('all');
  const [showDone, setShowDone] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const { data: homework, loading, error } = useRealtimeQuery<Homework>({
    table: 'homework_assignments', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('homework_assignments').select('*').eq('family_id', familyId).order('due_at', { nullsFirst: false }),
  });

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;
  const students = useMemo(() => members.filter((m) => m.role === 'child' || m.role === 'teen'), [members]);
  const now = useMemo(() => new Date(), []);

  const visible = useMemo(() => {
    let list = homework ?? [];
    if (memberFilter !== 'all') list = list.filter((h) => h.member_id === memberFilter);
    return list;
  }, [homework, memberFilter]);

  const stats = useMemo(() => homeworkStats(visible as HomeworkLike[], now), [visible, now]);
  const grouped = useMemo(() => groupByDue(visible as HomeworkLike[], now), [visible, now]);
  const hwById = useMemo(() => new Map((homework ?? []).map((h) => [h.id, h])), [homework]);

  function openNew() { setForm({ ...blank, member_id: students[0]?.id ?? '' }); setModalOpen(true); }
  function openEdit(h: Homework) {
    setForm({ id: h.id, member_id: h.member_id ?? '', subject: h.subject ?? '', title: h.title, details: h.details ?? '', due_at: toLocalInput(h.due_at), status: h.status });
    setModalOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { toastError('Title is required'); return; }
    setSaving(true);
    const sb = createClient();
    const isDone = form.status === 'done' || form.status === 'submitted';
    const fields = {
      member_id: form.member_id || null,
      subject: form.subject.trim() || null,
      title: form.title.trim(),
      details: form.details.trim() || null,
      due_at: form.due_at ? new Date(form.due_at).toISOString() : null,
      status: form.status,
      completed_at: isDone ? new Date().toISOString() : null,
    };
    const { error: err } = form.id
      ? await sb.from('homework_assignments').update(fields).eq('id', form.id)
      : await sb.from('homework_assignments').insert({ ...fields, family_id: familyId, created_by: userId });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(form.id ? 'Homework updated' : 'Homework added');
    setModalOpen(false);
  }

  async function cycleStatus(h: Homework) {
    const next = NEXT_STATUS[h.status];
    const isDone = next === 'done' || next === 'submitted';
    const sb = createClient();
    const { error: err } = await sb.from('homework_assignments').update({
      status: next, completed_at: isDone ? new Date().toISOString() : null,
    }).eq('id', h.id);
    if (err) toastError(describeDbError(err));
  }

  async function remove(h: Homework) {
    if (!confirm(`Delete "${h.title}"?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('homework_assignments').delete().eq('id', h.id);
    if (err) { toastError(describeDbError(err)); return; }
    success('Homework deleted');
  }

  const fmtDue = (iso: string | null) => {
    if (!iso) return null;
    return new Date(iso).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  };

  if (loading) return <SkeletonList count={5} />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load homework'} />;

  const buckets = showDone ? BUCKET_ORDER : BUCKET_ORDER.filter((b) => b !== 'done');

  return (
    <div>
      <PageHeader
        title="Homework"
        description="Keep every assignment on track — by student, by due date, with overdue alerts."
        action={<div className="flex items-center gap-2"><AiInsight kind="homework" /><Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add homework</Button></div>}
      />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <div className="rounded-2xl bg-surface/50 border border-border p-4 text-center">
          <div className="text-2xl font-bold text-fg">{stats.open}</div>
          <div className="text-xs text-muted mt-0.5">Open</div>
        </div>
        <div className={cn('rounded-2xl border p-4 text-center', stats.overdue > 0 ? 'bg-rose-500/5 border-rose-500/30' : 'bg-surface/50 border-border')}>
          <div className={cn('text-2xl font-bold', stats.overdue > 0 ? 'text-rose-400' : 'text-fg')}>{stats.overdue}</div>
          <div className="text-xs text-muted mt-0.5">Overdue</div>
        </div>
        <div className="rounded-2xl bg-surface/50 border border-border p-4 text-center">
          <div className="text-2xl font-bold text-emerald-400">{stats.completionRate}%</div>
          <div className="text-xs text-muted mt-0.5">Completed</div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-1.5 mb-5">
        {[{ id: 'all', label: 'Everyone' }, ...students.map((s) => ({ id: s.id, label: s.display_name }))].map((opt) => (
          <button key={opt.id} onClick={() => setMemberFilter(opt.id)}
            className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition', memberFilter === opt.id ? 'bg-brand text-white' : 'bg-surface/50 text-muted hover:text-fg border border-border')}>
            {opt.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-sm text-muted">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} className="h-4 w-4 rounded border-border" />
          Show completed
        </label>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={BookOpen} title="No homework yet"
          description="Add assignments to track due dates and progress for each student."
          action={<Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add homework</Button>} />
      ) : (
        <div className="space-y-6">
          {buckets.map((bucket) => {
            const list = grouped[bucket];
            if (list.length === 0) return null;
            return (
              <div key={bucket}>
                <h2 className={cn('text-sm font-semibold uppercase tracking-wider mb-2.5 flex items-center gap-2', BUCKET_ACCENT[bucket])}>
                  {bucket === 'overdue' && <AlertTriangle className="h-4 w-4" />}
                  {bucket === 'today' && <Clock className="h-4 w-4" />}
                  {DUE_BUCKET_LABELS[bucket]} <span className="text-muted font-normal">({list.length})</span>
                </h2>
                <div className="space-y-2">
                  {list.map((row) => {
                    const h = hwById.get(row.id)!;
                    const overdue = isOverdue(row, now);
                    const done = h.status === 'done' || h.status === 'submitted';
                    return (
                      <div key={h.id} className={cn('flex items-start gap-3 rounded-xl border p-3.5', overdue ? 'border-rose-500/30 bg-rose-500/[0.03]' : 'border-border bg-surface/50')}>
                        <button onClick={() => cycleStatus(h)} aria-label="Cycle status"
                          className={cn('mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-lg border flex-shrink-0 transition',
                            done ? 'bg-emerald-500 border-emerald-500 text-white'
                              : h.status === 'in_progress' ? 'border-amber-500 text-amber-400'
                              : 'border-border text-muted hover:border-brand/50')}>
                          {done ? <Check className="h-4 w-4" /> : h.status === 'in_progress' ? <CircleDashed className="h-4 w-4" /> : null}
                        </button>
                        <div className="flex-1 min-w-0">
                          <div className={cn('text-sm font-medium flex items-center gap-2 flex-wrap', done ? 'text-muted line-through' : 'text-fg')}>
                            {h.subject && <span className="text-xs uppercase tracking-wide text-brand-text bg-brand/10 rounded px-1.5 py-0.5 no-underline">{h.subject}</span>}
                            {h.title}
                          </div>
                          {h.details && <div className="text-xs text-muted mt-0.5">{h.details}</div>}
                          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted">
                            {h.member_id && <span className="inline-flex items-center gap-1"><Avatar name={memberName(h.member_id) ?? '?'} size={14} />{memberName(h.member_id)}</span>}
                            {h.due_at && <span className={cn(overdue && 'text-rose-400')}>Due {fmtDue(h.due_at)}</span>}
                            <span className="text-muted">· {HOMEWORK_STATUS_LABELS[h.status]}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button onClick={() => openEdit(h)} aria-label="Edit" className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-elevated"><Pencil className="h-4 w-4" /></button>
                          <button onClick={() => remove(h)} aria-label="Delete" className="p-1.5 rounded-lg text-muted hover:text-rose-400 hover:bg-elevated"><Trash2 className="h-4 w-4" /></button>
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
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={form.id ? 'Edit homework' : 'Add homework'}>
        <form onSubmit={save} className="space-y-4">
          <Field label="Assignment" required>
            {(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Chapter 7 problems 1–20" autoFocus />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Subject">
              {(id) => <Input id={id} value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="Math" />}
            </Field>
            <Field label="Student">
              {(id) => (
                <Select id={id} value={form.member_id} onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}>
                  <option value="">Unassigned</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due">
              {(id) => <Input id={id} type="datetime-local" value={form.due_at} onChange={(e) => setForm((f) => ({ ...f, due_at: e.target.value }))} />}
            </Field>
            <Field label="Status">
              {(id) => (
                <Select id={id} value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as HomeworkStatus }))}>
                  {(Object.keys(HOMEWORK_STATUS_LABELS) as HomeworkStatus[]).map((s) => <option key={s} value={s}>{HOMEWORK_STATUS_LABELS[s]}</option>)}
                </Select>
              )}
            </Field>
          </div>
          <Field label="Details">
            {(id) => <Textarea id={id} value={form.details} onChange={(e) => setForm((f) => ({ ...f, details: e.target.value }))} placeholder="Instructions, resources, page numbers…" />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Add homework'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

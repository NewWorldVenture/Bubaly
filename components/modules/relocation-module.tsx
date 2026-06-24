'use client';

import { useMemo, useState } from 'react';
import {
  Plus, Trash2, ChevronRight, CheckCircle2, Circle, Clock, SkipForward, Sparkles, X,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import type { Tables } from '@/lib/database.types';
import type { RelocationInsights, RelocationAIResponse } from '@/lib/relocation/relocation-ai';
import {
  RELOCATION_STATUSES, TASK_STATUSES, TASK_CATEGORIES,
  relocationStatusMeta, taskProgress, tasksByCategory,
  daysUntilMove, relocationSummary, fmtMoney, fmtDate,
} from '@/lib/relocation/guide';

type Relocation = Tables<'family_relocations'>;
type Task = Tables<'relocation_tasks'>;

const TASK_ICONS: Record<string, typeof Circle> = {
  todo: Circle,
  in_progress: Clock,
  done: CheckCircle2,
  skipped: SkipForward,
};

export function RelocationModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const relocations = useRealtimeQuery<Relocation>({
    table: 'family_relocations', familyId,
    fetcher: (s) => s.from('family_relocations').select('*').eq('family_id', familyId).eq('is_active', true).order('created_at', { ascending: false }),
    deps: [familyId],
  });

  const [selectedRel, setSelectedRel] = useState<Relocation | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<RelocationInsights | null>(null);
  const [aiInsights, setAiInsights] = useState<RelocationAIResponse | null>(null);

  async function runAiAssist() {
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/relocation', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'AI analysis failed');
      setAiAnalysis(json.analysis ?? null);
      setAiInsights(json.aiInsights ?? null);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'AI analysis failed');
    } finally {
      setAiLoading(false);
    }
  }

  const summary = useMemo(() => {
    if (!relocations.data) return null;
    return relocationSummary(relocations.data);
  }, [relocations.data]);

  if (relocations.loading) return <LoadingBlock />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Relocation Guide"
        action={
          <Button variant="outline" onClick={runAiAssist} loading={aiLoading}>
            <Sparkles className="h-4 w-4 text-brand" /> AI Assist
          </Button>
        }
      />

      {(aiAnalysis || aiInsights) && (
        <div className="rounded-2xl border border-brand/30 bg-brand/5 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-bold">
              <Sparkles className="h-4 w-4 text-brand" /> AI Relocation Insights
            </p>
            <button onClick={() => { setAiAnalysis(null); setAiInsights(null); }}><X className="h-4 w-4 text-muted" /></button>
          </div>
          {aiAnalysis && <p className="mb-3 text-sm text-muted">{aiAnalysis.summary}</p>}
          {aiInsights && (
            <div className="space-y-2">
              {aiInsights.suggestions.map((s, i) => (
                <p key={i} className="text-sm">• {s}</p>
              ))}
              {aiInsights.movingTips.length > 0 && (
                <div className="mt-2 pt-2 border-t border-brand/20">
                  <p className="text-xs font-semibold text-brand mb-1">Moving Tips</p>
                  {aiInsights.movingTips.map((t, i) => <p key={i} className="text-xs text-muted">• {t}</p>)}
                </div>
              )}
              {aiInsights.timelineTip && <p className="mt-2 text-xs text-muted italic">{aiInsights.timelineTip}</p>}
            </div>
          )}
        </div>
      )}

      {summary && summary.count > 0 && (
        <div className="rounded-xl border border-border bg-surface/60 p-4">
          <p className="text-sm font-medium">{summary.text}</p>
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="w-4 h-4 mr-1" /> New Relocation</Button>
      </div>

      {(!relocations.data || relocations.data.length === 0) ? (
        <EmptyState title="No relocations" description="Plan and track family moves with checklists, budgets, and timelines." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {relocations.data.map((r) => {
            const meta = relocationStatusMeta(r.status);
            const days = daysUntilMove(r.target_date);
            return (
              <button key={r.id} onClick={() => setSelectedRel(r)}
                className="text-left rounded-xl border border-border bg-surface/60 p-5 hover:border-primary/40 transition-colors">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xl font-bold">{r.title || 'Untitled'}</span>
                  <ChevronRight className="w-4 h-4 text-muted" />
                </div>
                <p className="text-sm text-muted">{r.from_location} → {r.to_location}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs px-2 py-0.5 rounded-full border border-border bg-surface/40">
                    {meta.emoji} {meta.label}
                  </span>
                  {r.target_date && (
                    <span className="text-xs text-muted">{fmtDate(r.target_date)}</span>
                  )}
                  {days != null && days >= 0 && (
                    <span className="text-xs font-medium text-amber-400">{days}d away</span>
                  )}
                  {r.budget != null && (
                    <span className="text-xs text-muted">{fmtMoney(Number(r.budget))}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {addOpen && (
        <AddRelocationModal familyId={familyId} userId={userId}
          onClose={() => setAddOpen(false)}
          onSuccess={() => { setAddOpen(false); success('Relocation created'); }} />
      )}
      {selectedRel && (
        <RelocationDetail relocation={selectedRel} familyId={familyId} userId={userId} members={members}
          onClose={() => setSelectedRel(null)}
          onDelete={() => { setSelectedRel(null); success('Relocation removed'); }} />
      )}
    </div>
  );
}

function AddRelocationModal({ familyId, userId, onClose, onSuccess }: {
  familyId: string; userId: string; onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('family_relocations').insert({
      family_id: familyId,
      created_by: userId,
      title: String(f.get('title') ?? ''),
      from_location: String(f.get('from_location') ?? ''),
      to_location: String(f.get('to_location') ?? ''),
      status: String(f.get('status') ?? 'researching') as Relocation['status'],
      target_date: String(f.get('target_date') ?? '') || null,
      budget: f.get('budget') ? Number(f.get('budget')) : null,
      reason: String(f.get('reason') ?? ''),
      notes: String(f.get('notes') ?? ''),
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  return (
    <Modal open onClose={onClose} title="New Relocation">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title" required>{(id) => <Input id={id} name="title" autoFocus placeholder="Summer 2026 Move" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From">{(id) => <Input id={id} name="from_location" placeholder="Current city" />}</Field>
          <Field label="To">{(id) => <Input id={id} name="to_location" placeholder="New city" />}</Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Status">{(id) =>
            <Select id={id} name="status" defaultValue="researching">
              {RELOCATION_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.emoji} {s.label}</option>)}
            </Select>
          }</Field>
          <Field label="Target Date">{(id) => <Input id={id} name="target_date" type="date" />}</Field>
          <Field label="Budget">{(id) => <Input id={id} name="budget" type="number" placeholder="0" />}</Field>
        </div>
        <Field label="Reason">{(id) => <Input id={id} name="reason" placeholder="Job transfer, family, etc." />}</Field>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}

function RelocationDetail({ relocation, familyId, userId, members, onClose, onDelete }: {
  relocation: Relocation; familyId: string; userId: string;
  members: { id: string; display_name: string }[];
  onClose: () => void; onDelete: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [addTaskOpen, setAddTaskOpen] = useState(false);

  const tasks = useRealtimeQuery<Task>({
    table: 'relocation_tasks', familyId,
    fetcher: (s) => s.from('relocation_tasks').select('*').eq('relocation_id', relocation.id).order('sort_order'),
    deps: [relocation.id],
  });

  const progress = useMemo(() => taskProgress(tasks.data ?? []), [tasks.data]);
  const catStats = useMemo(() => tasksByCategory(tasks.data ?? []), [tasks.data]);
  const meta = relocationStatusMeta(relocation.status);
  const days = daysUntilMove(relocation.target_date);

  async function handleDelete() {
    const { error } = await createClient().from('family_relocations').update({ is_active: false }).eq('id', relocation.id);
    if (error) { toastError(error.message); return; }
    onDelete();
  }

  async function cycleTaskStatus(t: Task) {
    const order: Task['status'][] = ['todo', 'in_progress', 'done', 'skipped'];
    const idx = order.indexOf(t.status);
    const next = order[(idx + 1) % order.length];
    const { error } = await createClient().from('relocation_tasks').update({ status: next }).eq('id', t.id);
    if (error) toastError(error.message);
  }

  async function removeTask(taskId: string) {
    const { error } = await createClient().from('relocation_tasks').delete().eq('id', taskId);
    if (error) toastError(error.message);
    else success('Task removed');
  }

  return (
    <Modal open onClose={onClose} title={relocation.title || 'Relocation'}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="px-2 py-0.5 rounded-full border border-border bg-surface/40">{meta.emoji} {meta.label}</span>
          <span className="text-muted">{relocation.from_location} → {relocation.to_location}</span>
          {relocation.target_date && <span className="text-muted">{fmtDate(relocation.target_date)}</span>}
          {days != null && days >= 0 && <span className="font-medium text-amber-400">{days}d away</span>}
          {relocation.budget != null && <span className="text-muted">{fmtMoney(Number(relocation.budget))}</span>}
        </div>

        {relocation.reason && <p className="text-sm text-muted">{relocation.reason}</p>}
        {relocation.notes && <p className="text-sm text-muted">{relocation.notes}</p>}

        {progress.total > 0 && (
          <div>
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="font-medium">Progress</span>
              <span>{progress.done}/{progress.total} ({progress.pct}%)</span>
            </div>
            <div className="h-2 rounded-full bg-surface/80 overflow-hidden">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progress.pct}%` }} />
            </div>
          </div>
        )}

        {catStats.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {catStats.map(({ category, total, done }) => (
              <span key={category} className="text-xs px-2 py-0.5 rounded-full border border-border bg-surface/40">
                {category}: {done}/{total}
              </span>
            ))}
          </div>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAddTaskOpen(true)}><Plus className="w-4 h-4 mr-1" /> Add Task</Button>
        </div>

        {(!tasks.data || tasks.data.length === 0) ? (
          <p className="text-sm text-muted text-center py-4">No tasks yet. Add checklist items to track your move.</p>
        ) : (
          <div className="space-y-1.5 max-h-96 overflow-y-auto">
            {tasks.data.map((t) => {
              const Icon = TASK_ICONS[t.status] ?? Circle;
              return (
                <div key={t.id} className="flex items-center gap-2 p-2.5 rounded-lg border border-border bg-surface/40">
                  <button onClick={() => cycleTaskStatus(t)} className="shrink-0">
                    <Icon className={`w-4 h-4 ${t.status === 'done' ? 'text-emerald-400' : t.status === 'skipped' ? 'text-muted' : 'text-primary'}`} />
                  </button>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium ${t.status === 'done' ? 'line-through text-muted' : ''}`}>{t.title}</p>
                    <p className="text-xs text-muted">{t.category}{t.due_date ? ` · ${fmtDate(t.due_date)}` : ''}</p>
                  </div>
                  <button onClick={() => removeTask(t.id)} className="text-muted hover:text-rose-400 p-1 shrink-0">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {addTaskOpen && (
          <AddTaskForm relocationId={relocation.id} familyId={familyId} userId={userId} members={members}
            onClose={() => setAddTaskOpen(false)}
            onSuccess={() => { setAddTaskOpen(false); success('Task added'); }} />
        )}

        <div className="flex justify-between pt-2 border-t border-border">
          <Button variant="ghost" size="sm" className="text-rose-400" onClick={handleDelete}>
            <Trash2 className="w-4 h-4 mr-1" /> Delete
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

function AddTaskForm({ relocationId, familyId, userId, members, onClose, onSuccess }: {
  relocationId: string; familyId: string; userId: string;
  members: { id: string; display_name: string }[];
  onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('relocation_tasks').insert({
      family_id: familyId,
      relocation_id: relocationId,
      created_by: userId,
      title: String(f.get('title') ?? ''),
      category: String(f.get('category') ?? 'Other'),
      status: String(f.get('status') ?? 'todo') as Task['status'],
      due_date: String(f.get('due_date') ?? '') || null,
      assigned_to: String(f.get('assigned_to') ?? '') || null,
      notes: String(f.get('notes') ?? ''),
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  return (
    <div className="rounded-lg border border-primary/30 bg-surface/60 p-4">
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Task" required>{(id) => <Input id={id} name="title" autoFocus placeholder="What needs to be done?" />}</Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Category">{(id) =>
            <Select id={id} name="category" defaultValue="Other">
              {TASK_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          }</Field>
          <Field label="Due Date">{(id) => <Input id={id} name="due_date" type="date" />}</Field>
          <Field label="Assign To">{(id) =>
            <Select id={id} name="assigned_to" defaultValue="">
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </Select>
          }</Field>
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" loading={loading}>Add</Button>
        </div>
      </form>
    </div>
  );
}

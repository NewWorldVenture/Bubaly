'use client';

import { useState } from 'react';
import { Target, Plus, Trash2, CheckCircle2, Loader2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Goal = Tables<'goals'>;

export function GoalsModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const { run, isPending } = useAction({ onError: (e) => toastError(describeDbError(e)) });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);

  const { data, loading, error, refresh } = useRealtimeQuery<Goal>({
    table: 'goals',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('goals').select('*').eq('family_id', familyId)
        .order('is_complete').order('target_date', { ascending: true, nullsFirst: false }),
  });

  function remove(id: string) {
    return run(`delete:${id}`, async () => {
      const { error } = await createClient().from('goals').delete().eq('id', id);
      if (error) throw error;
      success('Goal removed');
      void refresh();
    });
  }

  function updateProgress(goal: Goal, progress: number) {
    // Clamp to a valid 0–100 range before writing.
    const clamped = Math.max(0, Math.min(100, Math.round(progress)));
    return run(`progress:${goal.id}`, async () => {
      const isComplete = clamped >= 100;
      const { error } = await createClient().from('goals').update({ progress: clamped, is_complete: isComplete }).eq('id', goal.id);
      if (error) throw error;
      if (isComplete) success('Goal completed! 🎉');
      void refresh();
    });
  }

  const pendingFor = (id: string) => isPending(`delete:${id}`) || isPending(`progress:${id}`);

  const active = data.filter((g) => !g.is_complete);
  const completed = data.filter((g) => g.is_complete);

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title="Family Goals"
        description="Set goals, track progress, and celebrate achievements together."
        action={<div className="flex items-center gap-2"><AiInsight kind="goals" iconOnly /><Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New goal</Button></div>}
      />

      {data.length === 0 ? (
        <EmptyState icon={Target} title="No goals yet" description="Set a family goal — save for a trip, read more books, exercise together."
          action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New goal</Button>} />
      ) : (
        <>
          {active.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2">
              {active.map((g) => (
                <GoalCard key={g.id} goal={g} pending={pendingFor(g.id)} onEdit={() => setEditing(g)} onDelete={remove} onProgress={updateProgress} />
              ))}
            </div>
          )}

          {completed.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold text-muted">Completed</h2>
              <div className="grid gap-4 sm:grid-cols-2">
                {completed.map((g) => (
                  <GoalCard key={g.id} goal={g} pending={pendingFor(g.id)} onEdit={() => setEditing(g)} onDelete={remove} onProgress={updateProgress} />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {(open || editing) && (
        <GoalModal
          goal={editing}
          familyId={familyId}
          userId={userId}
          onClose={() => { setOpen(false); setEditing(null); }}
          onSaved={() => { setOpen(false); setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

function GoalCard({ goal, pending, onEdit, onDelete, onProgress }: {
  goal: Goal;
  pending: boolean;
  onEdit: () => void;
  onDelete: (id: string) => void;
  onProgress: (g: Goal, progress: number) => void;
}) {
  return (
    <Card className={cn('flex flex-col gap-3', goal.is_complete && 'opacity-70')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onEdit}>
          <div className="flex items-center gap-2">
            {goal.is_complete
              ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              : <Target className="h-5 w-5 shrink-0 text-brand" />}
            <p className="truncate font-semibold">{goal.title}</p>
          </div>
          {goal.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{goal.description}</p>}
          {goal.target_date && (
            <p className="mt-1 text-xs text-muted">Target: {fmtDate(goal.target_date)}</p>
          )}
        </div>
        <button onClick={() => onDelete(goal.id)} disabled={pending} className="rounded-lg p-1.5 text-muted transition hover:text-danger disabled:opacity-50" aria-label="Delete">
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </div>

      {/* Progress bar */}
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted">
          <span>Progress</span>
          <span>{goal.progress}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-elevated">
          <div
            className={cn('h-full rounded-full transition-all', goal.is_complete ? 'bg-success' : 'bg-brand')}
            style={{ width: `${goal.progress}%` }}
          />
        </div>
        {!goal.is_complete && (
          <div className="mt-2 flex gap-2">
            {[25, 50, 75, 100].map((v) => (
              <button
                key={v}
                onClick={() => onProgress(goal, v)}
                disabled={pending}
                className={cn(
                  'flex-1 rounded-lg border px-2 py-1 text-xs font-medium transition hover:bg-elevated disabled:opacity-50',
                  goal.progress >= v ? 'border-brand text-brand' : 'border-border text-muted',
                )}
              >
                {v}%
              </button>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function GoalModal({ goal, familyId, userId, onClose, onSaved }: {
  goal: Goal | null; familyId: string; userId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (!title) return toastError('Title is required');
    if (title.length > 120) return toastError('Title is too long (max 120 characters)');
    const targetDate = String(form.get('target_date') ?? '') || null;
    if (!goal && targetDate && new Date(targetDate) < new Date(new Date().toDateString())) {
      return toastError('Pick a target date in the future.');
    }
    setLoading(true);
    try {
      const supabase = createClient();
      const payload = {
        title,
        description: String(form.get('description') ?? '').trim() || null,
        target_date: targetDate,
      };
      const { error } = goal
        ? await supabase.from('goals').update(payload).eq('id', goal.id)
        : await supabase.from('goals').insert({ family_id: familyId, created_by: userId, ...payload, progress: 0, is_complete: false });
      if (error) { toastError(describeDbError(error)); return; }
      success(goal ? 'Goal updated' : 'Goal created');
      onSaved();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={goal ? 'Edit goal' : 'New family goal'}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Goal" required>
          {(id) => <Input id={id} name="title" defaultValue={goal?.title ?? ''} placeholder="Save for a family vacation" autoFocus />}
        </Field>
        <Field label="Description">
          {(id) => <Textarea id={id} name="description" defaultValue={goal?.description ?? ''} placeholder="Details about this goal…" />}
        </Field>
        <Field label="Target date">
          {(id) => <Input id={id} name="target_date" type="date" defaultValue={goal?.target_date ?? ''} />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{goal ? 'Save' : 'Create goal'}</Button>
        </div>
      </form>
    </Modal>
  );
}

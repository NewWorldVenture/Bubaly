'use client';

import { useState } from 'react';
import { Target, Plus, Trash2, CheckCircle2, Loader2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import { deleteGoalAction, saveGoalAction, setGoalProgressAction } from '@/app/(app)/dashboard/goals/actions';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Goal = Tables<'goals'>;

export function GoalsModule() {
  const t = useTranslations();
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
      const res = await deleteGoalAction(id);
      if (!res.ok) throw new Error(res.error);
      success(t('goalsModule.goalRemoved'));
      void refresh();
    });
  }

  function updateProgress(goal: Goal, progress: number) {
    const clamped = Math.max(0, Math.min(100, Math.round(progress)));
    return run(`progress:${goal.id}`, async () => {
      const isComplete = clamped >= 100;
      // `is_complete` is DERIVED by the service now. It used to be sent from
      // here, and three readers filter on it — the active/completed split,
      // lib/operating-index/server.ts and the digital-twin page — so a caller
      // that sent the two out of step desynchronised all three.
      const res = await setGoalProgressAction(goal.id, clamped);
      if (!res.ok) throw new Error(res.error);
      if (isComplete) success(t('goalsModule.goalCompleted'));
      void refresh();
    });
  }

  const pendingFor = (id: string) => isPending(`delete:${id}`) || isPending(`progress:${id}`);

  const active = data.filter((g) => !g.is_complete);
  const completed = data.filter((g) => g.is_complete);

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title={t('goals.familyGoals')}
        description={t('goalsModule.setGoalsTrackProgressAnd')}
        action={<div className="flex items-center gap-2"><AiInsight kind="goals" iconOnly /><Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> {t('goals.newGoal')}</Button></div>}
      />

      {data.length === 0 ? (
        <EmptyState icon={Target} title={t('goals.noGoalsYet')} description={t('goalsModule.setAFamilyGoalSave')}
          action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> {t('goals.newGoal')}</Button>} />
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
              <h2 className="mb-3 text-sm font-semibold text-muted">{t('goals.completed')}</h2>
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
  const t = useTranslations();
  return (
    <Card className={cn('flex flex-col gap-3', goal.is_complete && 'opacity-70')}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 cursor-pointer" onClick={onEdit}>
          <div className="flex items-center gap-2">
            {goal.is_complete
              ? <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
              : <Target className="h-5 w-5 shrink-0 text-brand-text" />}
            <p className="truncate font-semibold">{goal.title}</p>
          </div>
          {goal.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{goal.description}</p>}
          {goal.target_date && (
            <p className="mt-1 text-xs text-muted">Target: {fmtDate(goal.target_date)}</p>
          )}
        </div>
        <button onClick={() => onDelete(goal.id)} disabled={pending} className="rounded-lg p-1.5 text-muted transition hover:text-danger disabled:opacity-50" aria-label={t('goals.delete')}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </div>

      {/* Progress bar */}
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-muted">
          <span>{t('goals.progress')}</span>
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
                  goal.progress >= v ? 'border-brand text-brand-text' : 'border-border text-muted',
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
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (!title) return toastError(t('goalsModule.titleIsRequired'));
    if (title.length > 120) return toastError('Title is too long (max 120 characters)');
    const targetDate = String(form.get('target_date') ?? '') || null;
    if (!goal && targetDate && new Date(targetDate) < new Date(new Date().toDateString())) {
      return toastError(t('goalsModule.pickATargetDateIn'));
    }
    setLoading(true);
    try {
      const res = await saveGoalAction(goal?.id ?? null, {
        title,
        description: String(form.get('description') ?? '').trim() || null,
        targetDate,
      });
      if (!res.ok) { toastError(res.error); return; }
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
        <Field label={t('goals.goal')} required>
          {(id) => <Input id={id} name="title" defaultValue={goal?.title ?? ''} placeholder={t('goals.saveForAFamilyVacation')} autoFocus />}
        </Field>
        <Field label={t('goals.description')}>
          {(id) => <Textarea id={id} name="description" defaultValue={goal?.description ?? ''} placeholder={t('goals.detailsAboutThisGoal')} />}
        </Field>
        <Field label={t('goals.targetDate')}>
          {(id) => <Input id={id} name="target_date" type="date" defaultValue={goal?.target_date ?? ''} />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>{t('goals.cancel')}</Button>
          <Button type="submit" loading={loading}>{goal ? 'Save' : 'Create goal'}</Button>
        </div>
      </form>
    </Modal>
  );
}

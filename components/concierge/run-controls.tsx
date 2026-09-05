'use client';

// The human levers over a run (§17): pause, resume, cancel, try a failed step
// again, and edit a step before it runs. Which buttons appear is decided from
// the run state on the server-built view; who may press them is decided AGAIN
// in lib/ai/runs/controls.ts, so hiding a button is a courtesy, not the gate.
//
// Pause, resume and cancel are for a manager or the person who asked.
// Re-running and editing cause new writes with the run's authority, so they
// are managers only. Cancel asks once — it closes the run's open approvals and
// the steps that had not run, which is not something to undo by accident.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Pause, Pencil, Play, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { controlRunAction, type RunActionResult } from '@/app/(app)/dashboard/concierge/run-actions';
import { canTransitionRun, isTerminalRunState, type RunState } from '@/lib/ai/runs/states';
import type { EditableField } from '@/lib/approvals/card-data';
import { cn } from '@/lib/utils/cn';

export type EditableStep = { id: string; description: string; fields: EditableField[] };
export type FailedStep = { id: string; description: string };

export type EditStepAction = (stepId: string, edits: Record<string, string | number | boolean>) => Promise<RunActionResult<{ requeuedSteps: number }>>;

type Busy = 'pause' | 'resume' | 'cancel' | 'rerun' | 'edit' | null;

/** 44px targets on touch (`coarse:min-h-11`), compact on a pointer. */
const ACTION = 'coarse:min-h-11';

export function RunControls({
  runId,
  state,
  canControl,
  canManage,
  failedSteps,
  editableSteps,
  onEditStep,
  className,
}: {
  runId: string;
  state: RunState;
  /** Manager or requester: pause / resume / cancel. */
  canControl: boolean;
  /** Manager: re-run and edit. */
  canManage: boolean;
  failedSteps: FailedStep[];
  editableSteps: EditableStep[];
  onEditStep: EditStepAction;
  className?: string;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [editing, setEditing] = useState<EditableStep | null>(null);
  const [, startTransition] = useTransition();

  const terminal = isTerminalRunState(state);
  const showPause = canControl && !terminal && state !== 'paused' && canTransitionRun(state, 'paused');
  const showResume = canControl && state === 'paused';
  const showCancel = canControl && !terminal;
  const showRerun = canManage && state !== 'cancelled' && failedSteps.length > 0;
  const showEdit = canManage && state !== 'cancelled' && state !== 'completed' && editableSteps.length > 0;

  if (!showPause && !showResume && !showCancel && !showRerun && !showEdit) return null;

  const control = (action: 'pause' | 'resume' | 'cancel' | 'rerun', stepId?: string) => {
    if (busy) return;
    setBusy(action);
    startTransition(async () => {
      const res = await controlRunAction(runId, action, stepId ? { stepId } : {});
      setBusy(null);
      setConfirmCancel(false);
      if (!res.ok) {
        toastError(res.error);
        return;
      }
      success(res.data.detail);
      router.refresh();
    });
  };

  const submitEdit = (edits: Record<string, string | number | boolean>) => {
    if (!editing || busy) return;
    setBusy('edit');
    startTransition(async () => {
      const res = await onEditStep(editing.id, edits);
      setBusy(null);
      if (!res.ok) {
        toastError(res.error);
        return;
      }
      setEditing(null);
      success(res.data.requeuedSteps > 1
        ? `Saved — Bubaly will redo that step and the ${res.data.requeuedSteps - 1} after it.`
        : 'Saved — Bubaly will redo that step.');
      router.refresh();
    });
  };

  return (
    <div className={cn('space-y-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        {showPause && (
          <Button type="button" variant="outline" size="sm" className={ACTION} loading={busy === 'pause'} disabled={busy !== null} onClick={() => control('pause')}>
            {busy !== 'pause' && <Pause className="h-3.5 w-3.5" aria-hidden />} Pause
          </Button>
        )}
        {showResume && (
          <Button type="button" variant="primary" size="sm" className={ACTION} loading={busy === 'resume'} disabled={busy !== null} onClick={() => control('resume')}>
            {busy !== 'resume' && <Play className="h-3.5 w-3.5" aria-hidden />} Resume
          </Button>
        )}
        {showCancel && (
          <Button type="button" variant="ghost" size="sm" className={cn(ACTION, 'text-danger hover:bg-danger/10')} disabled={busy !== null} onClick={() => setConfirmCancel(true)}>
            <Ban className="h-3.5 w-3.5" aria-hidden /> Cancel
          </Button>
        )}
      </div>

      {showRerun && (
        <div className="rounded-2xl border border-danger/25 bg-danger/5 p-3">
          <p className="text-xs font-semibold text-fg">Something did not go through</p>
          <ul className="mt-2 space-y-1.5">
            {failedSteps.map((step) => (
              <li key={step.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-sm text-fg/90">{step.description}</span>
                <Button
                  type="button" variant="outline" size="sm" className={cn(ACTION, 'shrink-0')}
                  loading={busy === 'rerun'} disabled={busy !== null}
                  onClick={() => control('rerun', step.id)}
                  aria-label={`Try again: ${step.description}`}
                >
                  {busy !== 'rerun' && <RotateCcw className="h-3.5 w-3.5" aria-hidden />} Try again
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {showEdit && (
        <details className="rounded-2xl border border-border bg-surface/40">
          <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-3 text-sm font-medium text-fg focus-ring">
            <Pencil className="h-4 w-4 text-muted" aria-hidden /> Change a step
          </summary>
          <ul className="space-y-1.5 border-t border-border px-3 py-2">
            {editableSteps.map((step) => (
              <li key={step.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate text-sm text-fg/90">{step.description}</span>
                <Button type="button" variant="ghost" size="sm" className={cn(ACTION, 'shrink-0')} disabled={busy !== null} onClick={() => setEditing(step)} aria-label={`Edit: ${step.description}`}>
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        </details>
      )}

      <Modal open={confirmCancel} onClose={() => { if (busy !== 'cancel') setConfirmCancel(false); }} title="Cancel this?" description="Bubaly will stop here. What is already done stays done; the steps that have not run will not run." className="max-w-sm">
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" className={ACTION} onClick={() => setConfirmCancel(false)} disabled={busy === 'cancel'}>Keep going</Button>
          <Button type="button" variant="danger" className={ACTION} loading={busy === 'cancel'} disabled={busy !== null} onClick={() => control('cancel')}>Cancel the run</Button>
        </div>
      </Modal>

      {editing && (
        <EditStepModal
          step={editing}
          busy={busy === 'edit'}
          onClose={() => { if (busy !== 'edit') setEditing(null); }}
          onSubmit={submitEdit}
        />
      )}
    </div>
  );
}

/**
 * A small form over the step's editable scalars. Numbers are parsed on submit
 * and a blank one keeps the original value, so a fat-fingered field never
 * sends `NaN` into a tool schema. Only changed fields are sent: the server
 * merges them over the step's stored input.
 */
function EditStepModal({ step, busy, onClose, onSubmit }: {
  step: EditableStep;
  busy: boolean;
  onClose: () => void;
  onSubmit: (edits: Record<string, string | number | boolean>) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string | number | boolean>>({});

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const edits: Record<string, string | number | boolean> = {};
    for (const field of step.fields) {
      const value = draft[field.key];
      if (value === undefined) continue;
      if (field.type === 'number') {
        const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
        if (Number.isFinite(parsed)) edits[field.key] = parsed;
      } else if (field.type === 'boolean') {
        edits[field.key] = Boolean(value);
      } else {
        edits[field.key] = String(value);
      }
    }
    onSubmit(edits);
  };

  const valueOf = (field: EditableField) => (draft[field.key] === undefined ? field.value : draft[field.key]);

  return (
    <Modal open onClose={onClose} title="Change this step" description={step.description} className="max-w-md">
      <form onSubmit={submit} className="space-y-3">
        {step.fields.map((field) => (
          field.type === 'boolean' ? (
            <label key={field.key} className="flex min-h-11 items-center gap-3 rounded-xl border border-border bg-surface px-3 text-sm text-fg">
              <input type="checkbox" className="h-4 w-4 accent-brand" checked={Boolean(valueOf(field))} onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.checked }))} />
              {field.label}
            </label>
          ) : (
            <Field key={field.key} label={field.label}>
              {(id) => (
                <Input
                  id={id}
                  type={field.type === 'number' ? 'number' : 'text'}
                  inputMode={field.type === 'number' ? 'decimal' : undefined}
                  step={field.type === 'number' ? 'any' : undefined}
                  value={String(valueOf(field))}
                  onChange={(e) => setDraft((d) => ({ ...d, [field.key]: e.target.value }))}
                />
              )}
            </Field>
          )
        ))}
        <p className="text-xs text-muted">Bubaly will redo this step with your changes, and anything that depends on it.</p>
        <div className="flex items-center justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" className={ACTION} onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="primary" className={ACTION} loading={busy} disabled={busy}>{busy ? 'Saving…' : 'Save & continue'}</Button>
        </div>
      </form>
    </Modal>
  );
}

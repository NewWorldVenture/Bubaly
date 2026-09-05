'use client';

// The §17 run timeline: "12 of 18 steps complete" and one readable line per
// step — ✓ done, ○ pending, ⚠ failed or blocked — with the last thing Bubaly
// said about that step underneath.
//
// What this component receives is a `RunView`, built by the server page from
// the family-scoped loader: step descriptions, event messages, the plan's
// reasoning_summary. It never receives `input_json`, `result_json`, event
// payloads or the model's reasoning, so it cannot render them by accident.
//
// Live updates (§42, §45): the page renders the full timeline on the server
// first, so a refresh never loses state; this component then watches
// `ai_run_events` and `ai_plan_steps` through the shared Realtime hook and
// asks the router for a fresh server render when either changes. The browser
// only ever reads ids and statuses — the read model stays on the server.
import { useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, Circle, Loader2, MinusCircle, PauseCircle, Clock } from 'lucide-react';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import type { RunEventView, RunProgressView, RunStepView, RunView } from '@/lib/ai/runs/detail';
import type { StepState } from '@/lib/ai/runs/states';
import { cn } from '@/lib/utils/cn';

// ─── The read model ──────────────────────────────────────────────────────────
//
// The view types live beside `toRunView` in lib/ai/runs/detail.ts, the one
// boundary the page, the GET route and the refresh action all build from.
// Type-only, so nothing server-side is bundled here.
export type { RunEventView, RunProgressView, RunStepView, RunView } from '@/lib/ai/runs/detail';

// ─── Pure timeline derivation ────────────────────────────────────────────────

export type TimelineGlyph = 'done' | 'pending' | 'problem' | 'active' | 'waiting' | 'skipped';

export type TimelineRow = { step: RunStepView; glyph: TimelineGlyph; note: string | null };

/** Event types whose message is not about a step's outcome and would only be noise under it. */
const QUIET_EVENT_TYPES = new Set(['model_call', 'step_started']);

export function glyphFor(status: StepState): TimelineGlyph {
  switch (status) {
    case 'completed': return 'done';
    case 'skipped': return 'skipped';
    case 'failed':
    case 'blocked':
    case 'cancelled':
      return 'problem';
    case 'executing':
    case 'verifying':
    case 'planning':
      return 'active';
    case 'awaiting_approval':
    case 'awaiting_context':
    case 'scheduled_followup':
      return 'waiting';
    default:
      return 'pending';
  }
}

/**
 * One row per step in plan order. The note under a step is its own error when
 * it failed, otherwise the most recent thing the timeline recorded about it
 * ("Created seven preparation tasks"), so a finished step reads as an outcome
 * rather than as a repeated description.
 */
export function timelineRows(steps: RunStepView[], events: RunEventView[]): TimelineRow[] {
  const lastNote = new Map<string, string>();
  for (const e of events) {
    if (!e.stepId || QUIET_EVENT_TYPES.has(e.type) || !e.message.trim()) continue;
    lastNote.set(e.stepId, e.message.trim());
  }
  return [...steps]
    .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id))
    .map((step) => {
      const glyph = glyphFor(step.status);
      const note = step.status === 'failed' && step.error ? step.error : lastNote.get(step.id) ?? null;
      return { step, glyph, note: note && note !== step.description ? note : null };
    });
}

// ─── Live refresh ────────────────────────────────────────────────────────────

type EventStamp = { id: string; created_at: string };
type StepStamp = { id: string; status: string; updated_at: string };

/**
 * Re-render from the server whenever the run's events or steps change.
 * Debounced, because the executor writes an event and a step update for the
 * same moment and one fresh render is enough for both.
 */
function useLiveRun(familyId: string, runId: string, planId: string | null) {
  const router = useRouter();
  const timer = useRef<number | null>(null);
  const schedule = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { timer.current = null; router.refresh(); }, 300);
  }, [router]);
  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const events = useRealtimeQuery<EventStamp>({
    table: 'ai_run_events',
    familyId,
    deps: [runId],
    fetcher: (supabase) => supabase.from('ai_run_events').select('id, created_at')
      .eq('family_id', familyId).eq('run_id', runId).order('created_at', { ascending: false }).limit(1),
  });
  const steps = useRealtimeQuery<StepStamp>({
    table: 'ai_plan_steps',
    familyId,
    deps: [planId ?? 'none'],
    fetcher: (supabase) => planId
      ? supabase.from('ai_plan_steps').select('id, status, updated_at').eq('family_id', familyId).eq('plan_id', planId).order('sequence')
      : Promise.resolve({ data: [] as StepStamp[], error: null }),
  });

  const lastEvent = useRef<string | null>(null);
  useEffect(() => {
    if (events.loading) return;
    const fp = events.data[0]?.id ?? '';
    if (lastEvent.current !== null && lastEvent.current !== fp) schedule();
    lastEvent.current = fp;
  }, [events.data, events.loading, schedule]);

  const lastSteps = useRef<string | null>(null);
  useEffect(() => {
    if (steps.loading) return;
    const fp = steps.data.map((s) => `${s.id}:${s.status}`).join(',');
    if (lastSteps.current !== null && lastSteps.current !== fp) schedule();
    lastSteps.current = fp;
  }, [steps.data, steps.loading, schedule]);
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const GLYPH_STYLES: Record<TimelineGlyph, { icon: React.ComponentType<{ className?: string }>; className: string; label: string }> = {
  done: { icon: Check, className: 'border-success/40 bg-success/15 text-success', label: 'Done' },
  pending: { icon: Circle, className: 'border-border bg-surface text-muted', label: 'Not started' },
  problem: { icon: AlertTriangle, className: 'border-danger/40 bg-danger/15 text-danger', label: 'Needs a look' },
  active: { icon: Loader2, className: 'border-brand/40 bg-brand/15 text-brand-text', label: 'In progress' },
  waiting: { icon: PauseCircle, className: 'border-warning/40 bg-warning/15 text-warning', label: 'Waiting' },
  skipped: { icon: MinusCircle, className: 'border-border bg-surface text-muted', label: 'Skipped' },
};

function Glyph({ glyph }: { glyph: TimelineGlyph }) {
  const { icon: Icon, className, label } = GLYPH_STYLES[glyph];
  return (
    <span
      role="img"
      aria-label={label}
      className={cn('grid h-7 w-7 shrink-0 place-items-center rounded-full border', className)}
    >
      <Icon className={cn('h-3.5 w-3.5', glyph === 'active' && 'animate-spin motion-reduce:animate-none')} />
    </span>
  );
}

export function ProgressBar({ progress }: { progress: RunProgressView }) {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-sm">
        <p className="font-semibold text-fg">
          {progress.total > 0 ? `${progress.done} of ${progress.total} step${progress.total === 1 ? '' : 's'} complete` : 'Getting started'}
        </p>
        {progress.total > 0 && <span className="text-xs tabular-nums text-muted">{pct}%</span>}
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-border" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
      </div>
      {(progress.failed > 0 || progress.blocked > 0 || progress.awaitingApproval > 0) && (
        <p className="mt-1.5 text-xs text-muted">{progress.label}</p>
      )}
    </div>
  );
}

function when(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function RunTimeline({ view, showActivity }: { view: RunView; showActivity: boolean }) {
  useLiveRun(view.familyId, view.id, view.planId);
  const rows = timelineRows(view.steps, view.events);
  const activity = view.events.filter((e) => e.message.trim());

  return (
    <div className="space-y-5">
      <ProgressBar progress={view.progress} />

      {rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
          {view.state === 'planning' || view.state === 'queued'
            ? 'Bubaly is working out the steps.'
            : view.state === 'awaiting_context'
              ? 'Bubaly needs one answer before it can plan this.'
              : 'There were no steps to run.'}
        </p>
      ) : (
        <ol className="space-y-1" aria-label="Steps">
          {rows.map(({ step, glyph, note }) => (
            <li key={step.id} data-step-status={step.status} className="flex gap-3 rounded-xl px-2 py-2">
              <Glyph glyph={glyph} />
              <div className="min-w-0 flex-1 pt-0.5">
                <p className={cn('text-sm', glyph === 'done' ? 'text-fg' : glyph === 'skipped' ? 'text-muted line-through' : 'text-fg')}>{step.description}</p>
                {note && <p className={cn('mt-0.5 text-xs', glyph === 'problem' ? 'text-danger' : 'text-muted')}>{note}</p>}
              </div>
            </li>
          ))}
        </ol>
      )}

      {showActivity && activity.length > 0 && (
        <details className="rounded-2xl border border-border bg-surface/40">
          <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-4 text-sm font-medium text-fg focus-ring">
            <Clock className="h-4 w-4 text-muted" aria-hidden /> Activity ({activity.length})
          </summary>
          <ol className="space-y-2 border-t border-border px-4 py-3" aria-label="Activity">
            {activity.map((e) => (
              <li key={e.id} className="flex items-start gap-3 text-xs">
                <span className="w-16 shrink-0 tabular-nums text-muted">{when(e.at)}</span>
                <span className={cn('min-w-0 flex-1', e.type === 'model_call' ? 'text-muted' : 'text-fg/85')}>
                  {e.type === 'model_call' ? `Thinking${e.metrics ? ` · ${e.metrics}` : ''}` : e.message}
                  {e.actor === 'member' && <span className="ml-1 text-muted">· by a family member</span>}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

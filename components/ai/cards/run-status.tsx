'use client';

// Run status card: "Bubaly is working on it — 2 of 5 steps" with a link to
// the run page, which is where controls and the full timeline live. While the
// run is still moving the card refreshes itself from the run detail route so
// a conversation left open shows the real state, not the state at send time;
// once the run reaches a terminal state it stops asking.
import { useEffect, useState } from 'react';
import { Activity, CheckCircle2, CircleAlert, Loader2, PauseCircle, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { runStatusCard, type RunStatusCard } from '@/lib/ai/result-cards';
import { CardFrame, type CardTone } from './index';

const TERMINAL = new Set(['completed', 'partially_completed', 'failed', 'cancelled']);
const POLL_MS = 5_000;
/** Enough for a long run without keeping a tab polling forever. */
const MAX_POLLS = 120;

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  completed: CheckCircle2, partially_completed: CheckCircle2, failed: XCircle, cancelled: XCircle,
  blocked: CircleAlert, awaiting_approval: CircleAlert, awaiting_context: CircleAlert, paused: PauseCircle,
};

function toneFor(status: string): CardTone {
  if (status === 'completed') return 'success';
  if (status === 'partially_completed' || status === 'awaiting_approval' || status === 'awaiting_context' || status === 'blocked' || status === 'paused') return 'warning';
  if (status === 'failed' || status === 'cancelled') return 'danger';
  return 'brand';
}

/** Turn a run detail response into the card's fields; tolerant of any missing part. */
export function cardFromRunDetail(runId: string, detail: unknown, fallback: RunStatusCard): RunStatusCard {
  const rec = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {};
  const run = rec.run && typeof rec.run === 'object' ? (rec.run as Record<string, unknown>) : {};
  const plan = rec.plan && typeof rec.plan === 'object' ? (rec.plan as Record<string, unknown>) : {};
  const steps = Array.isArray(rec.steps) ? rec.steps : [];
  // ai_plan_steps and family_automation_runs both expose the execution state
  // as `status` in the run view (`state` is the run's newer column, kept as a
  // fallback); reading the wrong field showed "0 of N" for every live run.
  const status = typeof run.status === 'string' ? run.status : typeof run.state === 'string' ? run.state : fallback.status;
  const stepState = (s: Record<string, unknown>) => String(s.status ?? s.state);
  const done = steps.filter((s) => s && typeof s === 'object' && ['completed', 'skipped'].includes(stepState(s as Record<string, unknown>))).length;
  const summary = typeof plan.reasoning_summary === 'string' && plan.reasoning_summary
    ? plan.reasoning_summary
    : typeof plan.objective === 'string' && plan.objective ? plan.objective : fallback.summary;
  return runStatusCard({ runId, status, summary, stepsDone: steps.length ? done : fallback.steps_done, stepsTotal: steps.length || fallback.steps_total });
}

export function RunStatusCardView({ card, compact = false, className }: { card: RunStatusCard; compact?: boolean; className?: string }) {
  const [live, setLive] = useState<RunStatusCard>(card);
  const [failed, setFailed] = useState(false);

  useEffect(() => { setLive(card); }, [card]);

  useEffect(() => {
    if (TERMINAL.has(live.status)) return;
    let polls = 0;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      polls += 1;
      try {
        const res = await fetch(`/api/ai/runs/${encodeURIComponent(card.run_id)}`, { headers: { accept: 'application/json' } });
        if (cancelled) return;
        if (!res.ok) {
          // A 404 means the run is not this family's (or is gone); anything
          // else is transient. Either way the card keeps its last known state
          // and says it could not refresh, rather than lying about progress.
          setFailed(true);
          if (res.status === 404) return;
        } else {
          setFailed(false);
          const detail: unknown = await res.json();
          setLive((prev) => cardFromRunDetail(card.run_id, detail, prev));
        }
      } catch (error) {
        if (cancelled) return;
        console.error('[run-status-card] refresh failed', error);
        setFailed(true);
      }
      if (!cancelled && polls < MAX_POLLS) timer = setTimeout(tick, POLL_MS);
    };
    timer = setTimeout(tick, 0);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // Restart polling only when the run changes or the status leaves a terminal state.
  }, [card.run_id, live.status]);

  const active = !TERMINAL.has(live.status);
  const Icon = ICONS[live.status] ?? (active ? Loader2 : Activity);
  const progress = live.steps_total ? `${live.steps_done ?? 0} of ${live.steps_total} steps` : null;

  return (
    <CardFrame
      icon={({ className: c }) => <Icon className={cn(c, Icon === Loader2 && 'animate-spin motion-reduce:animate-none')} />}
      tone={toneFor(live.status)}
      title={live.title}
      subtitle={live.subtitle ?? progress}
      href={live.href}
      hrefLabel="Follow along"
      compact={compact}
      className={className}
      footer={failed ? 'Couldn’t refresh the status just now — open the run for the latest.' : undefined}
    >
      {live.summary && <p className="text-sm text-fg/90">{live.summary}</p>}
      {live.steps_total ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated" role="progressbar" aria-valuemin={0} aria-valuemax={live.steps_total} aria-valuenow={live.steps_done ?? 0} aria-label="Steps completed">
          <div className={cn('h-full rounded-full', live.status === 'failed' ? 'bg-danger' : 'bg-brand')} style={{ width: `${Math.round(((live.steps_done ?? 0) / live.steps_total) * 100)}%` }} />
        </div>
      ) : null}
    </CardFrame>
  );
}

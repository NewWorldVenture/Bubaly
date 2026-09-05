// The §10 run state as a person reads it. No hooks, so the run page renders it
// on the server and the "Working on" card re-renders it from Realtime; the
// labels come from the executor's own table (lib/ai/runs/states.ts) so a state
// added there shows up here with copy rather than as a raw enum value.
import { Badge } from '@/components/ui/badge';
import { RUN_STATE_LABELS, type RunState } from '@/lib/ai/runs/states';
import { cn } from '@/lib/utils/cn';

type Tone = 'brand' | 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

/** A small pulse marks the states in which Bubaly is actively doing something. */
const LIVE_STATES: readonly RunState[] = ['planning', 'executing', 'verifying'];

const TONES: Readonly<Record<RunState, Tone>> = {
  queued: 'neutral',
  planning: 'brand',
  awaiting_context: 'warning',
  awaiting_approval: 'warning',
  ready: 'brand',
  executing: 'brand',
  verifying: 'brand',
  scheduled_followup: 'accent',
  paused: 'neutral',
  completed: 'success',
  partially_completed: 'warning',
  blocked: 'danger',
  failed: 'danger',
  cancelled: 'neutral',
};

export function statusTone(state: RunState): Tone {
  return TONES[state] ?? 'neutral';
}

export function statusLabel(state: RunState): string {
  return RUN_STATE_LABELS[state] ?? state;
}

export function StatusBadge({ state, className }: { state: RunState; className?: string }) {
  const live = LIVE_STATES.includes(state);
  return (
    <Badge tone={statusTone(state)} className={cn('whitespace-nowrap', className)} data-state={state}>
      {live && <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" />}
      {statusLabel(state)}
    </Badge>
  );
}

// The mark beside a run in an automation page's "recent runs" list: a green
// check ONLY for a run that completed. Server-safe (no hooks); the word beside
// it comes from the page's translator (lib/ai/runs/outcome.ts labelKey).
import { AlertTriangle, Ban, CheckCircle2, MinusCircle, PauseCircle, XCircle } from 'lucide-react';
import type { RunOutcomeState } from '@/lib/ai/runs/outcome';
import { cn } from '@/lib/utils/cn';

const ICONS: Readonly<Record<RunOutcomeState, { icon: React.ComponentType<{ className?: string }>; tone: string }>> = {
  completed: { icon: CheckCircle2, tone: 'text-emerald-400' },
  partially_completed: { icon: AlertTriangle, tone: 'text-amber-400' },
  failed: { icon: XCircle, tone: 'text-rose-400' },
  blocked: { icon: Ban, tone: 'text-rose-400' },
  paused: { icon: PauseCircle, tone: 'text-muted' },
  cancelled: { icon: MinusCircle, tone: 'text-muted' },
};

export function RunOutcomeIcon({ state }: { state: RunOutcomeState }) {
  const { icon: Icon, tone } = ICONS[state];
  return <Icon aria-hidden data-outcome={state} className={cn('h-4 w-4 shrink-0', tone)} />;
}

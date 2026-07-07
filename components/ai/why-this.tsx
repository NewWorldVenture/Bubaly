'use client';

// <WhyThis> — the reusable "Why this?" affordance (T7). Every AI recommendation
// or automation gets one consistent inline disclosure that answers: why did this
// surface, what inputs drove it, how confident is Bubaly — and lets the family
// respond (Helpful / Not helpful). Responses persist to ai_feedback so the AI
// can learn what lands. Pure explanation shaping lives in lib/ai/explanation.ts.
import { useState, useTransition } from 'react';
import { HelpCircle, ChevronDown, ThumbsUp, ThumbsDown, Check } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { Explanation } from '@/lib/ai/explanation';
import {
  recordAiFeedbackAction,
  type FeedbackSurface,
  type FeedbackSignal,
} from '@/app/(app)/dashboard/ai-feedback-actions';

type Props = {
  explanation: Explanation;
  /** Which AI surface this recommendation came from (for the feedback log). */
  surface: FeedbackSurface;
  /** Stable id + sub-type of the specific recommendation. */
  refId?: string | null;
  refKind?: string | null;
  /** Hide the Helpful / Not-helpful controls (read-only explanation). */
  hideFeedback?: boolean;
  className?: string;
  /** Compact trigger (icon only) for tight rows. */
  compact?: boolean;
};

export function WhyThis({ explanation, surface, refId, refKind, hideFeedback, className, compact }: Props) {
  const [open, setOpen] = useState(false);
  const [voted, setVoted] = useState<FeedbackSignal | null>(null);
  const [pending, startTransition] = useTransition();

  function send(signal: FeedbackSignal) {
    if (voted) return;
    setVoted(signal); // optimistic
    startTransition(async () => {
      const res = await recordAiFeedbackAction({
        surface, signal, refId: refId ?? null, refKind: refKind ?? null,
        reason: explanation.reason,
      });
      if (!res.ok) setVoted(null); // let them retry
    });
  }

  return (
    <div className={cn('text-xs', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 rounded-full text-muted transition hover:text-fg"
      >
        <HelpCircle className="h-3.5 w-3.5" />
        {!compact && <span className="font-medium">Why this?</span>}
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="mt-2 space-y-2 rounded-xl border border-border bg-surface/60 p-3">
          <p className="leading-5 text-fg">{explanation.reason}</p>

          {explanation.factors.length > 0 && (
            <dl className="space-y-1">
              {explanation.factors.map((f, i) => (
                <div key={i} className="flex gap-2">
                  <dt className="w-24 shrink-0 font-medium text-muted">{f.label}</dt>
                  <dd className="min-w-0 flex-1 text-fg">
                    {f.value}
                    {f.detail && <span className="text-muted"> · {f.detail}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {explanation.tip && (
            <p className="rounded-lg bg-brand/5 px-2.5 py-1.5 text-[11px] leading-4 text-muted">{explanation.tip}</p>
          )}

          {!hideFeedback && (
            <div className="flex items-center gap-2 border-t border-border pt-2">
              {voted ? (
                <span className="inline-flex items-center gap-1 text-[11px] text-success">
                  <Check className="h-3.5 w-3.5" /> Thanks — Bubaly will use that.
                </span>
              ) : (
                <>
                  <span className="text-[11px] text-muted">Was this helpful?</span>
                  <button
                    type="button" onClick={() => send('helpful')} disabled={pending}
                    aria-label="Helpful"
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[11px] transition hover:border-success/50 hover:text-success"
                  >
                    <ThumbsUp className="h-3.5 w-3.5" /> Yes
                  </button>
                  <button
                    type="button" onClick={() => send('not_helpful')} disabled={pending}
                    aria-label="Not helpful"
                    className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[11px] transition hover:border-danger/50 hover:text-danger"
                  >
                    <ThumbsDown className="h-3.5 w-3.5" /> No
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

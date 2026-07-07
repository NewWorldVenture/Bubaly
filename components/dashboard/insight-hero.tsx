'use client';

// The one proactive "insight of the day" (T4), surfaced above the fold on Home.
// A single high-impact, genuinely-helpful nudge — not a pile of notifications. The
// CTA deep-links to where it's handled; the ✕ dismisses it (server marks the row
// dismissed and the next-best insight surfaces on refresh).
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Sparkles, X, ArrowRight, Navigation, CalendarClock, GraduationCap,
  ShieldCheck, AlarmClock, RefreshCw, FileClock, Utensils, ShoppingCart, Rocket,
} from 'lucide-react';
import { dismissInsightAction } from '@/app/(app)/dashboard/insight-actions';
import { WhyThis } from '@/components/ai/why-this';
import { explainInsight } from '@/lib/ai/explanation';
import { cn } from '@/lib/utils/cn';

type Kind = 'departure' | 'conflict' | 'homework' | 'approval' | 'reminder_overdue'
  | 'renewal' | 'document' | 'meal' | 'grocery' | 'autopilot';

const META: Record<Kind, { icon: React.ComponentType<{ className?: string }>; cta: string }> = {
  departure: { icon: Navigation, cta: 'View plan' },
  conflict: { icon: CalendarClock, cta: 'Resolve' },
  homework: { icon: GraduationCap, cta: 'Review' },
  approval: { icon: ShieldCheck, cta: 'Review' },
  reminder_overdue: { icon: AlarmClock, cta: 'Catch up' },
  renewal: { icon: RefreshCw, cta: 'Renew' },
  document: { icon: FileClock, cta: 'View' },
  meal: { icon: Utensils, cta: 'Plan meals' },
  grocery: { icon: ShoppingCart, cta: 'Open list' },
  autopilot: { icon: Rocket, cta: 'Let Bubaly' },
};

export function InsightHero({ insight }: { insight: { id: string; kind: string; title: string; detail: string; href: string; impact?: number; alternatives?: number } }) {
  const router = useRouter();
  const [dismissed, setDismissed] = useState(false);
  const [pending, startTransition] = useTransition();
  if (dismissed) return null;

  const meta = META[insight.kind as Kind] ?? { icon: Sparkles, cta: 'View' };
  const Icon = meta.icon;

  function dismiss() {
    setDismissed(true); // optimistic
    startTransition(async () => {
      const res = await dismissInsightAction(insight.id);
      if (!res.ok) { setDismissed(false); return; }
      router.refresh();
    });
  }

  return (
    <div className="relative overflow-hidden rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/12 to-violet-500/8 p-5">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand">
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1 pr-6">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand">
            <Sparkles className="h-3 w-3" /> Insight of the day
          </p>
          <p className="mt-1 text-sm font-bold leading-snug">{insight.title}</p>
          <p className="mt-0.5 text-xs text-muted">{insight.detail}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Link href={insight.href}
              className="inline-flex items-center gap-1.5 rounded-full bg-brand px-3.5 py-1.5 text-xs font-semibold text-white transition hover:bg-brand/90">
              {meta.cta} <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <WhyThis
            className="mt-2"
            surface="insight"
            refId={insight.id}
            refKind={insight.kind}
            explanation={explainInsight({
              kind: insight.kind, title: insight.title, detail: insight.detail,
              impact: insight.impact ?? 50, alternatives: insight.alternatives ?? 0,
            })}
          />
        </div>
      </div>
      <button type="button" onClick={dismiss} disabled={pending} aria-label="Dismiss insight"
        className={cn('absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-full text-muted transition hover:bg-elevated hover:text-fg', pending && 'opacity-50')}>
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

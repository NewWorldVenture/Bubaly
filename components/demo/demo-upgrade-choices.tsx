'use client';

// The plan-choice UI shown to a visitor whose email has already used its one
// demo (the /demo/upgrade page). Same three options as the end-of-demo pop-up:
// Free 5-day trial, Family Basic, Family+. Choosing a paid plan routes through
// signup → billing (payment); free routes to the trial signup. Reuses the
// existing choosePlanAfterDemoAction server action.
import { useFormStatus } from 'react-dom';
import { Sparkles, Crown, Zap, ArrowRight } from 'lucide-react';
import { choosePlanAfterDemoAction } from '@/app/(marketing)/demo/actions';

const PLANS: { plan: string; title: string; blurb: string; icon: React.ReactNode; featured?: boolean }[] = [
  { plan: 'free', title: 'Free — 5-day trial', blurb: 'Everything, free for 5 days. No card required.', icon: <Zap className="h-5 w-5 text-emerald-400" /> },
  { plan: 'basic', title: 'Family Basic', blurb: 'The best family organizer on earth.', icon: <Crown className="h-5 w-5 text-yellow-400" />, featured: true },
  { plan: 'plus', title: 'Family+', blurb: 'Your family’s AI Chief of Staff.', icon: <Sparkles className="h-5 w-5 text-violet-400" /> },
];

function PlanRow({ plan, title, blurb, icon, featured }: (typeof PLANS)[number]) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name="plan"
      value={plan}
      disabled={pending}
      className={
        'flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition disabled:opacity-60 ' +
        (featured
          ? 'border-violet-400/70 bg-violet-500/10 ring-1 ring-violet-400/30 hover:bg-violet-500/15'
          : 'border-border bg-bg hover:bg-white/[0.04]')
      }
    >
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.06] ring-1 ring-white/10">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-bold text-fg">{title}</span>
        <span className="block text-xs text-white/60">{blurb}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-white/40" />
    </button>
  );
}

export function DemoUpgradeChoices() {
  return (
    <form action={choosePlanAfterDemoAction} className="mt-6 space-y-2.5">
      {PLANS.map((p) => <PlanRow key={p.plan} {...p} />)}
    </form>
  );
}

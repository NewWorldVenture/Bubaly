'use client';

// Outcomes launcher (North Star pillar #4). A calm, goal-first surface: pick an
// outcome ("Feed the Family") and the family sees the exact capabilities that
// get it done — auto-badged with what's urgent right now. The server computes
// the real, badged plans; this component is the interactive picker.
import { useState } from 'react';
import Link from 'next/link';
import {
  Sun, UtensilsCrossed, Plane, GraduationCap, Wallet, HeartPulse, Cake, ShieldAlert,
  ArrowRight, ChevronRight, Sparkles,
} from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import type { Outcome, OutcomeStep, OutcomeId } from '@/lib/outcomes/launcher';
import { useTranslations } from '@/components/i18n/locale-provider';

const ICON: Record<string, typeof Sun> = {
  sun: Sun, utensils: UtensilsCrossed, plane: Plane, graduation: GraduationCap,
  wallet: Wallet, 'heart-pulse': HeartPulse, cake: Cake, shield: ShieldAlert,
};
const ACCENT: Record<OutcomeId, string> = {
  run_today: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  feed_family: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  plan_trip: 'text-sky-300 bg-sky-500/10 border-sky-500/30',
  prepare_school: 'text-blue-300 bg-blue-500/10 border-blue-500/30',
  manage_money: 'text-violet-300 bg-violet-500/10 border-violet-500/30',
  stay_healthy: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
  celebrate: 'text-pink-300 bg-pink-500/10 border-pink-500/30',
  prepare_unexpected: 'text-orange-300 bg-orange-500/10 border-orange-500/30',
};

export type OutcomePlan = { outcome: Outcome; steps: OutcomeStep[]; urgency: number };

export function OutcomesLauncher({ plans }: { plans: OutcomePlan[] }) {
  const t = useTranslations();
  const [selectedId, setSelectedId] = useState<OutcomeId>(plans[0]?.outcome.id ?? 'run_today');
  const selected = plans.find((p) => p.outcome.id === selectedId) ?? plans[0];

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        title={t('outcomesLauncher.whatDoYouWantToGet')}
        description={t('outcomesLauncher.pickAnOutcomeWeLl')}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        {/* Outcome picker */}
        <div className="grid grid-cols-2 gap-3 self-start">
          {plans.map(({ outcome, urgency }) => {
            const Icon = ICON[outcome.icon] ?? Sparkles;
            const active = outcome.id === selectedId;
            return (
              <button
                key={outcome.id}
                onClick={() => setSelectedId(outcome.id)}
                className={cn('relative flex flex-col gap-2 rounded-2xl border p-4 text-left transition',
                  active ? 'border-brand bg-brand/5 ring-1 ring-brand/40' : 'border-border bg-surface/50 hover:bg-elevated')}
              >
                <span className={cn('grid h-10 w-10 place-items-center rounded-xl border', ACCENT[outcome.id])}>
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-sm font-semibold text-fg">{outcome.title}</span>
                <span className="line-clamp-2 text-xs text-muted">{outcome.tagline}</span>
                {urgency > 0 && (
                  <span className="absolute right-2 top-2 grid h-5 min-w-5 place-items-center rounded-full bg-brand px-1.5 text-[11px] font-bold text-white">
                    {urgency}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Selected outcome plan */}
        {selected && (
          <div className="rounded-2xl border border-border bg-surface/50 p-5">
            <div className="mb-1 flex items-center gap-2">
              {(() => { const Icon = ICON[selected.outcome.icon] ?? Sparkles; return (
                <span className={cn('grid h-9 w-9 place-items-center rounded-xl border', ACCENT[selected.outcome.id])}><Icon className="h-5 w-5" /></span>
              ); })()}
              <div>
                <h2 className="text-lg font-bold text-fg">{selected.outcome.title}</h2>
                <p className="text-xs text-muted">{selected.outcome.tagline}</p>
              </div>
            </div>

            <ul className="mt-4 space-y-2">
              {selected.steps.map((s) => (
                <li key={s.href + s.label}>
                  <Link href={s.href}
                    className="group flex items-center gap-3 rounded-xl border border-border bg-bg/40 p-3 transition hover:border-brand/40 hover:bg-elevated">
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted transition group-hover:text-brand-text" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-fg">{s.label}</span>
                        {s.badge && (
                          <span className="rounded-full bg-brand/15 px-1.5 py-0.5 text-[11px] font-semibold text-brand-text">{s.badge}</span>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted">{s.detail}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 shrink-0 text-muted opacity-0 transition group-hover:opacity-100" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

'use client';

// Outcomes launcher (North Star pillar #4). A calm, goal-first surface: pick an
// outcome ("Feed the Family") and the family sees the exact capabilities that
// get it done — auto-badged with what's urgent right now. The server computes
// the real, badged plans; this component is the interactive picker.
import { useState } from 'react';
import Link from 'next/link';
import {
  Sun, UtensilsCrossed, Plane, GraduationCap, Wallet, HeartPulse, Cake, ShieldAlert,
  ArrowRight, ChevronRight, Sparkles, AlertTriangle,
} from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { buildOutcomeLaunchRequest, describeOutcomeLaunch, type Outcome, type OutcomeStep, type OutcomeId } from '@/lib/outcomes/launcher';
import { submitAIRequest, type AIRequestOutcomeKind } from '@/lib/ai/chat-request';
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

/**
 * What the launch button knows. `filed` is only ever set from a response the
 * server sent back after it wrote the `ai_requests` row, and it carries the
 * server's OWN `outcome` — because "filed" is not "working on it": a request
 * can come back answered inline (`answer` / `recommendation`, no run row at
 * all) or parked on a question (`clarification`, a run waiting on the family).
 * Only `plan` is work under way. See the render below.
 */
type LaunchState =
  | { status: 'idle' }
  | { status: 'filing'; outcomeId: OutcomeId }
  | { status: 'filed'; outcomeId: OutcomeId; outcome: AIRequestOutcomeKind; runId: string | null; redirect: string | null; summary: string }
  | { status: 'failed'; outcomeId: OutcomeId; error: string };

export function OutcomesLauncher({ plans, initialOutcomeId }: { plans: OutcomePlan[]; initialOutcomeId?: OutcomeId | null }) {
  const t = useTranslations();
  const [selectedId, setSelectedId] = useState<OutcomeId>(initialOutcomeId && plans.some((plan) => plan.outcome.id === initialOutcomeId) ? initialOutcomeId : plans[0]?.outcome.id ?? 'run_today');
  const selected = plans.find((p) => p.outcome.id === selectedId) ?? plans[0];
  const [launch, setLaunch] = useState<LaunchState>({ status: 'idle' });
  const launchForSelected = launch.status !== 'idle' && launch.outcomeId === selectedId ? launch : null;

  async function launchOutcome(id: OutcomeId) {
    setLaunch({ status: 'filing', outcomeId: id });
    const request = buildOutcomeLaunchRequest(id);
    const result = await submitAIRequest({
      text: request.text,
      context: request.context,
      // One key per press: a retried POST of THIS submission (a dropped
      // connection, a proxy retry) is answered with the request it already
      // filed rather than planned again. A deliberate second launch later is a
      // new press and a new key, which is what the family asked for.
      clientRequestId: `outcome-${id}-${Date.now()}`,
    });
    if (!result.ok) {
      console.error('[outcomes] launch request failed', result.status, result.code, result.error);
      setLaunch({ status: 'failed', outcomeId: id, error: result.error });
      return;
    }
    setLaunch({
      status: 'filed',
      outcomeId: id,
      outcome: result.data.outcome,
      runId: result.data.runId ?? null,
      redirect: result.data.redirect ?? null,
      summary: result.data.summary ?? '',
    });
  }

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
                aria-pressed={active}
                onClick={() => setSelectedId(outcome.id)}
                className={cn('relative flex flex-col gap-2 rounded-2xl border p-4 text-left transition',
                  active ? 'border-brand bg-brand/5 ring-1 ring-brand/40' : 'border-border bg-surface/50 hover:bg-elevated')}
              >
                <span className={cn('grid h-10 w-10 place-items-center rounded-xl border', ACCENT[outcome.id])}>
                  <Icon className="h-5 w-5" />
                </span>
                <span className="text-sm font-semibold text-fg">{t(outcome.titleKey)}</span>
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
                <h2 className="text-lg font-bold text-fg">{t(selected.outcome.titleKey)}</h2>
                <p className="text-xs text-muted">{selected.outcome.tagline}</p>
              </div>
            </div>

            {/* M25: the outcome is a request, not only a menu. This files a real
                ai_requests row, and what is rendered afterwards is whatever the
                server says it did — a run in flight, a question it is parked on,
                or an answer. Never a claim of work with no run behind it. */}
            <div className="mt-4 rounded-xl border border-brand/30 bg-brand/5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted">{t('outcomesLauncher.orHandTheWholeOutcomeToBubaly')}</p>
                <Button
                  size="sm"
                  onClick={() => void launchOutcome(selected.outcome.id)}
                  loading={launchForSelected?.status === 'filing'}
                  disabled={launchForSelected?.status === 'filing'}
                >
                  {launchForSelected?.status !== 'filing' && <Sparkles className="h-4 w-4" />}
                  {t('outcomesLauncher.haveBubalyDoIt')}
                </Button>
              </div>
              {/* What the server actually did — never a blanket "working on it".
                  `submitRequest` answers with one of four outcomes and only one
                  of them is work in flight, so each gets the line that is true
                  of it. This mirrors components/modules/handle-it-button.tsx. */}
              {launchForSelected?.status === 'filed' && (() => {
                const report = describeOutcomeLaunch(launchForSelected);
                // A plan on a real run: work IS under way, and there is a page to watch it on.
                if (report.kind === 'working') {
                  return (
                    <p className="mt-2 text-xs text-brand-text">
                      {t('outcomesLauncher.bubalyIsWorkingOnIt')}{' '}
                      <Link href={report.runHref} className="underline underline-offset-2">
                        {t('outcomesLauncher.followTheRun')}
                      </Link>
                    </p>
                  );
                }
                // Parked: the run exists but is waiting on the family. Show the
                // question it is waiting on, and where to answer it.
                if (report.kind === 'question') {
                  return (
                    <p className="mt-2 text-xs text-brand-text">
                      {report.question || t('outcomesLauncher.bubalyNeedsOneMoreDetail')}{' '}
                      {report.runHref && (
                        <Link href={report.runHref} className="underline underline-offset-2">
                          {t('outcomesLauncher.answerTheQuestion')}
                        </Link>
                      )}
                    </p>
                  );
                }
                // Answered or recommended inline: no run row exists, so there is
                // nothing to follow — the reply is the result.
                return <p className="mt-2 text-xs text-brand-text">{report.reply || t('outcomesLauncher.bubalyHadALook')}</p>;
              })()}
              {launchForSelected?.status === 'failed' && (
                <p className="mt-2 flex items-start gap-1.5 text-xs text-danger">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{t('outcomesLauncher.bubalyCouldNotStartThatTryAgain')}</span>
                </p>
              )}
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

import Link from 'next/link';
import { ChevronRight, Circle, CircleCheck, Sparkles, Utensils } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { LocaleCode } from '@/lib/i18n/locales';
import type { HomeBrief } from '@/lib/home/home-brief';
import { formatHomeBrief, type HomeBriefTranslator } from '@/lib/home/home-brief-display';

/** Pure presentation of the existing outcome; the dashboard owns all reads and gates. */
export function HomeOutcomeCard({ homeBrief, locale, t }: {
  homeBrief: HomeBrief; locale: LocaleCode; t: HomeBriefTranslator;
}) {
  const view = formatHomeBrief(homeBrief, { locale, t });
  const numbers = new Intl.NumberFormat(locale);
  const percent = new Intl.NumberFormat(locale, { style: 'percent' });
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-brand/10 to-violet-500/5 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-bold"><Sparkles className="h-4 w-4 shrink-0 text-brand-text" /> {t(homeBrief.isSparse ? 'homeOutcome.firstWins' : 'homeOutcome.week')}</p>
            <p className="mt-1 text-sm text-fg/85">{view.headline}</p>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-2xl font-black leading-none">{percent.format(homeBrief.readinessPct / 100)}</p>
            <p className="text-[10px] uppercase tracking-wide text-muted">{t('homeOutcome.ready')}</p>
          </div>
        </div>
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${homeBrief.readinessPct}%` }} />
        </div>
        {homeBrief.timeSavedMinutes > 0 && (
          <p className="mt-2 text-xs text-muted">{t('aiHomeDashboard.estimatedPlanningTimeNMinThisWeek', { minutes: numbers.format(homeBrief.timeSavedMinutes) })}</p>
        )}
      </div>

      {/* Next best steps — real outcomes, unfinished first */}
      <div className="space-y-2">
        {homeBrief.steps.slice(0, 4).map((s, index) => (
          <Link key={s.id} href={s.href}
            className={cn('flex items-center gap-3 rounded-2xl border p-4 transition hover:bg-elevated',
              s.done ? 'border-border/60 bg-surface/20' : 'border-border bg-surface/40')}>
            {s.done
              ? <CircleCheck className="h-5 w-5 shrink-0 text-emerald-400" />
              : <Circle className="h-5 w-5 shrink-0 text-brand-text" />}
            <div className="min-w-0 flex-1">
              <p className={cn('break-words text-sm font-semibold', s.done && 'text-muted line-through')}>{view.steps[index].label}</p>
              <p className="break-words text-xs text-muted">{view.steps[index].detail}</p>
            </div>
            {!s.done && <ChevronRight className="h-4 w-4 shrink-0 text-brand-text" />}
          </Link>
        ))}
      </div>

      {/* Dinner ideas — value even on a blank week */}
      {homeBrief.dinnerIdeas.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-sm font-semibold"><Utensils className="h-4 w-4 shrink-0 text-brand-text" /> {t('aiHomeDashboard.dinnerIdeasForThisWeek')}</p>
            <Link href="/dashboard/meals" className="text-xs font-semibold text-brand-text hover:underline">{t('aiHomeDashboard.planMeals')}</Link>
          </div>
          <ul className="space-y-1.5 text-sm">
            {homeBrief.dinnerIdeas.map((d) => (
              <li key={d.title} className="flex items-baseline justify-between gap-3">
                <span className="truncate"><span className="font-medium">{d.title}</span> <span className="text-muted">· {d.cuisine}</span></span>
                <span className="shrink-0 text-xs text-muted">{t('onboardingCopy.prepMinutes', { minutes: numbers.format(d.prepMinutes) })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

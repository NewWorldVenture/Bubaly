'use client';

// Experience Scorecard (T8) — makes the premium-consistency sweep measurable.
// Reads dated per-surface audits from Supabase (100% wired + realtime), rolls
// them up via the pure lib/experience/scorecard.ts, and renders the live grade,
// per-dimension health, the trend since the last audit, and the surfaces still
// below the premium bar (worst first) so the sweep runs data-driven, top-down.
import { useMemo } from 'react';
import { Gauge, TrendingUp, TrendingDown, Minus, AlertTriangle, ClipboardCheck } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { PageHeader } from '@/components/app/page-header';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import {
  rollUpScorecard, EXPERIENCE_DIMENSIONS, DIMENSION_KEYS,
  type AuditRecord, type DimensionKey, type Grade,
} from '@/lib/experience/scorecard';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Row = Tables<'experience_audits'>;

const GRADE_TONE: Record<Grade, string> = {
  A: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  B: 'text-lime-400 bg-lime-500/10 border-lime-500/30',
  C: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  D: 'text-orange-400 bg-orange-500/10 border-orange-500/30',
  F: 'text-rose-400 bg-rose-500/10 border-rose-500/30',
};
const barTone = (v: number) => (v >= 90 ? 'bg-emerald-400' : v >= 80 ? 'bg-lime-400' : v >= 70 ? 'bg-amber-400' : v >= 60 ? 'bg-orange-400' : 'bg-rose-400');
const num = (v: number | null): number | undefined => (typeof v === 'number' ? v : undefined);

function Delta({ delta }: { delta: number | null }) {
  if (delta === null) return <span className="text-[11px] text-muted">new</span>;
  if (delta === 0) return <span className="inline-flex items-center gap-0.5 text-[11px] text-muted"><Minus className="h-3 w-3" />0</span>;
  const up = delta > 0;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px]', up ? 'text-emerald-400' : 'text-rose-400')}>
      {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}{up ? '+' : ''}{delta}
    </span>
  );
}

export function ExperienceScorecardModule() {
  const t = useTranslations();
  const { familyId } = useApp();

  const { data, loading, error, refresh } = useRealtimeQuery<Row>({
    table: 'experience_audits', familyId, deps: [familyId],
    // Bound the read: experience_audits accumulates as surfaces are re-audited, but
    // the scorecard only needs recent audits (latest per dimension + "since last
    // audit" trend). Load a rolling 365-day window (hard-capped at 1000 rows).
    fetcher: (sb) => sb.from('experience_audits').select('*').eq('family_id', familyId)
      .gte('audited_on', new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString())
      .order('audited_on', { ascending: false }).limit(1000),
  });

  const card = useMemo(() => {
    const audits: AuditRecord[] = (data ?? []).map((r) => ({
      surfaceKey: r.surface_key,
      surfaceLabel: r.surface_label,
      category: r.category,
      auditedOn: r.audited_on,
      score: r.score ?? 0,
      dimensions: {
        empty_state: num(r.empty_state), error_recovery: num(r.error_recovery),
        transitions: num(r.transitions), performance: num(r.performance),
        accessibility: num(r.accessibility), consistency: num(r.consistency),
      },
    }));
    return rollUpScorecard(audits);
  }, [data]);

  if (loading) return <SkeletonList count={5} />;
  if (error) return <ErrorState message={t('experienceScorecardModule.couldNotLoadTheExperience')} onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('experienceScorecard.experienceScorecard')}
        description={t('experienceScorecardModule.premiumConsistencyMeasuredEverySurface')}
      />

      {card.auditedSurfaces === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={t('experienceScorecard.noAuditsYet')}
          description="Once surfaces are audited, this scorecard grades each one across the six premium dimensions and tracks the trend. Run seed_experience_audits_one_family.sql to populate a baseline."
        />
      ) : (
        <>
          {/* Overall + weakest dimensions */}
          <div className="grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted"><Gauge className="h-4 w-4" /> {t('experienceScorecard.overall')}</div>
              <div className="mt-2 flex items-end gap-3">
                <span className="text-4xl font-bold tabular-nums">{card.overall}</span>
                <span className={cn('mb-1 rounded-lg border px-2 py-0.5 text-sm font-bold', GRADE_TONE[card.overallGrade])}>{card.overallGrade}</span>
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                <span>{t('experienceScorecard.sinceLastAudit')}</span> <Delta delta={card.overallDelta} />
              </div>
              <p className="mt-1 text-xs text-muted">{card.auditedSurfaces} {t('experienceScorecard.surfaces')} {card.needsWorkCount} {t('experienceScorecard.belowTheBar')}</p>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5 md:col-span-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted">{t('experienceScorecard.byDimension')}</div>
              <div className="mt-3 space-y-2.5">
                {card.dimensionAverages.map((d) => (
                  <div key={d.key} className="flex items-center gap-3">
                    <span className="w-28 shrink-0 text-xs text-muted">{d.label}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/10">
                      <div className={cn('h-full rounded-full', barTone(d.average))} style={{ width: `${d.average}%` }} />
                    </div>
                    <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums">{d.count ? d.average : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Weakest-areas callout */}
          {card.needsWorkCount > 0 && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <span>
                <strong>{card.needsWorkCount}</strong> surface{card.needsWorkCount === 1 ? '' : 's'} {t('experienceScorecard.belowThePremiumBarScoreLt')}
                {card.weakestDimensions.length > 0 && <> {t('experienceScorecard.weakestDimensionOverall')} <strong>{EXPERIENCE_DIMENSIONS.find((x) => x.key === card.weakestDimensions[0])?.label}</strong>.</>}
              </span>
            </div>
          )}

          {/* Per-surface table (worst first) */}
          <div className="overflow-x-auto rounded-2xl border border-border">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-border bg-surface/40 text-[11px] uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{t('experienceScorecard.surface')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('experienceScorecard.score')}</th>
                  <th className="px-3 py-2.5 font-medium">{t('experienceScorecard.trend')}</th>
                  {DIMENSION_KEYS.map((k) => (
                    <th key={k} className="px-2 py-2.5 text-center font-medium" title={EXPERIENCE_DIMENSIONS.find((d) => d.key === k)?.label}>
                      {EXPERIENCE_DIMENSIONS.find((d) => d.key === k)?.label.slice(0, 4)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {card.surfaces.map((s) => (
                  <tr key={s.surfaceKey} className={cn('border-b border-border/60 last:border-0', s.needsWork && 'bg-rose-500/[0.03]')}>
                    <td className="px-4 py-2.5">
                      <span className="font-medium">{s.surfaceLabel}</span>
                      <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase text-muted">{s.category}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={cn('rounded-lg border px-2 py-0.5 text-xs font-bold', GRADE_TONE[s.grade])}>{s.score} · {s.grade}</span>
                    </td>
                    <td className="px-3 py-2.5"><Delta delta={s.delta} /></td>
                    {DIMENSION_KEYS.map((k: DimensionKey) => {
                      const v = s.dimensions[k];
                      return (
                        <td key={k} className="px-2 py-2.5 text-center tabular-nums">
                          {typeof v === 'number' ? <span className={cn(v < 70 && 'text-rose-400', v >= 90 && 'text-emerald-400')}>{v}</span> : <span className="text-muted">—</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

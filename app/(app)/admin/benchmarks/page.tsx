import type { Metadata } from 'next';
import Link from 'next/link';
import { Download, ExternalLink, Globe, Lock, Radar, ShieldCheck, Users } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';
import { readBenchmarkAggregates, readBenchmarksPublication } from '@/lib/network/benchmarks-server';
import { groupBenchmarks, type BenchmarkRow } from '@/lib/network/benchmarks';
import { AGG_DEFAULTS } from '@/lib/network/aggregate';
import { K_ANONYMITY_FLOOR } from '@/lib/network/insights';
import { fmtDate } from '@/lib/utils/format';
import { setBenchmarksPublicationAction } from './actions';

export const metadata: Metadata = { title: 'Household Benchmarks', robots: { index: false } };
export const dynamic = 'force-dynamic';

// The research half of the Intelligence Network, for the site admin: every
// published aggregate, metric × cohort, with the distinct-family count (n) and
// the k-anonymity floor visible on the page — so what gets quoted in content
// can be checked against the guarantee it was made under. Service-role read:
// network_aggregates is RLS-gated to consenting families, and the admin
// console is not one. Rows are already k-anonymized and DP-noised.
export default async function AdminBenchmarksPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const [publication, aggregates, contributorsResult, optedInResult] = await Promise.all([
    readBenchmarksPublication(supabase),
    readBenchmarkAggregates(supabase),
    supabase.from('network_contributions').select('family_id', { count: 'exact', head: true }),
    supabase.from('network_consent').select('family_id', { count: 'exact', head: true }).eq('enabled', true),
  ]);
  if (contributorsResult.error) console.error('[admin-benchmarks] contributor count read failed', contributorsResult.error);
  if (optedInResult.error) console.error('[admin-benchmarks] consent count read failed', optedInResult.error);
  if (!publication.ok || !aggregates.ok || contributorsResult.error || optedInResult.error) {
    return <AdminBenchmarksReadError />;
  }

  const groups = groupBenchmarks(aggregates.aggregates);
  const publishedRows = groups.reduce((n, g) => n + g.rows.length, 0);
  const contributors = contributorsResult.count ?? 0;
  const optedIn = optedInResult.count ?? 0;

  const stats = [
    { icon: Users, label: t('adminBenchmarks.contributingFamilies'), value: contributors.toLocaleString(), tint: 'text-violet-400 bg-violet-500/15' },
    { icon: ShieldCheck, label: t('adminBenchmarks.optedIn'), value: optedIn.toLocaleString(), tint: 'text-emerald-400 bg-emerald-500/15' },
    { icon: Radar, label: t('adminBenchmarks.publishedRows'), value: publishedRows.toLocaleString(), tint: 'text-blue-400 bg-blue-500/15' },
    { icon: Lock, label: t('adminBenchmarks.kAnonymityFloor'), value: `k ≥ ${K_ANONYMITY_FLOOR}`, tint: 'text-amber-400 bg-amber-500/15' },
    { icon: Globe, label: t('adminBenchmarks.launchGate'), value: `≥ ${AGG_DEFAULTS.globalMinFamilies}`, tint: 'text-rose-400 bg-rose-500/15' },
  ];

  return (
    <div className="module-page space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminBenchmarks.householdBenchmarks')}</h1>
        <p className="mt-1 text-sm text-muted">{t('adminBenchmarks.description', { floor: K_ANONYMITY_FLOOR })}</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {stats.map((s) => (
          <Card key={s.label} className="flex flex-col gap-3">
            <div className={`inline-flex h-10 w-10 items-center justify-center rounded-xl ${s.tint}`}><s.icon className="h-5 w-5" /></div>
            <div>
              <p className="text-xl font-bold leading-none">{s.value}</p>
              <p className="mt-1 text-xs text-muted">{s.label}</p>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <h2 className="mb-1 text-base font-semibold">{t('adminBenchmarks.publicPage')}</h2>
          <p className="mb-3 text-xs text-muted">{t('adminBenchmarks.publicPageDescription')}</p>
          <div className="flex flex-wrap items-center gap-3">
            <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${publication.published ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-border bg-surface/60 text-muted'}`}>
              {publication.published ? <Globe className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              {publication.published ? t('adminBenchmarks.published') : t('adminBenchmarks.unpublished')}
            </span>
            <form action={setBenchmarksPublicationAction}>
              <input type="hidden" name="published" value={publication.published ? 'false' : 'true'} />
              <button type="submit" className="h-9 rounded-xl border border-border px-4 text-sm font-medium hover:bg-elevated">
                {publication.published ? t('adminBenchmarks.unpublish') : t('adminBenchmarks.publish')}
              </button>
            </form>
            {publication.published && (
              <Link href="/resources/benchmarks" className="inline-flex items-center gap-1 text-sm font-medium text-brand-text underline">
                {t('adminBenchmarks.viewPublicPage')} <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            )}
          </div>
          {publication.updatedAt && (
            <p className="mt-3 text-xs text-muted">{t('adminBenchmarks.publicationUpdated', { date: fmtDate(publication.updatedAt) })}</p>
          )}
        </Card>
        <Card>
          <h2 className="mb-1 text-base font-semibold">{t('adminBenchmarks.exportCsv')}</h2>
          <p className="mb-3 text-xs text-muted">{t('adminBenchmarks.exportHint')}</p>
          <a
            href="/api/admin/benchmarks/export"
            className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-4 text-sm font-medium hover:bg-elevated"
          >
            <Download className="h-4 w-4" /> {t('adminBenchmarks.exportCsv')}
          </a>
          <p className="mt-3 text-xs text-muted">
            {aggregates.computedAt
              ? t('adminBenchmarks.lastComputed', { date: fmtDate(aggregates.computedAt) })
              : t('adminBenchmarks.neverComputed')}
          </p>
        </Card>
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={Radar}
          title={t('adminBenchmarks.noRowsTitle')}
          description={t('adminBenchmarks.noRowsDescription', { gate: AGG_DEFAULTS.globalMinFamilies, floor: K_ANONYMITY_FLOOR })}
        />
      ) : (
        groups.map((g) => (
          <Card key={g.metric}>
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-base font-semibold capitalize">{g.labelKey ? t(g.labelKey) : g.label}</h2>
              <p className="text-xs text-muted">
                {t('adminBenchmarks.cohortsCount', { count: g.cohorts })} · {t('adminBenchmarks.kAnonymityFloor')} k ≥ {K_ANONYMITY_FLOOR}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted">
                    <th className="py-2 pr-4">{t('adminBenchmarks.cohort')}</th>
                    <th className="py-2 pr-4">{t('adminBenchmarks.value')}</th>
                    <th className="py-2 pr-4 text-right">{t('adminBenchmarks.familiesReported')}</th>
                    <th className="py-2 text-right">{t('adminBenchmarks.cohortN')}</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={`${r.cohortKey}|${r.value}`} className="border-t border-border">
                      <td className="py-2 pr-4">{cohortLabel(r, t)}</td>
                      <td className="py-2 pr-4 font-medium">{r.value}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{r.count.toLocaleString()}</td>
                      <td className="py-2 text-right tabular-nums">{r.cohortSize.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))
      )}
    </div>
  );
}

function cohortLabel(row: BenchmarkRow, t: (key: string, params?: Record<string, string | number>) => string): string {
  const kids = row.childBands.length
    ? t('adminBenchmarks.kidsBands', { bands: row.childBands.join(', ') })
    : t('adminBenchmarks.noKids');
  return `${kids} · ${t('adminBenchmarks.householdOf', { size: row.sizeBand })}`;
}

async function AdminBenchmarksReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('adminBenchmarks.householdBenchmarks')}</h1>
        <p className="mt-1 text-sm text-muted">{t('adminBenchmarks.description', { floor: K_ANONYMITY_FLOOR })}</p>
      </div>
      <ErrorState message={t('adminBenchmarks.couldNotLoad')} />
      <a href="/admin/benchmarks" className="text-sm font-medium text-brand-text underline">{t('adminBenchmarks.refresh')}</a>
    </div>
  );
}

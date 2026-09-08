import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Lock, ShieldCheck, Users, Radar } from 'lucide-react';
import { Section, SectionHeading } from '@/components/marketing/sections';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';
import { CTASection } from '@/components/marketing/cta';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readBenchmarkAggregates, readBenchmarksPublication } from '@/lib/network/benchmarks-server';
import { benchmarkRows, groupBenchmarks } from '@/lib/network/benchmarks';
import { aggregatesToInsights, AGG_DEFAULTS } from '@/lib/network/aggregate';
import { bandFamilyLabel } from '@/lib/network/contribution';
import { K_ANONYMITY_FLOOR, isSuppressed } from '@/lib/network/insights';
import { fmtDate } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

const PATH = '/resources/benchmarks';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata(PATH, {
    title: t('benchmarksPage.metaTitle'),
    description: t('benchmarksPage.metaDescription', { floor: K_ANONYMITY_FLOOR }),
  });
}

// Public research page. Renders ONLY rows that the nightly aggregation already
// made safe (k-anonymity + DP noise + launch gate), re-checks the floor here,
// and exists only while the admin publication flag is on — otherwise 404, so
// an unpublished page is indistinguishable from one that never existed. The
// service-role read is deliberate: network_aggregates is RLS-gated to
// consenting families and this page has no viewer to gate on.
export default async function BenchmarksPage() {
  const t = await getTranslations();
  const configured = !!process.env.NEXT_PUBLIC_SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!configured) notFound();

  const supabase = createServiceClient();
  const publication = await readBenchmarksPublication(supabase);
  if (!publication.ok) return <BenchmarksReadError />;
  if (!publication.published) notFound();

  const read = await readBenchmarkAggregates(supabase);
  if (!read.ok) return <BenchmarksReadError />;

  // No cohort filter: every published row. Then the same gate a family's own
  // view passes through (isSuppressed), as defense in depth — a row under the
  // floor never renders, whatever the table says.
  const candidates = aggregatesToInsights(read.aggregates, null).filter((c) => !isSuppressed(c.cohortSize));
  const safeIds = new Set(candidates.map((c) => c.id));
  const groups = groupBenchmarks(read.aggregates)
    .map((g) => ({ ...g, rows: g.rows.filter((r) => safeIds.has(`${r.cohortKey}:${r.metric}:${r.value}`)) }))
    .filter((g) => g.rows.length > 0);
  const totalRows = benchmarkRows(read.aggregates).length;

  const methodology = [
    { icon: ShieldCheck, text: t('benchmarksPage.methodologyConsent') },
    { icon: Lock, text: t('benchmarksPage.methodologyBands') },
    { icon: Users, text: t('benchmarksPage.methodologyFloor', { floor: K_ANONYMITY_FLOOR, gate: AGG_DEFAULTS.globalMinFamilies }) },
    { icon: Radar, text: t('benchmarksPage.methodologyNoise') },
    { icon: Users, text: t('benchmarksPage.methodologyCohort') },
  ];

  return (
    <>
      <Section className="pt-20 text-center">
        <SectionHeading eyebrow={t('benchmarksPage.eyebrow')} title={t('benchmarksPage.title')} description={t('benchmarksPage.description')} />
        <p className="mx-auto mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-surface/60 px-4 py-2 text-sm text-muted">
          <ShieldCheck className="h-4 w-4 text-emerald-400" /> {t('benchmarksPage.aggregatedNotice')}
        </p>
        {read.computedAt && (
          <p className="mt-3 text-xs text-muted">{t('benchmarksPage.lastUpdated', { date: fmtDate(read.computedAt, 'MMM d, yyyy') })}</p>
        )}
      </Section>

      {groups.length === 0 || totalRows === 0 ? (
        <Section className="pt-0">
          <div className="mx-auto max-w-2xl rounded-2xl border border-dashed border-border px-6 py-14 text-center">
            <Radar className="mx-auto mb-4 h-8 w-8 text-muted" />
            <h2 className="text-xl font-semibold">{t('benchmarksPage.emptyTitle')}</h2>
            <p className="mt-2 text-sm text-muted">{t('benchmarksPage.emptyDescription', { gate: AGG_DEFAULTS.globalMinFamilies, floor: K_ANONYMITY_FLOOR })}</p>
          </div>
        </Section>
      ) : (
        <Section className="pt-0">
          <div className="grid gap-6 lg:grid-cols-2">
            {groups.map((g) => (
              <div key={g.metric} className="glass-card p-6">
                <h2 className="text-lg font-semibold capitalize">{g.labelKey ? t(g.labelKey) : g.label}</h2>
                {g.metric === 'weekly_spend_band' && <p className="mt-1 text-xs text-muted">{t('benchmarksPage.currencyNote')}</p>}
                <ul className="mt-4 divide-y divide-border">
                  {g.rows.map((r) => (
                    <li key={`${r.cohortKey}|${r.value}`} className="py-3">
                      <p className="text-sm font-medium">
                        {/* The BAND is a word this sentence is built around, so it is
                            translated like the sentence. `r.value` stays the stored
                            English band and is never what a reader sees. */}
                        {t('benchmarksPage.aboutFamiliesReport', { count: r.count, value: r.valueKey ? t(r.valueKey) : r.value })}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        {r.childBands.length
                          ? t('benchmarksPage.familiesWithKids', { bands: r.childBands.map((b) => bandFamilyLabel('age', b, t)).join(', ') })
                          : t('benchmarksPage.familiesWithoutKids')}
                        {' · '}{t('benchmarksPage.householdOf', { size: bandFamilyLabel('size', r.sizeBand, t) })}
                        {' · '}{t('benchmarksPage.cohortOf', { n: r.cohortSize })}
                      </p>
                      <p className="mt-1 text-[11px] text-muted">{t('benchmarksPage.aggregatedNotice')}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section className="pt-0">
        <SectionHeading title={t('benchmarksPage.methodologyTitle')} align="left" />
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {methodology.map((m, i) => (
            <li key={i} className="flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-4 text-sm text-muted">
              <m.icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-text" /> <span>{m.text}</span>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-sm text-muted">
          <Link href="/security" className="font-medium text-brand-text underline">{t('benchmarksPage.readSecurity')}</Link>
        </p>
      </Section>

      <MarketingAeoSection path={PATH} name={t('benchmarksPage.eyebrow')} description={t('benchmarksPage.description')} />
      <CTASection title={t('benchmarksPage.ctaTitle')} subtitle={t('benchmarksPage.ctaSubtitle')} />
    </>
  );
}

async function BenchmarksReadError() {
  const t = await getTranslations();
  return (
    <Section className="pt-20">
      <div className="mx-auto max-w-xl rounded-2xl border border-danger/30 bg-danger/5 px-5 py-8 text-center">
        <p className="text-sm text-danger">{t('benchmarksPage.couldNotLoad')}</p>
        <a href={PATH} className="mt-3 inline-block text-sm font-medium underline">{t('benchmarksPage.retry')}</a>
      </div>
    </Section>
  );
}

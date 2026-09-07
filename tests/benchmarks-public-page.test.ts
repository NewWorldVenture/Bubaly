import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { expectSays, expectTranslates } from './helpers/translated';
import {
  benchmarkRows, benchmarksCsv, groupBenchmarks, isBenchmarksPublished, BENCHMARKS_PUBLICATION_KEY, BENCHMARK_CSV_COLUMNS,
} from '@/lib/network/benchmarks';
import type { NetworkAggregate } from '@/lib/network/aggregate';
import { K_ANONYMITY_FLOOR } from '@/lib/network/insights';

const publicPage = readFileSync('app/(marketing)/resources/benchmarks/page.tsx', 'utf8');
const adminPage = readFileSync('app/(app)/admin/benchmarks/page.tsx', 'utf8');
const adminActions = readFileSync('app/(app)/admin/benchmarks/actions.ts', 'utf8');
const exportRoute = readFileSync('app/api/admin/benchmarks/export/route.ts', 'utf8');
const middleware = readFileSync('middleware.ts', 'utf8');
const sitemap = readFileSync('app/sitemap.ts', 'utf8');
const serverReads = readFileSync('lib/network/benchmarks-server.ts', 'utf8');
const intelligenceModule = readFileSync('components/modules/intelligence-module.tsx', 'utf8');
const intelligencePage = readFileSync('app/(app)/dashboard/intelligence/page.tsx', 'utf8');

const agg = (metric: string, value: string, cohortSize: number, count = cohortSize, cohortKey = 'kids:6–9|size:3–4', scope: NetworkAggregate['scope'] = 'benchmarks'): NetworkAggregate =>
  ({ scope, cohortKey, metric, value, count, cohortSize });

describe('publication flag', () => {
  it('is on only for the explicit enabled shape', () => {
    expect(isBenchmarksPublished({ enabled: true })).toBe(true);
    expect(isBenchmarksPublished({ enabled: 'true' })).toBe(false);
    expect(isBenchmarksPublished({ text: 'true' })).toBe(false);
    expect(isBenchmarksPublished(null)).toBe(false);
    expect(isBenchmarksPublished([])).toBe(false);
    expect(BENCHMARKS_PUBLICATION_KEY).toBe('benchmarks_public');
  });
});

describe('benchmark rows are k-anonymized whatever the table says', () => {
  const rows = [
    agg('dinner_habit', 'often (4–5)', 120, 123),
    agg('dinner_habit', 'rarely (0–1)', K_ANONYMITY_FLOOR - 1, 25),   // under the floor
    agg('activities', '1–2', 60, 0),                                   // noised to zero
    agg('activities', '1–2', 60, 61, 'not-a-cohort-key'),              // unparseable cohort
    agg('dinner_habit', 'often (4–5)', 80, 79, 'kids:none|size:1–2', 'timing'), // another scope
    agg('weekly_spend_band', '1,000+', 40, 41, 'kids:none|size:1–2'),
  ];

  it('drops under-floor, zero-count, unparseable and off-scope rows and describes the rest', () => {
    const safe = benchmarkRows(rows);
    expect(safe.map((r) => `${r.metric}:${r.value}:${r.cohortSize}`)).toEqual([
      'dinner_habit:often (4–5):120',
      'weekly_spend_band:1,000+:40',
    ]);
    expect(safe[0]).toMatchObject({
      childBands: ['6–9'], sizeBand: '3–4', label: 'dinner planning',
      labelKey: 'network.metricDinnerPlanning', valueKey: 'network.bandDinnerOften',
    });
    expect(safe[1]).toMatchObject({ childBands: [], sizeBand: '1–2' });
  });

  it('groups per metric in catalogue order with a cohort count', () => {
    const groups = groupBenchmarks(rows);
    expect(groups.map((g) => g.metric)).toEqual(['dinner_habit', 'weekly_spend_band']);
    expect(groups[0].cohorts).toBe(1);
    expect(groups[0].rows[0].count).toBe(123);
  });

  it('exports the noised count and n — never a family, never a raw value — and escapes commas', () => {
    const csv = benchmarksCsv(rows, '2026-09-07T03:00:00.000Z');
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(BENCHMARK_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('dinner_habit,dinner planning,kids:6–9|size:3–4,6–9,3–4,often (4–5),123,120,20,2026-09-07T03:00:00.000Z');
    expect(lines[2]).toContain('"1,000+"'); // the value carries a comma and is quoted
    expect(csv).not.toContain('rarely');
    expect(csv).not.toContain('family_id');
  });
});

describe('/resources/benchmarks — the public page', () => {
  it('404s while unpublished and renders only k-anonymized rows without a cohort filter', () => {
    expect(publicPage).toContain("import { notFound } from 'next/navigation'");
    expect(publicPage).toContain('if (!publication.published) notFound();');
    expect(publicPage).toContain('aggregatesToInsights(read.aggregates, null)');
    expect(publicPage).toContain('.filter((c) => !isSuppressed(c.cohortSize))');
    expect(publicPage).toContain("export const dynamic = 'force-dynamic'");
  });

  it('reads the flag and the aggregates through the service-role helpers, which floor every row', () => {
    expect(publicPage).toContain('readBenchmarksPublication(supabase)');
    expect(publicPage).toContain('readBenchmarkAggregates(supabase)');
    expect(serverReads).toContain(".eq('key', BENCHMARKS_PUBLICATION_KEY)");
    expect(serverReads).toContain(".eq('scope', 'benchmarks')");
    expect(serverReads).toContain('.gte(\'cohort_size\', K_ANONYMITY_FLOOR)');
  });

  it('fails closed on a read error — never an empty benchmark page', () => {
    expect(publicPage).toContain('if (!publication.ok) return <BenchmarksReadError />;');
    expect(publicPage).toContain('if (!read.ok) return <BenchmarksReadError />;');
    expect(serverReads).toContain("console.error('[benchmarks] publication flag read failed', error)");
    expect(serverReads).toContain("console.error('[benchmarks] aggregate read failed', error)");
    expectSays(publicPage, 'benchmarksPage.couldNotLoad', 'Could not load the benchmarks. Refresh and try again.');
    expectSays(publicPage, 'benchmarksPage.retry', 'Retry');
  });

  it('carries the cohort size and the anonymity sentence with every number', () => {
    expectSays(publicPage, 'benchmarksPage.aggregatedNotice', 'Aggregated from consenting families; no family is identifiable.');
    expectSays(publicPage, 'benchmarksPage.cohortOf', 'cohort of {n} families');
    expectSays(publicPage, 'benchmarksPage.aboutFamiliesReport', 'About {count} families report “{value}”');
    // the per-row block renders count, cohort n and the sentence together
    const row = publicPage.slice(publicPage.indexOf('{g.rows.map((r) =>'), publicPage.indexOf('</li>'));
    // the band inside the sentence is a catalogue key, not the stored English band
    expect(row).toContain("t('benchmarksPage.aboutFamiliesReport', { count: r.count, value: r.valueKey ? t(r.valueKey) : r.value })");
    expect(row).toContain("t('benchmarksPage.cohortOf', { n: r.cohortSize })");
    expect(row).toContain("t('benchmarksPage.aggregatedNotice')");
  });

  it('meets the marketing route contract and is registered as a public route', () => {
    expect(publicPage).toMatch(/generateMetadata/);
    expect(publicPage).toContain('MarketingAeoSection');
    expect(middleware).toContain("'/resources/benchmarks'");
  });

  it('is in the sitemap only while published', () => {
    expect(sitemap).toContain("import { readBenchmarksPublication } from '@/lib/network/benchmarks-server'");
    expect(sitemap).toContain('if (benchmarks.ok && benchmarks.published) {');
    expect(sitemap).toContain('`${SITE_URL}/resources/benchmarks`');
    expect(sitemap).toContain('...benchmarkEntries');
  });

  it('is linked from the intelligence module, not from the shared sidebar', () => {
    expect(intelligenceModule).toContain('href="/resources/benchmarks"');
    expectSays(intelligenceModule, 'intelligence.seePublicBenchmarks', 'See the public benchmarks');
    const nav = readFileSync('lib/constants/navigation.ts', 'utf8');
    expect(nav).not.toContain('/resources/benchmarks');
  });

  // The card says the rows are "published for everyone at /resources/benchmarks".
  // That page 404s unless the marketing_settings flag is on, and no migration or
  // seed creates that row — so the DEFAULT state of every environment is
  // unpublished. An unconditional card is therefore an inert control and a claim
  // with nothing persisted behind it. The flag has to be read, server-side.
  it('the public-benchmarks card is gated on the publication flag, read server-side', () => {
    expect(intelligencePage).toContain("import { benchmarksPageIsPublished } from '@/lib/network/benchmarks-server'");
    expect(intelligencePage).toContain('const benchmarksPublished = await benchmarksPageIsPublished();');
    expect(intelligencePage).toContain('benchmarksPublished={benchmarksPublished}');
    expect(intelligenceModule).toContain('benchmarksPublished = false');
    expect(intelligenceModule).toContain('{benchmarksPublished && (');
    // the link and the claim live INSIDE that guard
    const guarded = intelligenceModule.slice(intelligenceModule.indexOf('{benchmarksPublished && ('));
    expect(guarded).toContain('href="/resources/benchmarks"');
    expect(guarded).toContain("t('intelligence.publicBenchmarksHint')");
  });

  it('the flag helper fails closed — an unreadable flag hides the card, it does not show it', () => {
    expect(serverReads).toContain('export async function benchmarksPageIsPublished(): Promise<boolean>');
    expect(serverReads).toContain('if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return false;');
    expect(serverReads).toContain('return read.ok && read.published;');
    // a rejection (transport failure) is caught and answered "not published"
    expect(serverReads).toMatch(/catch \(cause\) \{\s*console\.error\('\[benchmarks\] publication flag read failed', cause\);\s*return false;/);
  });
});

describe('/admin/benchmarks — the report behind the admin gate', () => {
  it('reads with the service role, shows n and the floor, and fails closed', () => {
    expect(adminPage).toContain('createServiceClient()');
    expect(adminPage).toContain('readBenchmarkAggregates(supabase)');
    expect(adminPage).toContain('K_ANONYMITY_FLOOR');
    expectSays(adminPage, 'adminBenchmarks.cohortN', 'n (distinct families)');
    expectSays(adminPage, 'adminBenchmarks.kAnonymityFloor', 'k-anonymity floor');
    expect(adminPage).toContain("console.error('[admin-benchmarks] contributor count read failed'");
    expect(adminPage).toContain('return <AdminBenchmarksReadError />;');
    expectSays(adminPage, 'adminBenchmarks.couldNotLoad', 'Could not load household benchmarks from Supabase. Refresh and try again.');
    expect(adminPage).toContain('<ErrorState message=');
    expect(adminPage).toMatch(/robots:\s*\{\s*index:\s*false/);
  });

  it('the publication action re-verifies super-admin and audits the change', () => {
    expect(adminActions).toContain("'use server'");
    expect(adminActions).toContain('await requireMarketingAdmin()');
    expect(adminActions).toContain("from('marketing_settings')");
    expect(adminActions).toContain('key: BENCHMARKS_PUBLICATION_KEY');
    expect(adminActions).toContain('await logMarketingAudit(supabase');
    expect(adminActions).toContain("revalidatePath('/resources/benchmarks')");
    expect(adminActions).toContain("revalidatePath('/sitemap.xml')");
  });

  it('the CSV export is a route handler under the same gate, with no client-side secrets', () => {
    expect(adminPage).toContain('href="/api/admin/benchmarks/export"');
    expect(exportRoute).toContain('const user = await getUser();');
    expect(exportRoute).toContain('if (!user) return NextResponse.json');
    expect(exportRoute).toContain('if (!(await isSuperAdmin())) return NextResponse.json');
    expect(exportRoute).toContain("'Content-Type': 'text/csv; charset=utf-8'");
    expect(exportRoute).toContain('attachment; filename="household-benchmarks-');
    expect(exportRoute).toContain('benchmarksCsv(read.aggregates, computedAt)');
    expect(exportRoute).toContain('if (!read.ok) return NextResponse.json');
    expectTranslates(exportRoute, 'benchmarksExport.notAuthorized', 'Only a site administrator can export benchmarks.');
    expectTranslates(exportRoute, 'benchmarksExport.readFailed', 'Could not read the benchmark aggregates.');
  });
});

describe('the consent preview reads the same sources as the cron and fails closed', () => {
  it('feeds the four new inputs from the household’s own rows', () => {
    for (const table of ['chore_assignments', 'bedtime_routines', 'transactions', 'reminders']) {
      expect(intelligencePage).toContain(`from('${table}')`);
    }
    expect(intelligencePage).toContain('childCount: childIds.size');
    expect(intelligencePage).toContain('typicalWeeklySpend(');
  });

  it('renders a retryable error instead of an empty preview when a read fails', () => {
    expect(intelligencePage).toContain("console.error('[intelligence] contribution preview read failed', previewError)");
    expect(intelligencePage).toContain("console.error('[intelligence] network aggregate read failed', aggError)");
    expect(intelligencePage).toContain('return <IntelligenceReadError />;');
    expectSays(intelligencePage, 'intelligence.couldNotLoadContributionPreview', 'Could not load your contribution preview from Supabase. Refresh and try again.');
    expect(intelligencePage).not.toContain('error ? 0 :'); // the old safeCount-style swallow is gone
  });
});

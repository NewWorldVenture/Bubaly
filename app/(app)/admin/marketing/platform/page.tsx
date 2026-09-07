import type { Metadata } from 'next';
import Link from 'next/link';
import { Activity, Bot, FileText, Layers3, Plus, RefreshCw, Sparkles, WandSparkles } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { PAGE_TYPES } from '@/lib/marketing/platform';
import { archivePlatformPage, createPlatformPage, retryMarketingJob, saveMarketingBrandRule, saveMarketingTemplate, updatePlatformPage } from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · Platform', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-lg border border-border bg-surface/60 px-3 text-sm focus-ring';
const areaCls = 'w-full rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm focus-ring';

export default async function MarketingPlatformPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const providerNames = ['google_search_console', 'bing_webmaster', 'ai_citation'] as const;
  const jobStatuses = ['queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled'] as const;
  const embeddingStatuses = ['ready', 'queued', 'failed', 'stale'] as const;
  const staleWorkerCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const [pagesResult, templatesResult, rulesResult, jobsResult, syncResult] = await Promise.all([
    supabase.from('marketing_pages').select('*').is('deleted_at', null).order('updated_at', { ascending: false }).limit(40),
    supabase.from('marketing_content_templates').select('*').neq('status', 'archived').order('page_type').order('name'),
    supabase.from('marketing_brand_rules').select('*').order('name'),
    supabase.from('marketing_generation_jobs').select('*').order('created_at', { ascending: false }).limit(30),
    supabase.from('marketing_provider_syncs').select('*').order('provider'),
  ]);
  const [jobCountResults, staleJobsResult, latestSuccessResult, observationStats, embeddingCountResults] = await Promise.all([
    Promise.all(jobStatuses.map(async (status) => ({
      status,
      result: await supabase.from('marketing_generation_jobs').select('id', { count: 'exact', head: true }).eq('status', status),
    }))),
    supabase.from('marketing_generation_jobs').select('id', { count: 'exact', head: true }).eq('status', 'running').lt('locked_at', staleWorkerCutoff),
    supabase.from('marketing_generation_jobs').select('job_type, target_path, completed_at').eq('status', 'succeeded').order('completed_at', { ascending: false }).limit(1).maybeSingle(),
    Promise.all(providerNames.map(async (provider) => {
      const [countResult, latestResult] = await Promise.all([
        supabase.from('marketing_provider_observations').select('id', { count: 'exact', head: true }).eq('provider', provider),
        supabase.from('marketing_provider_observations').select('observed_for, source_status').eq('provider', provider).order('observed_for', { ascending: false }).limit(1).maybeSingle(),
      ]);
      return { provider, countResult, latestResult };
    })),
    Promise.all(embeddingStatuses.map(async (status) => ({
      status,
      result: await supabase.from('marketing_embeddings').select('id', { count: 'exact', head: true }).eq('status', status),
    }))),
  ]);
  const error = pagesResult.error ?? templatesResult.error ?? rulesResult.error ?? jobsResult.error ?? syncResult.error;
  const observationError = observationStats.find(({ countResult, latestResult }) => countResult.error ?? latestResult.error);
  const embeddingError = embeddingCountResults.find(({ result }) => result.error)?.result.error;
  const operationsError = jobCountResults.find(({ result }) => result.error)?.result.error
    ?? staleJobsResult.error
    ?? latestSuccessResult.error
    ?? observationError?.countResult.error
    ?? observationError?.latestResult.error
    ?? embeddingError;
  if (error || operationsError) return <ErrorState message={t('platform.couldNotLoadTheMarketing')} />;
  const pages = pagesResult.data ?? [];
  const templates = templatesResult.data ?? [];
  const rules = rulesResult.data ?? [];
  const jobs = jobsResult.data ?? [];
  const syncs = syncResult.data ?? [];
  const jobCounts = Object.fromEntries(jobCountResults.map(({ status, result }) => [status, result.count ?? 0])) as Record<(typeof jobStatuses)[number], number>;
  const activeJobs = jobCounts.queued + jobCounts.running;
  const failed = jobCounts.failed + jobCounts.dead_letter;
  const staleJobs = staleJobsResult.count ?? 0;
  const latestSuccess = latestSuccessResult.data;
  const observationByProvider = new Map(observationStats.map(({ provider, countResult, latestResult }) => [provider, {
    count: countResult.count ?? 0,
    latest: latestResult.data?.observed_for ?? null,
    latestStatus: latestResult.data?.source_status ?? null,
  }]));
  const embeddingCounts = Object.fromEntries(embeddingCountResults.map(({ status, result }) => [status, result.count ?? 0])) as Record<(typeof embeddingStatuses)[number], number>;
  const published = pages.filter((page) => page.status === 'published').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-brand-text">{t('adminMarketingPlatform.marketingOperatingSystem')}</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">{t('adminMarketingPlatform.pagesRulesAndAutomation')}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">{t('platform.everyPlatformPageIsVersioned')}</p>
        </div>
        <Link href="#new-page" className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90"><Plus className="h-4 w-4" /> {t('adminMarketingPlatform.newPage')}</Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Metric icon={FileText} label={t('adminMarketingPlatform.pages')} value={pages.length} />
        <Metric icon={Sparkles} label={t('adminMarketingPlatform.published')} value={published} />
        <Metric icon={Layers3} label={t('adminMarketingPlatform.templates')} value={templates.length} />
        <Metric icon={Activity} label={t('adminMarketingPlatform.jobsActive')} value={activeJobs} />
        <Metric icon={RefreshCw} label={t('adminMarketingPlatform.jobsNeedingReview')} value={failed} />
        <Metric icon={Layers3} label={t('adminMarketingPlatform.vectorChunksReady')} value={embeddingCounts.ready} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <Card>
          <div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold">{t('adminMarketingPlatform.pageRegistry')}</h3><p className="text-xs text-muted">{t('adminMarketingPlatform.theCanonicalPublicPageInventory')}</p></div><Badge tone="neutral">{pages.length} loaded</Badge></div>
          {pages.length === 0 ? <EmptyState icon={FileText} title={t('adminMarketingPlatform.noPlatformPagesYet')} description={t('platform.createTheFirstPageAnd')} /> : (
            <div className="space-y-3">{pages.map((page) => <PageEditor key={page.id} page={page} />)}</div>
          )}
        </Card>

        <div className="space-y-5">
          <Card id="new-page">
            <h3 className="font-semibold">{t('adminMarketingPlatform.createPage')}</h3><p className="mt-1 text-xs text-muted">{t('adminMarketingPlatform.theFirstSaveCreatesAQueued')}</p>
            <form action={createPlatformPage} className="mt-4 space-y-3">
              <select name="page_type" className={inputCls} defaultValue="guide">{PAGE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label} ({type.prefix})</option>)}</select>
              <input name="title" required placeholder={t('adminMarketingPlatform.title')} className={inputCls} />
              <input name="slug" placeholder={t('adminMarketingPlatform.slugAutoFromTitle')} className={inputCls} />
              <input name="summary" placeholder={t('adminMarketingPlatform.oneSentencePromise')} className={inputCls} />
              <textarea name="body" rows={4} placeholder={t('adminMarketingPlatform.sourceFactsOrEditorialBrief')} className={areaCls} />
              <button className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand/90"><WandSparkles className="h-4 w-4" /> {t('adminMarketingPlatform.createAndQueue')}</button>
            </form>
          </Card>

          <Card>
            <div className="mb-3 flex items-center gap-2"><Bot className="h-4 w-4 text-brand-text" /><h3 className="font-semibold">{t('adminMarketingPlatform.providerSyncHealth')}</h3></div>
            <p className="mb-3 text-xs text-muted">{t('adminMarketingPlatform.providerStatusIsLiveFromSupabase')}</p>
            <div className="space-y-2">{syncs.map((sync) => {
              const observation = observationByProvider.get(sync.provider as typeof providerNames[number]);
              return <div key={sync.provider} className="rounded-lg border border-border px-3 py-2 text-sm">
                <div className="flex items-center justify-between gap-3"><span className="capitalize">{sync.provider.replaceAll('_', ' ')}</span><Badge tone={sync.status === 'connected' ? 'success' : sync.status === 'error' || sync.status === 'degraded' ? 'danger' : 'neutral'}>{sync.status.replaceAll('_', ' ')}</Badge></div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted"><span>{observation?.count.toLocaleString() ?? '0'} observations</span><span>Latest: {observation?.latest ?? 'none'}</span>{sync.last_completed_at ? <span>Synced: {formatTimestamp(sync.last_completed_at)}</span> : null}</div>
                {sync.last_error ? <p className="mt-1 text-xs text-danger">{sync.last_error}</p> : null}
              </div>;
            })}</div>
          </Card>

          <Card>
            <div className="mb-3 flex items-center gap-2"><Layers3 className="h-4 w-4 text-brand-text" /><h3 className="font-semibold">{t('adminMarketingPlatform.vectorIndexHealth')}</h3></div>
            <p className="mb-3 text-xs text-muted">{t('adminMarketingPlatform.onlyPersistedRowsInTheSupabase')}</p>
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">{embeddingStatuses.map((status) => <div key={status} className="rounded-lg border border-border px-2 py-2"><span className="block capitalize text-muted">{status}</span><span className="mt-1 block text-lg font-bold tabular-nums">{embeddingCounts[status].toLocaleString()}</span></div>)}</div>
            {embeddingCounts.ready === 0 ? <p className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{t('adminMarketingPlatform.noReadyVectorsAreCurrentlyPersisted')}</p> : null}
          </Card>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold">{t('adminMarketingPlatform.templates')}</h3><p className="text-xs text-muted">{t('adminMarketingPlatform.reusablePageInstructionsAndDefaults')}</p></div><Badge tone="neutral">{templates.length}</Badge></div><div className="space-y-3">{templates.map((template) => <div key={template.id} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between"><span className="font-medium">{template.name}</span><Badge tone={template.status === 'active' ? 'success' : 'neutral'}>{template.page_type}</Badge></div><p className="mt-1 text-xs text-muted">{template.instructions || 'No instructions yet.'}</p></div>)}</div><form action={saveMarketingTemplate} className="mt-4 grid gap-2 border-t border-border pt-4 sm:grid-cols-2"><input name="name" required placeholder={t('adminMarketingPlatform.templateName')} className={inputCls} /><select name="page_type" className={inputCls}>{PAGE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select><input name="description" placeholder={t('adminMarketingPlatform.description')} className={inputCls} /><input name="cta_label" placeholder={t('adminMarketingPlatform.defaultCta')} className={inputCls} /><input name="section_count" type="number" min="1" max="12" defaultValue="3" placeholder={t('adminMarketingPlatform.sections')} className={inputCls} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_default" /> {t('adminMarketingPlatform.defaultForThisType')}</label><textarea name="instructions" rows={3} placeholder={t('adminMarketingPlatform.generationInstructions')} className={`${areaCls} sm:col-span-2`} /><button className="rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-elevated sm:col-span-2">{t('adminMarketingPlatform.saveTemplate')}</button></form></Card>

        <Card><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold">{t('adminMarketingPlatform.brandRules')}</h3><p className="text-xs text-muted">{t('adminMarketingPlatform.factsAndConstraintsEveryGeneratedPage')}</p></div><Badge tone="neutral">{rules.length}</Badge></div><div className="space-y-3">{rules.map((rule) => <div key={rule.id} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between"><span className="font-medium">{rule.name}</span><Badge tone={rule.active ? 'success' : 'neutral'}>{rule.rule_key}</Badge></div><p className="mt-1 text-xs text-muted">{rule.instructions || 'No instructions yet.'}</p></div>)}</div><form action={saveMarketingBrandRule} className="mt-4 space-y-2 border-t border-border pt-4"><div className="grid gap-2 sm:grid-cols-2"><input name="rule_key" required placeholder="brand_voice" className={inputCls} /><input name="name" required placeholder={t('adminMarketingPlatform.brandVoice')} className={inputCls} /></div><textarea name="instructions" rows={3} required placeholder={t('adminMarketingPlatform.writeTheRuleInPlainLanguage')} className={areaCls} /><input name="examples" placeholder={t('adminMarketingPlatform.approvedExamplesOrFacts')} className={inputCls} /><button className="rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-elevated">{t('adminMarketingPlatform.saveBrandRule')}</button></form></Card>
      </div>

      <Card><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold">{t('adminMarketingPlatform.generationQueue')}</h3><p className="text-xs text-muted">{t('adminMarketingPlatform.claimedByTheFiveMinuteWorker')}</p></div><Badge tone={failed || staleJobs ? 'danger' : 'success'}>{failed ? `${failed} attention` : staleJobs ? `${staleJobs} stale` : 'Healthy'}</Badge></div>
        <div className="mb-4 grid grid-cols-2 gap-2 text-xs sm:grid-cols-6">{jobStatuses.map((status) => <div key={status} className="rounded-lg border border-border px-2 py-2"><span className="block capitalize text-muted">{status.replace('_', ' ')}</span><span className="mt-1 block text-lg font-bold tabular-nums">{jobCounts[status].toLocaleString()}</span></div>)}</div>
        {staleJobs ? <p className="mb-4 rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{staleJobs} {t('adminMarketingPlatform.runningJob')}{staleJobs === 1 ? '' : 's'} {t('adminMarketingPlatform.hasALockOlderThan15')}</p> : null}
        <p className="mb-3 text-xs text-muted">{t('adminMarketingPlatform.lastSuccessfulJob')} {latestSuccess?.completed_at ? `${latestSuccess.job_type.replaceAll('_', ' ')} · ${formatTimestamp(latestSuccess.completed_at)}${latestSuccess.target_path ? ` · ${latestSuccess.target_path}` : ''}` : 'none recorded'}</p>
        {jobs.length === 0 ? <p className="text-sm text-muted">{t('adminMarketingPlatform.noJobsHaveBeenCreatedYet')}</p> : <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead className="border-b border-border text-xs text-muted"><tr><th className="px-2 py-2">{t('adminMarketingPlatform.type')}</th><th className="px-2 py-2">{t('adminMarketingPlatform.target')}</th><th className="px-2 py-2">{t('adminMarketingPlatform.status')}</th><th className="px-2 py-2">{t('adminMarketingPlatform.attempts')}</th><th className="px-2 py-2">{t('adminMarketingPlatform.action')}</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id} className="border-b border-border/60"><td className="px-2 py-2 font-medium">{job.job_type.replaceAll('_', ' ')}</td><td className="px-2 py-2 text-muted">{job.target_path ?? job.target_id ?? 'system'}</td><td className="px-2 py-2"><Badge tone={job.status === 'succeeded' ? 'success' : job.status === 'failed' || job.status === 'dead_letter' ? 'danger' : 'neutral'}>{job.status}</Badge></td><td className="px-2 py-2 text-muted">{job.attempts}/{job.max_attempts}</td><td className="px-2 py-2">{job.status === 'failed' || job.status === 'dead_letter' ? <form action={retryMarketingJob}><input type="hidden" name="id" value={job.id} /><button className="text-xs font-semibold text-brand-text hover:underline">{t('platform.retry')}</button></form> : <span className="text-xs text-muted">{job.completed_at ? 'Complete' : 'Waiting'}</span>}</td></tr>)}</tbody></table></div>}
      </Card>
    </div>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof FileText; label: string; value: number }) {
  return <Card className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand-text"><Icon className="h-4 w-4" /></span><span><span className="block text-lg font-bold tabular-nums">{value.toLocaleString()}</span><span className="block text-[11px] text-muted">{label}</span></span></Card>;
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

async function PageEditor({ page }: { page: Awaited<ReturnType<typeof createServiceClient>> extends never ? never : DatabasePage }) {
  const t = await getTranslations();
  return <div className="rounded-xl border border-border p-3"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div><div className="flex items-center gap-2"><span className="font-semibold">{page.title}</span><Badge tone={page.status === 'published' ? 'success' : 'neutral'}>{page.status}</Badge></div><p className="mt-0.5 text-xs text-muted">{page.path} · v{page.version}</p></div><form action={archivePlatformPage}><input type="hidden" name="id" value={page.id} /><button className="text-xs text-muted hover:text-danger">{t('platform.archive')}</button></form></div><form action={updatePlatformPage} className="grid gap-2 sm:grid-cols-2"><input type="hidden" name="id" value={page.id} /><select name="page_type" defaultValue={page.page_type} className={inputCls}>{PAGE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select><select name="status" defaultValue={page.status} className={inputCls}>{['draft', 'review', 'approved', 'published', 'archived'].map((status) => <option key={status} value={status}>{status}</option>)}</select><input name="title" defaultValue={page.title} required className={inputCls} /><input name="slug" defaultValue={page.slug} required className={inputCls} /><input name="summary" defaultValue={page.summary ?? ''} placeholder={t('platform.summary')} className={`${inputCls} sm:col-span-2`} /><textarea name="body" defaultValue={page.body ?? ''} rows={3} placeholder={t('platform.body')} className={`${areaCls} sm:col-span-2`} /><button className="rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-elevated sm:col-span-2">{t('platform.saveAndRegenerate')}</button></form></div>;
}

type DatabasePage = {
  id: string; page_type: string; slug: string; path: string; title: string; summary: string | null; body: string | null; status: string; version: number;
};

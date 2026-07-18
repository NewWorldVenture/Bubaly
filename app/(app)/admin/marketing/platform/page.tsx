import type { Metadata } from 'next';
import Link from 'next/link';
import { Activity, Bot, FileText, Layers3, Plus, RefreshCw, Sparkles, WandSparkles } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { PAGE_TYPES } from '@/lib/marketing/platform';
import { archivePlatformPage, createPlatformPage, retryMarketingJob, saveMarketingBrandRule, saveMarketingTemplate, updatePlatformPage } from './actions';

export const metadata: Metadata = { title: 'Marketing · Platform', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-lg border border-border bg-surface/60 px-3 text-sm focus-ring';
const areaCls = 'w-full rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm focus-ring';

export default async function MarketingPlatformPage() {
  const supabase = createServiceClient();
  const [pagesResult, templatesResult, rulesResult, jobsResult, syncResult] = await Promise.all([
    supabase.from('marketing_pages').select('*').is('deleted_at', null).order('updated_at', { ascending: false }).limit(40),
    supabase.from('marketing_content_templates').select('*').neq('status', 'archived').order('page_type').order('name'),
    supabase.from('marketing_brand_rules').select('*').order('name'),
    supabase.from('marketing_generation_jobs').select('*').order('created_at', { ascending: false }).limit(30),
    supabase.from('marketing_provider_syncs').select('*').order('provider'),
  ]);
  const error = pagesResult.error ?? templatesResult.error ?? rulesResult.error ?? jobsResult.error ?? syncResult.error;
  if (error) return <ErrorState message="Could not load the marketing platform control center. Refresh and try again." />;
  const pages = pagesResult.data ?? [];
  const templates = templatesResult.data ?? [];
  const rules = rulesResult.data ?? [];
  const jobs = jobsResult.data ?? [];
  const syncs = syncResult.data ?? [];
  const queued = jobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
  const failed = jobs.filter((job) => job.status === 'failed' || job.status === 'dead_letter').length;
  const published = pages.filter((page) => page.status === 'published').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-brand-text">Marketing operating system</p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Pages, rules, and automation</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">Every platform page is versioned in Supabase. Edits enqueue generation, AEO, and embedding work with visible provider health.</p>
        </div>
        <Link href="#new-page" className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90"><Plus className="h-4 w-4" /> New page</Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Metric icon={FileText} label="Pages" value={pages.length} />
        <Metric icon={Sparkles} label="Published" value={published} />
        <Metric icon={Layers3} label="Templates" value={templates.length} />
        <Metric icon={Activity} label="Jobs active" value={queued} />
        <Metric icon={RefreshCw} label="Jobs needing review" value={failed} />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <Card>
          <div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold">Page registry</h3><p className="text-xs text-muted">The canonical public page inventory.</p></div><Badge tone="neutral">{pages.length} loaded</Badge></div>
          {pages.length === 0 ? <EmptyState icon={FileText} title="No platform pages yet" description="Create the first page and the worker will prepare its content automatically." /> : (
            <div className="space-y-3">{pages.map((page) => <PageEditor key={page.id} page={page} />)}</div>
          )}
        </Card>

        <div className="space-y-5">
          <Card id="new-page">
            <h3 className="font-semibold">Create page</h3><p className="mt-1 text-xs text-muted">The first save creates a queued regeneration job.</p>
            <form action={createPlatformPage} className="mt-4 space-y-3">
              <select name="page_type" className={inputCls} defaultValue="guide">{PAGE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label} ({type.prefix})</option>)}</select>
              <input name="title" required placeholder="Title" className={inputCls} />
              <input name="slug" placeholder="Slug (auto from title)" className={inputCls} />
              <input name="summary" placeholder="One-sentence promise" className={inputCls} />
              <textarea name="body" rows={4} placeholder="Source facts or editorial brief" className={areaCls} />
              <button className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand/90"><WandSparkles className="h-4 w-4" /> Create and queue</button>
            </form>
          </Card>

          <Card>
            <div className="mb-3 flex items-center gap-2"><Bot className="h-4 w-4 text-brand-text" /><h3 className="font-semibold">Provider sync health</h3></div>
            <div className="space-y-2">{syncs.map((sync) => <div key={sync.provider} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"><span className="capitalize">{sync.provider.replaceAll('_', ' ')}</span><Badge tone={sync.status === 'connected' ? 'success' : sync.status === 'error' ? 'danger' : 'neutral'}>{sync.status.replaceAll('_', ' ')}</Badge></div>)}</div>
          </Card>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold">Templates</h3><p className="text-xs text-muted">Reusable page instructions and defaults.</p></div><Badge tone="neutral">{templates.length}</Badge></div><div className="space-y-3">{templates.map((template) => <div key={template.id} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between"><span className="font-medium">{template.name}</span><Badge tone={template.status === 'active' ? 'success' : 'neutral'}>{template.page_type}</Badge></div><p className="mt-1 text-xs text-muted">{template.instructions || 'No instructions yet.'}</p></div>)}</div><form action={saveMarketingTemplate} className="mt-4 grid gap-2 border-t border-border pt-4 sm:grid-cols-2"><input name="name" required placeholder="Template name" className={inputCls} /><select name="page_type" className={inputCls}>{PAGE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select><input name="description" placeholder="Description" className={inputCls} /><input name="cta_label" placeholder="Default CTA" className={inputCls} /><input name="section_count" type="number" min="1" max="12" defaultValue="3" placeholder="Sections" className={inputCls} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_default" /> Default for this type</label><textarea name="instructions" rows={3} placeholder="Generation instructions" className={`${areaCls} sm:col-span-2`} /><button className="rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-elevated sm:col-span-2">Save template</button></form></Card>

        <Card><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold">Brand rules</h3><p className="text-xs text-muted">Facts and constraints every generated page receives.</p></div><Badge tone="neutral">{rules.length}</Badge></div><div className="space-y-3">{rules.map((rule) => <div key={rule.id} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between"><span className="font-medium">{rule.name}</span><Badge tone={rule.active ? 'success' : 'neutral'}>{rule.rule_key}</Badge></div><p className="mt-1 text-xs text-muted">{rule.instructions || 'No instructions yet.'}</p></div>)}</div><form action={saveMarketingBrandRule} className="mt-4 space-y-2 border-t border-border pt-4"><div className="grid gap-2 sm:grid-cols-2"><input name="rule_key" required placeholder="brand_voice" className={inputCls} /><input name="name" required placeholder="Brand voice" className={inputCls} /></div><textarea name="instructions" rows={3} required placeholder="Write the rule in plain language" className={areaCls} /><input name="examples" placeholder="Approved examples or facts" className={inputCls} /><button className="rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-elevated">Save brand rule</button></form></Card>
      </div>

      <Card><div className="mb-4 flex items-center justify-between"><div><h3 className="font-semibold">Generation queue</h3><p className="text-xs text-muted">Claimed by the five-minute worker with retry and dead-letter visibility.</p></div><Badge tone={failed ? 'danger' : 'success'}>{failed ? `${failed} attention` : 'Healthy'}</Badge></div>{jobs.length === 0 ? <p className="text-sm text-muted">No jobs have been created yet.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-sm"><thead className="border-b border-border text-xs text-muted"><tr><th className="px-2 py-2">Type</th><th className="px-2 py-2">Target</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Attempts</th><th className="px-2 py-2">Action</th></tr></thead><tbody>{jobs.map((job) => <tr key={job.id} className="border-b border-border/60"><td className="px-2 py-2 font-medium">{job.job_type.replaceAll('_', ' ')}</td><td className="px-2 py-2 text-muted">{job.target_path ?? job.target_id ?? 'system'}</td><td className="px-2 py-2"><Badge tone={job.status === 'succeeded' ? 'success' : job.status === 'failed' || job.status === 'dead_letter' ? 'danger' : 'neutral'}>{job.status}</Badge></td><td className="px-2 py-2 text-muted">{job.attempts}/{job.max_attempts}</td><td className="px-2 py-2">{job.status === 'failed' || job.status === 'dead_letter' ? <form action={retryMarketingJob}><input type="hidden" name="id" value={job.id} /><button className="text-xs font-semibold text-brand-text hover:underline">Retry</button></form> : <span className="text-xs text-muted">{job.completed_at ? 'Complete' : 'Waiting'}</span>}</td></tr>)}</tbody></table></div>}</Card>
    </div>
  );
}

function Metric({ icon: Icon, label, value }: { icon: typeof FileText; label: string; value: number }) {
  return <Card className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand-text"><Icon className="h-4 w-4" /></span><span><span className="block text-lg font-bold tabular-nums">{value.toLocaleString()}</span><span className="block text-[11px] text-muted">{label}</span></span></Card>;
}

function PageEditor({ page }: { page: Awaited<ReturnType<typeof createServiceClient>> extends never ? never : DatabasePage }) {
  return <div className="rounded-xl border border-border p-3"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><div><div className="flex items-center gap-2"><span className="font-semibold">{page.title}</span><Badge tone={page.status === 'published' ? 'success' : 'neutral'}>{page.status}</Badge></div><p className="mt-0.5 text-xs text-muted">{page.path} · v{page.version}</p></div><form action={archivePlatformPage}><input type="hidden" name="id" value={page.id} /><button className="text-xs text-muted hover:text-danger">Archive</button></form></div><form action={updatePlatformPage} className="grid gap-2 sm:grid-cols-2"><input type="hidden" name="id" value={page.id} /><select name="page_type" defaultValue={page.page_type} className={inputCls}>{PAGE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select><select name="status" defaultValue={page.status} className={inputCls}>{['draft', 'review', 'approved', 'published', 'archived'].map((status) => <option key={status} value={status}>{status}</option>)}</select><input name="title" defaultValue={page.title} required className={inputCls} /><input name="slug" defaultValue={page.slug} required className={inputCls} /><input name="summary" defaultValue={page.summary ?? ''} placeholder="Summary" className={`${inputCls} sm:col-span-2`} /><textarea name="body" defaultValue={page.body ?? ''} rows={3} placeholder="Body" className={`${areaCls} sm:col-span-2`} /><button className="rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-elevated sm:col-span-2">Save and regenerate</button></form></div>;
}

type DatabasePage = {
  id: string; page_type: string; slug: string; path: string; title: string; summary: string | null; body: string | null; status: string; version: number;
};

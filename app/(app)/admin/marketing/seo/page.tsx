import type { Metadata } from 'next';
import Link from 'next/link';
import { Search, ExternalLink } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { addKeyword, archiveSeoKeyword, archiveSeoPage, saveSeoPage, updateSeoKeyword } from '../actions';
import { SeoTabs } from './seo-tabs';

export const metadata: Metadata = { title: 'Marketing · SEO', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

// The site's real indexable public pages (kept in sync with the marketing site).
const SITE_PAGES = [
  '/', '/features', '/how-it-works', '/ai', '/pricing', '/security', '/faq', '/blog', '/mobile', '/contact',
];
const INTENTS = ['informational', 'navigational', 'commercial', 'transactional'];
const KEYWORD_STATUSES = ['idea', 'tracking', 'won', 'dropped'];
const PAGE_STATUSES = ['active', 'noindex', 'archived'];

// The keyword table can hold thousands of rows; fetching + rendering all of them
// made the page slow to open. Render a bounded, column-projected slice and show the
// true total from a cheap COUNT (head:true → no row transfer). The page registry is
// small (one row per public route) so it loads in full.
const KEYWORD_LIMIT = 100;

export default async function SeoPage() {
  const supabase = createServiceClient();
  const [keywordCountResult, keywordsResult, pagesResult] = await Promise.all([
    supabase.from('marketing_seo_keywords').select('id', { count: 'exact', head: true }),
    supabase
      .from('marketing_seo_keywords')
      .select('id, keyword, intent, target_path, source, status')
      .order('created_at', { ascending: false })
      .limit(KEYWORD_LIMIT),
    supabase.from('marketing_seo_pages').select('*').order('path', { ascending: true }),
  ]);
  const readError = keywordCountResult.error ?? keywordsResult.error ?? pagesResult.error;
  if (readError) {
    console.error('[admin-marketing-seo] read failed', readError);
    return <AdminSeoReadError />;
  }
  const keywords = keywordsResult.data ?? [];
  const keywordTotal = keywordCountResult.count ?? 0;
  const seoPages = pagesResult.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Marketing SEO</h1>
          <p className="mt-1 text-sm text-muted">Track search intent, keywords, and the audit status of every indexable marketing page.</p>
        </div>
        <Link href="/admin/marketing/aeo" className="text-sm font-medium text-brand-text hover:underline">AEO →</Link>
      </div>

      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">
        SEO here uses <strong className="text-fg">first-party data only</strong>. Rankings, search volume, and backlinks are never invented — connect Google Search Console for those. AI keyword ideas are clearly labeled as suggestions.
      </div>

      <SeoTabs
        tabs={[
          {
            id: 'indexable',
            label: 'Indexable pages',
            count: SITE_PAGES.length,
            panel: (
              <Card>
                <h2 className="mb-3 font-semibold">Indexable pages</h2>
                <p className="mb-3 text-xs text-muted">The public routes that should be crawled and indexed. Open any to preview, or view the generated sitemap / robots file.</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {SITE_PAGES.map((p) => (
                    <a key={p} href={p} target="_blank" rel="noreferrer" className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm hover:bg-elevated">
                      <span className="font-mono text-xs">{p}</span>
                      <ExternalLink className="h-3.5 w-3.5 text-muted" />
                    </a>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                  <a href="/sitemap.xml" target="_blank" rel="noreferrer" className="rounded-lg border border-border px-3 py-1.5 hover:bg-elevated">View sitemap.xml</a>
                  <a href="/robots.txt" target="_blank" rel="noreferrer" className="rounded-lg border border-border px-3 py-1.5 hover:bg-elevated">View robots.txt</a>
                </div>
              </Card>
            ),
          },
          {
            id: 'registry',
            label: 'SEO Page Registry',
            count: seoPages.length,
            panel: (
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">SEO Page Registry</h2>
                    <p className="mt-1 text-xs text-muted">The stored title, description, audit score, and index policy for each public route — the source that drives page metadata.</p>
                  </div>
                  <span className="text-xs text-muted">{seoPages.length} tracked</span>
                </div>
                {seoPages.length === 0 ? (
                  <p className="mt-4 text-sm text-muted">No page audits yet. Add the first route below.</p>
                ) : (
                  <div className="mt-4 space-y-2">
                    {seoPages.map((page) => (
                      <details key={page.id} className="rounded-xl border border-border p-3">
                        <summary className="cursor-pointer list-none">
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono text-xs">{page.path}</span>
                            <span className="text-xs text-muted">{page.score == null ? 'Unscored' : `${page.score}/100`} · {page.status}</span>
                          </div>
                        </summary>
                        <form action={saveSeoPage} className="mt-3 grid gap-2 sm:grid-cols-2">
                          <input type="hidden" name="id" value={page.id} />
                          <input name="path" required defaultValue={page.path} className={inputCls} />
                          <input name="title" defaultValue={page.title ?? ''} placeholder="SEO title" className={inputCls} />
                          <input name="meta_description" defaultValue={page.meta_description ?? ''} placeholder="Meta description" className={`${inputCls} sm:col-span-2`} />
                          <input name="score" type="number" min="0" max="100" defaultValue={page.score ?? ''} placeholder="Score 0–100" className={inputCls} />
                          <select name="status" defaultValue={page.status} className={inputCls}>{PAGE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select>
                          <button type="submit" className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand/90 sm:col-span-2">Save page audit</button>
                        </form>
                        <form action={archiveSeoPage} className="mt-2">
                          <input type="hidden" name="id" value={page.id} />
                          <button type="submit" className="text-xs text-muted hover:text-rose-400">Archive audit</button>
                        </form>
                      </details>
                    ))}
                  </div>
                )}
                <details className="mt-3 rounded-xl border border-dashed border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium">Add page audit</summary>
                  <form action={saveSeoPage} className="mt-3 grid gap-2 sm:grid-cols-2">
                    <input name="path" required placeholder="/pricing" className={inputCls} />
                    <input name="title" placeholder="SEO title" className={inputCls} />
                    <input name="meta_description" placeholder="Meta description" className={`${inputCls} sm:col-span-2`} />
                    <input name="score" type="number" min="0" max="100" placeholder="Score 0–100" className={inputCls} />
                    <select name="status" defaultValue="active" className={inputCls}>{PAGE_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select>
                    <button type="submit" className="rounded-lg border border-border px-3 py-2 text-sm font-semibold hover:bg-elevated sm:col-span-2">Add page audit</button>
                  </form>
                </details>
              </Card>
            ),
          },
          {
            id: 'keywords',
            label: 'Tracked keywords',
            count: keywordTotal,
            panel: (
              <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
                <Card>
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="font-semibold">Tracked keywords</h2>
                    {keywordTotal > keywords.length && (
                      <span className="text-xs text-muted">Latest {keywords.length} of {keywordTotal.toLocaleString()}</span>
                    )}
                  </div>
                  {keywordTotal === 0 ? (
                    <EmptyState icon={Search} title="No keywords tracked" description="Add target keywords in the panel on the right." />
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead><tr className="border-b border-border text-left text-xs text-muted">
                          <th className="px-3 py-2 font-medium">Keyword</th><th className="px-3 py-2 font-medium">Intent</th><th className="px-3 py-2 font-medium">Target</th><th className="px-3 py-2 font-medium">Source</th><th className="px-3 py-2 font-medium">Actions</th>
                        </tr></thead>
                        <tbody className="divide-y divide-border/60">
                          {(keywords ?? []).map((k) => (
                            <tr key={k.id}>
                              <td className="px-3 py-2 font-medium">{k.keyword}</td>
                              <td className="px-3 py-2 text-muted capitalize">{k.intent ?? '—'}</td>
                              <td className="px-3 py-2 font-mono text-xs text-muted">{k.target_path ?? '—'}</td>
                              <td className="px-3 py-2">{k.source === 'ai_suggestion' ? <Badge tone="accent">AI idea</Badge> : <Badge tone="neutral">{k.source}</Badge>}</td>
                              <td className="px-3 py-2">
                                <details>
                                  <summary className="cursor-pointer text-xs text-brand-text">Edit</summary>
                                  <form action={updateSeoKeyword} className="mt-2 min-w-64 space-y-2">
                                    <input type="hidden" name="id" value={k.id} />
                                    <input name="keyword" required defaultValue={k.keyword} className={inputCls} />
                                    <select name="intent" defaultValue={k.intent ?? ''} className={inputCls}><option value="">Intent</option>{INTENTS.map((intent) => <option key={intent} value={intent}>{intent}</option>)}</select>
                                    <select name="target_path" defaultValue={k.target_path ?? ''} className={inputCls}><option value="">Target page</option>{SITE_PAGES.map((path) => <option key={path} value={path}>{path}</option>)}</select>
                                    <select name="status" defaultValue={k.status} className={inputCls}>{KEYWORD_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}</select>
                                    <button type="submit" className="w-full rounded-lg bg-brand px-3 py-2 text-xs font-semibold text-white hover:bg-brand/90">Save keyword</button>
                                  </form>
                                  <form action={archiveSeoKeyword} className="mt-2">
                                    <input type="hidden" name="id" value={k.id} />
                                    <button type="submit" className="text-xs text-muted hover:text-rose-400">Archive keyword</button>
                                  </form>
                                </details>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>

                <Card className="h-fit">
                  <h2 className="mb-3 font-semibold">Track a keyword</h2>
                  <form action={addKeyword} className="space-y-3 text-sm">
                    <input name="keyword" required placeholder="family organization app" className={inputCls} />
                    <select name="intent" className={inputCls}><option value="">Intent (optional)</option>{INTENTS.map((i) => <option key={i} value={i}>{i}</option>)}</select>
                    <select name="target_path" className={inputCls}><option value="">Target page (optional)</option>{SITE_PAGES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
                    <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Add keyword</button>
                  </form>
                </Card>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

function AdminSeoReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Marketing SEO</h1>
        <p className="mt-1 text-sm text-muted">Track search intent and indexable marketing pages.</p>
      </div>
      <ErrorState message="Could not load SEO keywords from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/seo" className="text-sm font-medium text-brand-text underline">Refresh SEO</Link>
    </div>
  );
}

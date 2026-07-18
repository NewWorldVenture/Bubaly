import type { Metadata } from 'next';
import Link from 'next/link';
import { Layout, ExternalLink } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { archiveLandingPage, createLandingPage, setLandingPublished, updateLandingPage } from '../actions';

export const metadata: Metadata = { title: 'Marketing · Landing Pages', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

export default async function LandingPagesPage() {
  const supabase = createServiceClient();
  const { data: pages, error: pagesError } = await supabase.from('marketing_landing_pages').select('*').is('deleted_at', null).order('created_at', { ascending: false });
  if (pagesError) {
    console.error('[admin-marketing-landing-pages] landing page read failed', pagesError);
    return <AdminLandingPagesReadError />;
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        {(pages ?? []).length === 0 ? (
          <EmptyState icon={Layout} title="No landing pages yet" description="Draft your first landing page on the right." />
        ) : (
          (pages ?? []).map((p) => (
            <Card key={p.id} className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate font-semibold">{p.title}</p>
                  <Badge tone={p.published ? 'success' : 'neutral'}>{p.published ? 'Published' : 'Draft'}</Badge>
                </div>
               <p className="font-mono text-xs text-muted">/lp/{p.slug}</p>
               {p.headline && <p className="mt-1 text-sm text-muted">{p.headline}</p>}
               <details className="mt-3 text-sm">
                 <summary className="cursor-pointer text-xs text-muted hover:text-fg">Edit page</summary>
                 <form action={updateLandingPage} className="mt-3 grid gap-2 sm:grid-cols-2">
                   <input type="hidden" name="id" value={p.id} />
                   <input name="title" required defaultValue={p.title} placeholder="Internal title" className={inputCls} />
                   <input name="slug" required defaultValue={p.slug} placeholder="url-slug" className={inputCls} />
                   <input name="headline" defaultValue={p.headline ?? ''} placeholder="Hero headline" className={inputCls} />
                   <input name="subhead" defaultValue={p.subhead ?? ''} placeholder="Subhead" className={inputCls} />
                   <input name="cta_label" defaultValue={typeof (p.metadata as Record<string, unknown> | null)?.cta_label === 'string' ? (p.metadata as Record<string, unknown>).cta_label as string : ''} placeholder="CTA label" className={inputCls} />
                   <input name="cta_href" defaultValue={typeof (p.metadata as Record<string, unknown> | null)?.cta_href === 'string' ? (p.metadata as Record<string, unknown>).cta_href as string : ''} placeholder="CTA link" className={inputCls} />
                   <textarea name="body" rows={4} defaultValue={p.body ?? ''} placeholder="Body copy" className="sm:col-span-2 w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
                   <button type="submit" className="rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white hover:bg-brand/90 sm:col-span-2">Save changes</button>
                 </form>
               </details>
             </div>
              <div className="flex shrink-0 flex-col items-end gap-2 text-right text-xs text-muted">
                <div>
                  <p className="font-semibold text-fg">{p.views}</p> views
                  <p className="mt-1">{p.conversions} conv.</p>
                </div>
                <div className="flex items-center gap-2">
                  {p.published && (
                    <a href={`/lp/${p.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline">
                      View <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                   <form action={setLandingPublished}>
                    <input type="hidden" name="id" value={p.id} />
                    <input type="hidden" name="publish" value={p.published ? '0' : '1'} />
                    <button className="rounded-lg border border-border px-2 py-1 font-medium hover:bg-elevated">
                      {p.published ? 'Unpublish' : 'Publish'}
                     </button>
                   </form>
                   <form action={archiveLandingPage}>
                     <input type="hidden" name="id" value={p.id} />
                     <button type="submit" className="text-muted hover:text-rose-400">Archive</button>
                   </form>
                 </div>
              </div>
            </Card>
          ))
        )}
      </div>
      <Card className="h-fit">
        <h2 className="mb-3 font-semibold">New landing page</h2>
        <form action={createLandingPage} className="space-y-3 text-sm">
          <input name="title" required placeholder="Internal title" className={inputCls} />
          <input name="slug" required placeholder="url-slug" className={inputCls} />
          <input name="headline" placeholder="Hero headline" className={inputCls} />
          <input name="subhead" placeholder="Subhead" className={inputCls} />
          <textarea name="body" rows={4} placeholder="Body copy (blank line between paragraphs)…" className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
          <input name="cta_label" placeholder="CTA label (e.g. Get started free)" className={inputCls} />
          <input name="cta_href" placeholder="CTA link (/signup or https://…)" className={inputCls} />
          <p className="text-xs text-muted">Pages are created as drafts. Use <strong>Publish</strong> to make them live at <span className="font-mono">/lp/&lt;slug&gt;</span>.</p>
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Create page</button>
        </form>
      </Card>
    </div>
  );
}

function AdminLandingPagesReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Marketing Landing Pages</h1>
        <p className="mt-1 text-sm text-muted">Draft and publish conversion-focused landing pages.</p>
      </div>
      <ErrorState message="Could not load landing pages from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/landing-pages" className="text-sm font-medium text-brand-text underline">Refresh landing pages</Link>
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { FileText, BookOpen, Send } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { BLOG_CATEGORIES } from '@/lib/marketing/blog-publish';
import { createContentItem } from '../actions';
import { archiveContentAction, updateContentAction, publishContentToBlogAction, unpublishBlogPostAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Marketing · Content', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const smCls = 'h-9 w-full rounded-lg border border-border bg-surface/60 px-2 text-sm focus-ring';
const KINDS = ['blog', 'landing', 'social', 'email', 'ad', 'seo_brief', 'aeo_brief'];
const STATUSES = ['idea', 'brief', 'drafting', 'review', 'approved', 'published'];

type BlogMeta = { slug?: string; category?: string; author?: string; excerpt?: string; featured?: boolean; tags?: string[] };

export default async function ContentPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const [itemsResult, postsResult] = await settleAll([
    supabase.from('marketing_content_items').select('*').is('deleted_at', null).order('publish_at', { ascending: true, nullsFirst: false }),
    supabase.from('blog_posts').select('slug, title, category, published, published_at').order('published_at', { ascending: false }).limit(20),
  ]);
  const readError = itemsResult.error ?? postsResult.error;
  if (readError) {
    console.error('[admin-marketing-content] content read failed', readError);
    return <AdminContentReadError />;
  }
  const { data: items } = itemsResult;
  const { data: posts } = postsResult;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <div>
          <h2 className="mb-2 font-semibold">{t('adminMarketingContent.contentPipeline')}</h2>
          {(items ?? []).length === 0 ? (
            <EmptyState icon={FileText} title={t('adminMarketingContent.noContentPlanned')} description={t('content.addAnIdeaOrBrief')} />
          ) : (
            <div className="space-y-2">
              {(items ?? []).map((it) => {
                const metadata = (it.metadata as Record<string, unknown> | null) ?? {};
                const blog = ((metadata.blog && typeof metadata.blog === 'object' ? metadata.blog : metadata) ?? {}) as BlogMeta;
                const isBlog = it.kind === 'blog';
                const canPublish = isBlog && Boolean(it.body?.trim()) && (it.status === 'approved' || it.status === 'published');
                return (
                  <Card key={it.id} className="py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{it.title}</p>
                        <p className="text-xs text-muted capitalize">{it.kind.replace('_', ' ')}{it.publish_at ? ` · ${fmtDate(it.publish_at)}` : ''}</p>
                      </div>
                      <Badge tone={it.status === 'published' ? 'success' : it.status === 'approved' ? 'brand' : 'neutral'} className="capitalize">{it.status}</Badge>
                    </div>

                    <details className="mt-2 text-sm">
                      <summary className="cursor-pointer text-xs text-muted hover:text-fg">Edit{isBlog ? ' & publish to blog' : ''}</summary>
                      <form action={updateContentAction} className="mt-2 space-y-2">
                        <input type="hidden" name="id" value={it.id} />
                        <textarea name="body" rows={5} defaultValue={it.body ?? ''} placeholder="Body — blank line between paragraphs; # Heading for sections" className="w-full rounded-lg border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
                        {isBlog && (
                          <div className="grid grid-cols-2 gap-2">
                            <input name="slug" defaultValue={blog.slug ?? ''} placeholder="Slug (auto from title)" className={smCls} />
                            <select name="category" defaultValue={blog.category ?? ''} className={smCls}>
                              <option value="">Category…</option>
                              {BLOG_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                            </select>
                            <input name="author" defaultValue={blog.author ?? ''} placeholder="Author (default: The Bubaly Team)" className={smCls} />
                            <input name="tags" defaultValue={(blog.tags ?? []).join(', ')} placeholder={t('content.tagsCommaSeparated')} className={smCls} />
                            <input name="excerpt" defaultValue={blog.excerpt ?? ''} placeholder="Excerpt (auto from body)" className={`${smCls} col-span-2`} />
                            <label className="col-span-2 flex items-center gap-2 text-xs text-muted"><input type="checkbox" name="featured" defaultChecked={blog.featured === true} className="h-4 w-4 accent-[var(--brand)]" />{' '}{t('content.featuredPost')}</label>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <select name="status" defaultValue={it.status} className={`${smCls} flex-1`}>
                            {STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                          </select>
                          <button type="submit" className="h-9 shrink-0 rounded-lg bg-elevated px-4 text-sm font-semibold hover:bg-elevated/80">{t('content.save')}</button>
                        </div>
                      </form>
                      {isBlog && canPublish && (
                        <form action={publishContentToBlogAction} className="mt-2">
                          <input type="hidden" name="id" value={it.id} />
                          <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90">
                            <Send className="h-3.5 w-3.5" />{' '}{t('content.publishToBlog')}</button>
                          <span className="ml-2 text-xs text-muted">{t('content.saveTheBodyFirstCreates')}</span>
                        </form>
                      )}
                    </details>
                    <form action={archiveContentAction} className="mt-2">
                      <input type="hidden" name="id" value={it.id} />
                      <button type="submit" className="text-xs text-muted hover:text-rose-400">{t('content.archive')}</button>
                    </form>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><BookOpen className="h-4 w-4" /> {t('adminMarketingContent.publishedBlog')}</h2>
          {(posts ?? []).length === 0 ? (
            <p className="text-sm text-muted">{t('adminMarketingContent.noBlogPostsYet')}</p>
          ) : (
            <div className="space-y-2">
              {(posts ?? []).map((p) => (
                <Card key={p.slug} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <a href={`/blog/${p.slug}`} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline">{p.title}</a>
                    <p className="text-xs text-muted">{p.category}{p.published_at ? ` · ${fmtDate(p.published_at)}` : ''}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={p.published ? 'success' : 'neutral'}>{p.published ? 'Live' : 'Draft'}</Badge>
                    {p.published && (
                      <form action={unpublishBlogPostAction.bind(null, p.slug)}>
                        <button type="submit" className="text-xs text-muted hover:text-rose-400">{t('content.unpublish')}</button>
                      </form>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>

      <Card className="h-fit">
        <h2 className="mb-3 font-semibold">{t('adminMarketingContent.newContentIdea')}</h2>
        <form action={createContentItem} className="space-y-3 text-sm">
          <input name="title" required placeholder={t('adminMarketingContent.titleOrTopic')} className={inputCls} />
          <select name="kind" className={inputCls}>{KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select>
          <input name="publish_at" type="date" className={inputCls} />
          <textarea name="brief" rows={4} placeholder={t('adminMarketingContent.briefNotes')} className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">{t('adminMarketingContent.addToPipeline')}</button>
        </form>
        <p className="mt-3 text-xs text-muted">{t('adminMarketingContent.blogItemsWriteTheBodySet')} <code>/blog/&lt;slug&gt;</code>.</p>
      </Card>
    </div>
  );
}

async function AdminContentReadError() {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{t('content.marketingContent')}</h1>
        <p className="mt-1 text-sm text-muted">{t('content.manageTheContentPipelineAnd')}</p>
      </div>
      <ErrorState message={t('content.couldNotLoadMarketingContent')} />
      <Link href="/admin/marketing/content" className="text-sm font-medium text-brand-text underline">{t('content.refreshContent')}</Link>
    </div>
  );
}

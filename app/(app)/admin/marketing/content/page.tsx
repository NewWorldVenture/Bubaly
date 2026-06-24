import type { Metadata } from 'next';
import { FileText, BookOpen, Send } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { BLOG_CATEGORIES } from '@/lib/marketing/blog-publish';
import { createContentItem } from '../actions';
import { updateContentAction, publishContentToBlogAction, unpublishBlogPostAction } from './actions';

export const metadata: Metadata = { title: 'Marketing · Content', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const smCls = 'h-9 w-full rounded-lg border border-border bg-surface/60 px-2 text-sm focus-ring';
const KINDS = ['blog', 'landing', 'social', 'email', 'ad', 'seo_brief', 'aeo_brief'];
const STATUSES = ['idea', 'brief', 'drafting', 'review', 'approved', 'published'];

type BlogMeta = { slug?: string; category?: string; author?: string; excerpt?: string; featured?: boolean; tags?: string[] };

export default async function ContentPage() {
  const supabase = createServiceClient();
  const [{ data: items }, { data: posts }] = await Promise.all([
    supabase.from('marketing_content_items').select('*').is('deleted_at', null).order('publish_at', { ascending: true, nullsFirst: false }),
    supabase.from('blog_posts').select('slug, title, category, published, published_at').order('published_at', { ascending: false }).limit(20),
  ]);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
      <div className="space-y-4">
        <div>
          <h2 className="mb-2 font-semibold">Content pipeline</h2>
          {(items ?? []).length === 0 ? (
            <EmptyState icon={FileText} title="No content planned" description="Add an idea or brief on the right." />
          ) : (
            <div className="space-y-2">
              {(items ?? []).map((it) => {
                const blog = ((it.metadata as Record<string, unknown> | null)?.blog ?? {}) as BlogMeta;
                const isBlog = it.kind === 'blog';
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
                            <input name="tags" defaultValue={(blog.tags ?? []).join(', ')} placeholder="Tags, comma-separated" className={smCls} />
                            <input name="excerpt" defaultValue={blog.excerpt ?? ''} placeholder="Excerpt (auto from body)" className={`${smCls} col-span-2`} />
                            <label className="col-span-2 flex items-center gap-2 text-xs text-muted"><input type="checkbox" name="featured" defaultChecked={blog.featured === true} className="h-4 w-4 accent-[var(--brand)]" /> Featured post</label>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <select name="status" defaultValue={it.status} className={`${smCls} flex-1`}>
                            {STATUSES.map((st) => <option key={st} value={st}>{st}</option>)}
                          </select>
                          <button type="submit" className="h-9 shrink-0 rounded-lg bg-elevated px-4 text-sm font-semibold hover:bg-elevated/80">Save</button>
                        </div>
                      </form>
                      {isBlog && (
                        <form action={publishContentToBlogAction} className="mt-2">
                          <input type="hidden" name="id" value={it.id} />
                          <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90">
                            <Send className="h-3.5 w-3.5" /> Publish to blog
                          </button>
                          <span className="ml-2 text-xs text-muted">Save the body first. Creates/updates the public /blog post.</span>
                        </form>
                      )}
                    </details>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <h2 className="mb-2 flex items-center gap-2 font-semibold"><BookOpen className="h-4 w-4" /> Published blog</h2>
          {(posts ?? []).length === 0 ? (
            <p className="text-sm text-muted">No blog posts yet.</p>
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
                        <button type="submit" className="text-xs text-muted hover:text-rose-400">Unpublish</button>
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
        <h2 className="mb-3 font-semibold">New content idea</h2>
        <form action={createContentItem} className="space-y-3 text-sm">
          <input name="title" required placeholder="Title or topic" className={inputCls} />
          <select name="kind" className={inputCls}>{KINDS.map((k) => <option key={k} value={k}>{k.replace('_', ' ')}</option>)}</select>
          <input name="publish_at" type="date" className={inputCls} />
          <textarea name="brief" rows={4} placeholder="Brief / notes…" className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Add to pipeline</button>
        </form>
        <p className="mt-3 text-xs text-muted">Blog items: write the body, set category/author, then “Publish to blog” to push live at <code>/blog/&lt;slug&gt;</code>.</p>
      </Card>
    </div>
  );
}

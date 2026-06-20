import type { Metadata } from 'next';
import { FileText, BookOpen } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { createContentItem } from '../actions';

export const metadata: Metadata = { title: 'Marketing · Content', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const KINDS = ['blog', 'landing', 'social', 'email', 'ad', 'seo_brief', 'aeo_brief'];

export default async function ContentPage() {
  const supabase = createServiceClient();
  const [{ data: items }, { data: posts }] = await Promise.all([
    supabase.from('marketing_content_items').select('*').is('deleted_at', null).order('publish_at', { ascending: true, nullsFirst: false }),
    supabase.from('blog_posts').select('slug, title, category, published, published_at').order('published_at', { ascending: false }).limit(10),
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
              {(items ?? []).map((it) => (
                <Card key={it.id} className="flex items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{it.title}</p>
                    <p className="text-xs text-muted capitalize">{it.kind.replace('_', ' ')}{it.publish_at ? ` · ${fmtDate(it.publish_at)}` : ''}</p>
                  </div>
                  <Badge tone="neutral" className="capitalize">{it.status}</Badge>
                </Card>
              ))}
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
                    <p className="truncate font-medium">{p.title}</p>
                    <p className="text-xs text-muted">{p.category}{p.published_at ? ` · ${fmtDate(p.published_at)}` : ''}</p>
                  </div>
                  <Badge tone={p.published ? 'success' : 'neutral'}>{p.published ? 'Live' : 'Draft'}</Badge>
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
      </Card>
    </div>
  );
}

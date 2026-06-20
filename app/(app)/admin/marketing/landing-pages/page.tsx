import type { Metadata } from 'next';
import { Layout } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';
import { createLandingPage } from '../actions';

export const metadata: Metadata = { title: 'Marketing · Landing Pages', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';

export default async function LandingPagesPage() {
  const supabase = createServiceClient();
  const { data: pages } = await supabase.from('marketing_landing_pages').select('*').is('deleted_at', null).order('created_at', { ascending: false });

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
              </div>
              <div className="shrink-0 text-right text-xs text-muted">
                <p className="font-semibold text-fg">{p.views}</p> views
                <p className="mt-1">{p.conversions} conv.</p>
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
          <textarea name="body" rows={4} placeholder="Body copy…" className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
          <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Create page</button>
        </form>
      </Card>
    </div>
  );
}

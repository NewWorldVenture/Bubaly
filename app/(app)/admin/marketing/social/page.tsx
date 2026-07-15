import type { Metadata } from 'next';
import Link from 'next/link';
import { Share2 } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { createSocialPost } from '../actions';

export const metadata: Metadata = { title: 'Marketing · Social', robots: { index: false } };
export const dynamic = 'force-dynamic';

const inputCls = 'h-10 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring';
const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'tiktok', 'x', 'youtube'];

export default async function SocialPage() {
  const supabase = createServiceClient();
  const { data: posts, error: postsError } = await supabase.from('marketing_social_posts').select('*').is('deleted_at', null).order('scheduled_at', { ascending: true, nullsFirst: false });
  if (postsError) {
    console.error('[admin-marketing-social] social post read failed', postsError);
    return <AdminSocialReadError />;
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-border bg-surface/30 p-4 text-sm text-muted">
        Plan and schedule posts across platforms. Connect platform APIs to auto-publish; until then, posts are tracked here and published manually — no fake engagement metrics.
      </div>
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-3">
          {(posts ?? []).length === 0 ? (
            <EmptyState icon={Share2} title="No posts planned" description="Draft your first post on the right." />
          ) : (
            (posts ?? []).map((p) => (
              <Card key={p.id} className="space-y-2">
                <div className="flex items-center justify-between">
                  <Badge tone="neutral" className="capitalize">{p.platform}</Badge>
                  <span className="text-xs text-muted">{p.scheduled_at ? fmtDate(p.scheduled_at) : 'Unscheduled'} · {p.status}</span>
                </div>
                <p className="text-sm">{p.content}</p>
                {p.link && <p className="truncate text-xs text-brand-text">{p.link}</p>}
              </Card>
            ))
          )}
        </div>
        <Card className="h-fit">
          <h2 className="mb-3 font-semibold">New post</h2>
          <form action={createSocialPost} className="space-y-3 text-sm">
            <select name="platform" className={inputCls}>{PLATFORMS.map((p) => <option key={p} value={p} className="capitalize">{p}</option>)}</select>
            <textarea name="content" required rows={4} placeholder="Post copy…" className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" />
            <input name="link" placeholder="Link (optional)" className={inputCls} />
            <input name="scheduled_at" type="datetime-local" className={inputCls} />
            <button className="w-full rounded-xl bg-brand px-4 py-2.5 font-semibold text-white hover:bg-brand/90">Add post</button>
          </form>
        </Card>
      </div>
    </div>
  );
}

function AdminSocialReadError() {
  return (
    <div className="module-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Marketing Social</h1>
        <p className="mt-1 text-sm text-muted">Plan and schedule social posts across supported platforms.</p>
      </div>
      <ErrorState message="Could not load marketing social posts from Supabase. Refresh and try again." />
      <Link href="/admin/marketing/social" className="text-sm font-medium text-brand-text underline">Refresh social posts</Link>
    </div>
  );
}

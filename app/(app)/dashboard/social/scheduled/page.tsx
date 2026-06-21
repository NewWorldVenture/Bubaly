import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { getPosts } from '@/lib/social/queries';
import { PostsList, PostTabs } from '@/components/social/posts-list';

export const metadata: Metadata = { title: 'Scheduled · Social' };
export const dynamic = 'force-dynamic';

export default async function ScheduledPage() {
  const ctx = await requireUserContext();
  const posts = await getPosts(ctx.active.familyId, ['scheduled']);
  return (
    <div className="space-y-4">
      <PostTabs active="/dashboard/social/scheduled" />
      <PostsList posts={posts} emptyLabel="Nothing scheduled" />
    </div>
  );
}

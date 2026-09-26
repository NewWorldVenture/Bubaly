import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { getPosts } from '@/lib/social/queries';
import { PostsList, PostTabs } from '@/components/social/posts-list';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('pageTitle.scheduled')} · ${t('pageTitle.social')}` };
}
export const dynamic = 'force-dynamic';

export default async function ScheduledPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const posts = await getPosts(ctx.active.familyId, ['scheduled']);
  return (
    <div className="space-y-4">
      <PostTabs active="/dashboard/social/scheduled" />
      <PostsList posts={posts} emptyLabel={t('scheduled.nothingScheduled')} />
    </div>
  );
}

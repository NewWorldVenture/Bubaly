import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { getPosts } from '@/lib/social/queries';
import { PostsList, PostTabs } from '@/components/social/posts-list';

export const metadata: Metadata = { title: 'Published · Social' };
export const dynamic = 'force-dynamic';

export default async function PublishedPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const posts = await getPosts(ctx.active.familyId, ['published', 'partially_published']);
  return (
    <div className="space-y-4">
      <PostTabs active="/dashboard/social/published" />
      <PostsList posts={posts} emptyLabel={t('published.nothingPublishedYet')} />
    </div>
  );
}

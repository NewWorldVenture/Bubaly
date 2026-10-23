import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireSocialPage } from '@/lib/social/access';
import { SOCIAL_SURFACES } from '@/lib/social/roles';
import { getPosts } from '@/lib/social/queries';
import { PostsList, PostTabs } from '@/components/social/posts-list';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('adminBenchmarks.published')} · ${t('pageTitle.social')}` };
}
export const dynamic = 'force-dynamic';

export default async function PublishedPage() {
  const t = await getTranslations();
  // What went out is the pipeline's, and an analyst's too.
  const { ctx } = await requireSocialPage(SOCIAL_SURFACES.published);
  const posts = await getPosts(ctx.active.familyId, ['published', 'partially_published']);
  return (
    <div className="space-y-4">
      <PostTabs active="/dashboard/social/published" />
      <PostsList posts={posts} emptyLabel={t('published.nothingPublishedYet')} />
    </div>
  );
}

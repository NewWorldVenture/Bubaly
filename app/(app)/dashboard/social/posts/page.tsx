import type { Metadata } from 'next';
import Link from 'next/link';
import { PenSquare } from 'lucide-react';
import { requireSocialPage } from '@/lib/social/access';
import { SOCIAL_SURFACES } from '@/lib/social/roles';
import { getPosts } from '@/lib/social/queries';
import { PostsList, PostTabs } from '@/components/social/posts-list';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('pageTitle.posts')} · ${t('pageTitle.social')}` };
}
export const dynamic = 'force-dynamic';

export default async function SocialPostsPage() {
  const t = await getTranslations();
  // Drafts and the queue are the pipeline's: a read_only role is sent to the feed.
  const { ctx, access } = await requireSocialPage(SOCIAL_SURFACES.pipeline);
  const posts = await getPosts(ctx.active.familyId);
  const canCompose = SOCIAL_SURFACES.compose.some((p) => access.can(p));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <PostTabs active="/dashboard/social/posts" />
        {canCompose && (
          <Link href="/dashboard/social/content-studio/new" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg">
            <PenSquare className="h-4 w-4" /> {t('dashboardSocialPosts.newPost')}
          </Link>
        )}
      </div>
      <PostsList posts={posts} />
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';
import { PenSquare } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { getPosts } from '@/lib/social/queries';
import { PostsList, PostTabs } from '@/components/social/posts-list';

export const metadata: Metadata = { title: 'Posts · Social' };
export const dynamic = 'force-dynamic';

export default async function SocialPostsPage() {
  const ctx = await requireUserContext();
  const posts = await getPosts(ctx.active.familyId);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <PostTabs active="/dashboard/social/posts" />
        <Link href="/dashboard/social/content-studio/new" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg">
          <PenSquare className="h-4 w-4" /> New post
        </Link>
      </div>
      <PostsList posts={posts} />
    </div>
  );
}

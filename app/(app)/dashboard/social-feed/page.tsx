import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { SocialFeedModule, type FeedSource, type FeedItem } from '@/components/modules/social-feed-module';
import { ErrorState } from '@/components/ui/states';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.socialFeed') };
}
export const dynamic = 'force-dynamic';

export default async function SocialFeedPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  const [sourcesRead, itemsRead] = await settleAll([
    supabase.from('social_reader_sources')
      .select('id, platform, display_name, handle, account_count, category, is_active')
      .eq('family_id', familyId).eq('is_active', true).order('sort_order').order('created_at'),
    supabase.from('social_reader_items')
      .select('id, source_id, platform, author_name, author_handle, avatar_url, content, media_urls, thumbnail_url, permalink, kind, duration_label, category, verified, is_favorite, is_read, posted_at')
      .eq('family_id', familyId).order('posted_at', { ascending: false }).limit(200),
  ]);

  // A read that failed is not an empty feed. Both lists used to fall back to
  // [] on any error, and the module then said "Your feed is empty — Add your
  // first source", inviting the family to reconnect sources they already have.
  if (sourcesRead.error || itemsRead.error) {
    if (sourcesRead.error) console.error('[social-feed] sources read failed', sourcesRead.error);
    if (itemsRead.error) console.error('[social-feed] items read failed', itemsRead.error);
    const t = await getTranslations();
    return (
      <div className="module-page space-y-3 text-center">
        <ErrorState message={t('socialFeed.couldNotLoadYourFeed')} />
        <Link href="/dashboard/social-feed" className="text-sm font-medium underline">{t('states.tryAgain')}</Link>
      </div>
    );
  }
  const sources = sourcesRead.data;
  const items = itemsRead.data;

  const feedSources: FeedSource[] = (sources ?? []).map((s) => ({
    id: s.id, platform: s.platform, displayName: s.display_name, handle: s.handle,
    accountCount: s.account_count, category: s.category,
  }));
  const feedItems: FeedItem[] = (items ?? []).map((i) => ({
    id: i.id, platform: i.platform, authorName: i.author_name, authorHandle: i.author_handle,
    avatarUrl: i.avatar_url, content: i.content, mediaUrls: i.media_urls ?? [], thumbnailUrl: i.thumbnail_url,
    permalink: i.permalink, kind: i.kind, durationLabel: i.duration_label, category: i.category,
    verified: i.verified, isFavorite: i.is_favorite, isRead: i.is_read, postedAt: i.posted_at,
  }));

  return <SocialFeedModule sources={feedSources} items={feedItems} />;
}

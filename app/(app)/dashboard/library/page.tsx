import type { Metadata } from 'next';
import { Library, Rss, BookOpen, CircleAlert } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { fmtDate } from '@/lib/utils/format';
import { AddBookForm, FeedControls, ItemRow, SubscribeForm, type PlayableItem } from './player';

export const metadata: Metadata = { title: 'Library' };
export const dynamic = 'force-dynamic';

const ITEM_LIMIT = 200;

type FeedRow = {
  id: string; kind: string; title: string; feed_url: string; author: string | null;
  last_fetched_at: string | null; last_error: string | null;
};
type ItemRowData = {
  id: string; feed_id: string | null; kind: string; title: string; author: string | null;
  media_url: string | null; page_url: string | null; duration_seconds: number | null; published_at: string | null;
};
type ProgressRow = {
  item_id: string; position_seconds: number; saved: boolean; offline: boolean; completed_at: string | null;
};

export default async function LibraryPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const [feedsResult, itemsResult, progressResult] = await Promise.all([
    supabase.from('library_feeds')
      .select('id, kind, title, feed_url, author, last_fetched_at, last_error')
      .eq('family_id', ctx.active.familyId).order('title'),
    supabase.from('library_items')
      .select('id, feed_id, kind, title, author, media_url, page_url, duration_seconds, published_at')
      .eq('family_id', ctx.active.familyId)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(ITEM_LIMIT),
    // RLS restricts this to the caller's own rows, so "where I got to" is never
    // another member's place.
    supabase.from('library_progress')
      .select('item_id, position_seconds, saved, offline, completed_at')
      .eq('family_id', ctx.active.familyId).eq('user_id', ctx.user.id),
  ]);

  const readError = feedsResult.error ?? itemsResult.error;
  if (readError) {
    // "Refresh and try again" is only true for a database that HAS these tables.
    // 0284 is applied by a person, not by the deploy, so between the two this
    // page is reachable from the sidebar with nothing behind it — and telling
    // someone to refresh sends them round a loop that cannot end. Say which of
    // the two it is.
    if (isMissingRelationError(readError)) {
      return (
        <EmptyState
          icon={Library}
          title="The family library isn't switched on yet"
          description="It needs database migration 0284_library_books_podcasts.sql. Once an administrator applies it, podcasts and books work here — nothing else is needed."
        />
      );
    }
    console.error('[library] read failed', readError);
    return <ErrorState message="Your library could not be read. Refresh and try again." />;
  }
  if (progressResult.error) {
    // Not fatal: without it the list still plays, it just starts from the top.
    console.error('[library] progress read failed', progressResult.error);
  }

  const feeds = (feedsResult.data ?? []) as unknown as FeedRow[];
  const items = (itemsResult.data ?? []) as unknown as ItemRowData[];
  const progress = new Map(
    ((progressResult.data ?? []) as unknown as ProgressRow[]).map((row) => [row.item_id, row]),
  );

  const playable = (row: ItemRowData): PlayableItem => {
    const mine = progress.get(row.id);
    return {
      id: row.id, title: row.title, author: row.author,
      mediaUrl: row.media_url, pageUrl: row.page_url,
      durationSeconds: row.duration_seconds,
      positionSeconds: mine?.position_seconds ?? 0,
      saved: mine?.saved ?? false,
      offline: mine?.offline ?? false,
      completed: Boolean(mine?.completed_at),
    };
  };

  const savedItems = items.filter((row) => progress.get(row.id)?.saved);
  const inProgress = items.filter((row) => {
    const mine = progress.get(row.id);
    return mine && mine.position_seconds > 0 && !mine.completed_at;
  });
  const books = items.filter((row) => row.kind === 'book');
  const episodes = items.filter((row) => row.kind === 'episode');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Library</h1>
        <p className="mt-1 text-sm text-muted">
          Podcasts and audiobooks the family follows. Stream them here, keep your place, save the ones worth
          keeping, and store what you want for offline.
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {inProgress.length > 0 && (
            <Card>
              <h2 className="mb-2 font-semibold">Carry on</h2>
              <ul className="space-y-2">{inProgress.slice(0, 5).map((row) => <ItemRow key={row.id} item={playable(row)} />)}</ul>
            </Card>
          )}

          {savedItems.length > 0 && (
            <Card>
              <h2 className="mb-2 font-semibold">Saved</h2>
              <ul className="space-y-2">{savedItems.slice(0, 20).map((row) => <ItemRow key={row.id} item={playable(row)} />)}</ul>
            </Card>
          )}

          <Card>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Episodes</h2>
              <Badge tone="neutral">{episodes.length}</Badge>
            </div>
            {episodes.length === 0 ? (
              <EmptyState icon={Rss} title="Nothing yet"
                description="Subscribe to a podcast feed on the right and its episodes appear here." />
            ) : (
              <ul className="space-y-2">{episodes.slice(0, 40).map((row) => <ItemRow key={row.id} item={playable(row)} />)}</ul>
            )}
          </Card>

          <Card>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Books</h2>
              <Badge tone="neutral">{books.length}</Badge>
            </div>
            {books.length === 0 ? (
              <EmptyState icon={BookOpen} title="No books yet"
                description="Add one on the right — a title alone is enough, and you can attach a link or an audio file." />
            ) : (
              <ul className="space-y-2">{books.map((row) => <ItemRow key={row.id} item={playable(row)} />)}</ul>
            )}
          </Card>

          {feeds.length > 0 && (
            <Card>
              <h2 className="mb-2 font-semibold">Subscriptions</h2>
              <ul className="space-y-2">
                {feeds.map((feed) => (
                  <li key={feed.id} className="rounded-2xl border border-border bg-surface/40 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{feed.title}</p>
                        <p className="truncate text-xs text-muted">
                          {feed.kind === 'book' ? 'Audiobook' : 'Podcast'}
                          {feed.last_fetched_at ? ` · refreshed ${fmtDate(feed.last_fetched_at)}` : ' · never refreshed'}
                        </p>
                      </div>
                      <FeedControls id={feed.id} />
                    </div>
                    {feed.last_error && (
                      <p className="mt-1.5 flex items-start gap-1.5 text-xs text-warning">
                        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                        {feed.last_error}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {feeds.length === 0 && items.length === 0 && (
            <EmptyState icon={Library} title="Your library is empty"
              description="Subscribe to a feed or add a book to get started." />
          )}
        </div>

        <div className="space-y-4">
          <Card className="h-fit">
            <h2 className="mb-3 font-semibold">Follow a feed</h2>
            <SubscribeForm />
          </Card>
          <Card className="h-fit">
            <h2 className="mb-3 font-semibold">Add a book</h2>
            <AddBookForm />
          </Card>
          <Card className="space-y-2">
            <h2 className="font-semibold">How this works</h2>
            <ul className="space-y-1.5 text-xs text-muted">
              <li>Bubaly stores the listing and your place — never the audio itself.</li>
              <li>Playback streams from the publisher, the same as any podcast app.</li>
              <li>Offline uses your browser&apos;s own storage, and the list says whether a file really is there.</li>
              <li>Your place is yours: the family shares a subscription, not a bookmark.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

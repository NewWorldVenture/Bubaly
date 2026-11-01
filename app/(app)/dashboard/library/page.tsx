import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { Library, Rss, BookOpen, CircleAlert } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { fmtDate } from '@/lib/utils/format';
import { AddBookForm, FeedControls, ItemRow, SubscribeForm, type PlayableItem } from './player';
import { settleAll } from '@/lib/supabase/settle';
import { readAllAsQuery } from '@/lib/supabase/read-all';
import { isManager } from '@/lib/constants/roles';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.library') };
}
export const dynamic = 'force-dynamic';

/**
 * Episodes and books are read SEPARATELY, each with its own count. One read of
 * 200 items, newest `published_at` first with nulls last, was filled by any
 * podcast with 200 episodes — and a book added by hand has no `published_at`,
 * so every book fell off the end: "No books yet", and gone from Saved and Carry
 * on, which were cut from the same list. The episode list is the newest few;
 * the badge says how many there are.
 */
const EPISODES_SHOWN = 40;
const BOOKS_SHOWN = 300;
/** A person's places, read whole: past this many the read fails, not cuts. */
const PROGRESS_MAX = 20_000;
const ITEM_COLUMNS = 'id, feed_id, kind, title, author, media_url, page_url, duration_seconds, published_at';

type FeedRow = {
  id: string; kind: string; title: string; feed_url: string; author: string | null;
  last_fetched_at: string | null; last_error: string | null;
};
type ItemRowData = {
  id: string; feed_id: string | null; kind: string; title: string; author: string | null;
  media_url: string | null; page_url: string | null; duration_seconds: number | null; published_at: string | null;
};
type ProgressRow = {
  id: string; item_id: string; position_seconds: number; saved: boolean; offline: boolean; completed_at: string | null;
  /** The item itself, so Saved and Carry on hold what this person saved, wherever it sorts. */
  item: ItemRowData | null;
};
type ItemsRead = { data: ItemRowData[] | null; count: number | null; error: { message: string } | null };

export default async function LibraryPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  // Subscribing and attaching an audio or video address put content in every
  // child's library and behind Bubaly's own media route, so they are the
  // adults' to do (the actions refuse anyone else).
  const canCurate = isManager(ctx.active.role);

  const [feedsResult, episodesResult, booksResult, progressResult] = await settleAll([
    supabase.from('library_feeds')
      .select('id, kind, title, feed_url, author, last_fetched_at, last_error')
      .eq('family_id', familyId).order('title'),
    supabase.from('library_items')
      .select(ITEM_COLUMNS, { count: 'exact' })
      .eq('family_id', familyId).eq('kind', 'episode')
      .order('published_at', { ascending: false, nullsFirst: false }).order('id')
      .limit(EPISODES_SHOWN) as unknown as PromiseLike<ItemsRead>,
    supabase.from('library_items')
      .select(ITEM_COLUMNS, { count: 'exact' })
      .eq('family_id', familyId).eq('kind', 'book')
      .order('created_at', { ascending: false }).order('id')
      .limit(BOOKS_SHOWN) as unknown as PromiseLike<ItemsRead>,
    // RLS restricts this to the caller's own rows, so "where I got to" is never
    // another member's place.
    readAllAsQuery<ProgressRow>((from, to) => supabase.from('library_progress')
      .select(`id, item_id, position_seconds, saved, offline, completed_at, updated_at, item:library_items(${ITEM_COLUMNS})`)
      .eq('family_id', familyId).eq('user_id', ctx.user.id)
      .order('updated_at', { ascending: false }).order('id')
      .range(from, to) as unknown as PromiseLike<{ data: ProgressRow[] | null; error: { message: string } | null }>,
    { max: PROGRESS_MAX }),
  ]);

  const readError = feedsResult.error ?? episodesResult.error ?? booksResult.error;
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
  // Not fatal: the list still plays. But every item would read as unstarted,
  // and the first pause or fifteen seconds of playback would write a position
  // over the one the person really has — so the page says so, and the rows do
  // not save a position until a read has succeeded (`progressUnknown`).
  const progressUnknown = Boolean(progressResult.error);
  if (progressUnknown) console.error('[library] progress read failed', progressResult.error);

  const feeds = (feedsResult.data ?? []) as unknown as FeedRow[];
  const episodes = episodesResult.data ?? [];
  const books = booksResult.data ?? [];
  const episodeTotal = Math.max(episodesResult.count ?? 0, episodes.length);
  const bookTotal = Math.max(booksResult.count ?? 0, books.length);
  const progressRows = progressResult.data ?? [];
  const progress = new Map(progressRows.map((row) => [row.item_id, row]));

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
      progressUnknown,
    };
  };

  // From this person's own places, most recently touched first — not from a
  // capped list of the family's items, where a saved book could be missing.
  const savedItems = progressRows.filter((row) => row.saved && row.item).map((row) => row.item as ItemRowData);
  const inProgress = progressRows
    .filter((row) => row.item && row.position_seconds > 0 && !row.completed_at)
    .map((row) => row.item as ItemRowData);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Library</h1>
        <p className="mt-1 text-sm text-muted">
          Podcasts and audiobooks the family follows. Stream them here, keep your place, save the ones worth
          keeping, and store what you want for offline.
        </p>
      </div>

      {progressUnknown && (
        <p role="status" className="flex items-start gap-1.5 rounded-2xl border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {t('library.placeCouldNotBeLoaded')}
        </p>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
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
              <Badge tone="neutral">{episodeTotal}</Badge>
            </div>
            {episodes.length === 0 ? (
              <EmptyState icon={Rss} title="Nothing yet"
                description="Subscribe to a podcast feed on the right and its episodes appear here." />
            ) : (
              <>
                <ul className="space-y-2">{episodes.map((row) => <ItemRow key={row.id} item={playable(row)} />)}</ul>
                {episodeTotal > episodes.length && (
                  <p className="mt-2 text-xs text-muted">{t('library.showingNewestEpisodes', { shown: episodes.length, total: episodeTotal })}</p>
                )}
              </>
            )}
          </Card>

          <Card>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Books</h2>
              <Badge tone="neutral">{bookTotal}</Badge>
            </div>
            {books.length === 0 ? (
              <EmptyState icon={BookOpen} title="No books yet"
                description="Add one on the right — a title alone is enough, and you can attach a link or an audio file." />
            ) : (
              <>
                <ul className="space-y-2">{books.map((row) => <ItemRow key={row.id} item={playable(row)} />)}</ul>
                {bookTotal > books.length && (
                  <p className="mt-2 text-xs text-muted">{t('library.showingNewestBooks', { shown: books.length, total: bookTotal })}</p>
                )}
              </>
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
                      <FeedControls id={feed.id} canRemove={canCurate} canRefresh={ctx.active.role !== 'guest'} />
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

          {feeds.length === 0 && episodeTotal === 0 && bookTotal === 0 && (
            <EmptyState icon={Library} title="Your library is empty"
              description="Subscribe to a feed or add a book to get started." />
          )}
        </div>

        <div className="space-y-4">
          {canCurate && (
            <Card className="h-fit">
              <h2 className="mb-3 font-semibold">Follow a feed</h2>
              <SubscribeForm />
            </Card>
          )}
          <Card className="h-fit">
            <h2 className="mb-3 font-semibold">Add a book</h2>
            <AddBookForm allowMedia={canCurate} />
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

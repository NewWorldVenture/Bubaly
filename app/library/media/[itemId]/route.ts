// GET /library/media/[itemId] — one episode, served from Bubaly's own origin.
//
// NOT under /api, deliberately. `public/sw.js` returns early for anything under
// /api or /auth (the M-023 privacy invariant: authenticated API responses must
// never reach Cache Storage), so a media route there could never be cached and
// "Download for offline" would still not work. This path is outside that rule
// and carries nothing but publisher bytes the family already subscribed to —
// no family data, nothing personal, nothing that outlives a logout in a way
// that matters.
//
// The URL is never taken from the request: the caller names an ITEM, and the
// row is read with the user's own client so RLS decides whether they may have
// it. What gets fetched is that row's media_url. So the reachable set is the
// family's own subscriptions rather than the whole internet — and the address
// guard in lib/server/public-media-fetch.ts checks where that resolves to
// anyway, on every hop.
import { NextRequest, NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { requireUserContext } from '@/lib/supabase/auth';
import { rateLimit } from '@/lib/server/rate-limit';
import { createServer } from '@/lib/supabase/server';
import { openPublicMedia } from '@/lib/server/public-media-fetch';
import { PublicDocumentError } from '@/lib/server/public-document-fetch';
import { LIBRARY_MEDIA_CACHE_CONTROL } from '@/lib/library/progress';
import { addedByAnAdult, readCurators } from '@/lib/library/curator';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

const isYoung = (role: string) => role === 'child' || role === 'teen';

export async function GET(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  if (!itemId) return new NextResponse('Not found', { status: 404 });

  const ctx = await requireUserContext();
  // Per USER, because this is our egress paid on their behalf: one signed-in
  // person should not be able to pull a 500 MB episode in a loop. Generous
  // enough for real playback — a player asks for a handful of byte ranges when
  // it seeks — and far short of what
  // a script does.
  const limited = rateLimit(`library-media:${ctx.user.id}`, { limit: 60, windowMs: 60_000 });
  if (!limited.ok) {
    return new NextResponse('Too many requests', {
      status: 429, headers: { 'Retry-After': String(limited.retryAfter) },
    });
  }
  const supabase = await createServer();

  // The user's client, not the service client: RLS is what decides whether this
  // person may read this item, and asking it is the whole authorization story.
  const { data, error } = await supabase
    .from('library_items')
    .select('media_url, feed_id, created_by, feed:library_feeds(created_by)')
    .eq('id', itemId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  if (error) {
    console.error('[library-media] item read failed', error);
    return new NextResponse('Unavailable', { status: 503 });
  }
  const item = data as { media_url: string | null; feed_id: string | null; created_by: string | null; feed: { created_by: string | null } | { created_by: string | null }[] | null } | null;
  const mediaUrl = item?.media_url;
  if (!item || !mediaUrl) return new NextResponse('Not found', { status: 404 });

  // Streamed from Bubaly's origin to every member, so only what one of the
  // family's adults put here (lib/library/curator.ts): a book's audio address
  // by whoever added the book, an episode by whoever subscribed to its feed.
  // RLS lets any member write these rows over PostgREST; the actions are not
  // the only way in, so the fetch asks as well.
  const feed = Array.isArray(item.feed) ? item.feed[0] ?? null : item.feed;
  const addedBy = item.feed_id ? feed?.created_by ?? null : item.created_by;
  // An empty writer is let through for a FEED's episode: 0284 nulls a feed's
  // created_by when its subscriber's account is deleted, and that feed keeps
  // its episodes (S20). A book typed in by hand has no such reason to name
  // nobody. addBookAction always records its adder, and created_by has no
  // default, so a PostgREST insert that just leaves the column out played any
  // address to every member. A book whose adder's account has since gone goes
  // quiet with it; a parent can add it again.
  if (!item.feed_id && !addedBy) return new NextResponse('Forbidden', { status: 403 });
  const curated = await readCurators(supabase, [ctx.active.familyId], [addedBy]);
  if (!curated.ok) {
    console.error('[library-media] curator read failed', curated.error);
    return new NextResponse('Unavailable', { status: 503 });
  }
  if (!addedByAnAdult(curated, ctx.active.familyId, addedBy)) {
    return new NextResponse('Forbidden', { status: 403 });
  }

  try {
    const upstream = await openPublicMedia(mediaUrl, {
      range: req.headers.get('range'),
      signal: req.signal,
    });
    // Not video for a child or a teen. The library is podcasts and audiobooks,
    // its player is an <audio> element, and a media address is anything a
    // member typed — so this route, served from Bubaly's own origin, would
    // otherwise play any public video to a child straight past the filter a
    // parent set on the device for the video's real host. Only what the
    // publisher names as audio: an `application/octet-stream` body is whatever
    // bytes it is, and a browser's media player sniffs a video out of it.
    if (isYoung(ctx.active.role) && !(upstream.headers['content-type'] ?? '').startsWith('audio/')) {
      upstream.close();
      return new NextResponse('Unsupported', { status: 415 });
    }
    // Node stream -> Web stream, and close the socket if the client walks away
    // mid-episode. Without this an abandoned tab holds a publisher connection
    // open until the deadline.
    req.signal.addEventListener('abort', upstream.close, { once: true });
    const body = Readable.toWeb(upstream.body) as unknown as WebReadableStream<Uint8Array>;
    return new NextResponse(body as unknown as BodyInit, {
      status: upstream.status,
      headers: {
        ...upstream.headers,
        // Kept by no cache at all. A shared one would serve one family's
        // request to the next; the browser's own would serve one READER's to
        // the next on the same browser — an adult's video to a child, past the
        // refusal above (see LIBRARY_MEDIA_CACHE_CONTROL).
        'Cache-Control': LIBRARY_MEDIA_CACHE_CONTROL,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (caught) {
    const reason = caught instanceof PublicDocumentError ? caught.message : 'unavailable';
    console.error('[library-media] upstream fetch failed', reason);
    return new NextResponse('Unavailable', { status: reason === 'unsupported' || reason === 'blocked' ? 415 : 502 });
  }
}

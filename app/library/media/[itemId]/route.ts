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

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await params;
  if (!itemId) return new NextResponse('Not found', { status: 404 });

  const ctx = await requireUserContext();
  // Per USER, because this is our egress paid on their behalf: one signed-in
  // person should not be able to pull a 500 MB episode in a loop. Generous
  // enough for real playback — a player asks for a handful of byte ranges when
  // it seeks, and the response is cacheable for an hour — and far short of what
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
    .select('media_url')
    .eq('id', itemId)
    .eq('family_id', ctx.active.familyId)
    .maybeSingle();

  if (error) {
    console.error('[library-media] item read failed', error);
    return new NextResponse('Unavailable', { status: 503 });
  }
  const mediaUrl = (data as { media_url: string | null } | null)?.media_url;
  if (!mediaUrl) return new NextResponse('Not found', { status: 404 });

  try {
    const upstream = await openPublicMedia(mediaUrl, {
      range: req.headers.get('range'),
      signal: req.signal,
    });
    // Node stream -> Web stream, and close the socket if the client walks away
    // mid-episode. Without this an abandoned tab holds a publisher connection
    // open until the deadline.
    req.signal.addEventListener('abort', upstream.close, { once: true });
    const body = Readable.toWeb(upstream.body) as unknown as WebReadableStream<Uint8Array>;
    return new NextResponse(body as unknown as BodyInit, {
      status: upstream.status,
      headers: {
        ...upstream.headers,
        // Bubaly's own cache, not a shared one: the bytes are public but the
        // URL is behind a session, and a shared cache keyed on it would serve
        // one family's request to the next.
        'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (caught) {
    const reason = caught instanceof PublicDocumentError ? caught.message : 'unavailable';
    console.error('[library-media] upstream fetch failed', reason);
    return new NextResponse('Unavailable', { status: reason === 'unsupported' || reason === 'blocked' ? 415 : 502 });
  }
}

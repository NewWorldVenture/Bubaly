import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { normalizeSlug, normalizeVisitorId } from '@/lib/blog/engagement';
import { carriedVisitorId, namesAnotherVisitor } from '@/lib/marketing/visitor-cookie';

export const runtime = 'nodejs';

// Public blog ♥ endpoint. Anonymous but not unbounded: keyed by the durable
// bubaly_vid visitor id with one like per (post, visitor) enforced by a DB
// unique constraint, service-role writes only (no client table access), and
// IP rate limiting. GET returns { liked, count }; POST toggles and returns
// the new state.
//
// WHICH visitor's ♥ is read or toggled comes from the `bubaly_vid` cookie the
// request already carries, never from a parameter the caller chooses (SEC-008).
// blog_post_likes has RLS on and no policies, so this handler is the boundary.
// GET used to take `visitorId` from the query string — a one-bit read of whether
// any named visitor had liked a post, with the id travelling in a URL — and POST
// took it from the body, so a caller could add or remove another visitor's ♥.
//
// Same binding and the same stated limit as /api/mkt/consent (SEC-006) and
// /api/mkt/track (SEC-007), through lib/marketing/visitor-cookie.ts: the cookie
// is the same bearer bytes, so this closes a caller naming a record other than
// the one its own browser carries, and the id riding in a URL — not a holder of
// the id presenting it. A request that still names an id is accepted only when
// it IS the cookie; any other is refused, 403 — with or without a cookie of its
// own — before any post or ♥ is read or written. (On POST the per-IP rate limit
// runs first, as on the sibling routes, so the refusal is throttled too; that
// touches only the rate-limit counter, never a visitor's row.) A POST that names
// no one and carries no usable cookie has no ♥ to toggle: 400.
//
// Nothing in the app calls this route any more (the heart moved to the signed-in
// /api/blog/save, migration 0227); it stays reachable, so it stays bound.

const MAX_BODY_BYTES = 2_048;

async function loadPostId(supabase: ReturnType<typeof createServiceClient>, slug: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('blog_posts')
    .select('id')
    .eq('slug', slug)
    .eq('published', true)
    .maybeSingle();
  // A refused read returned null, and both callers answer that with a 404 for
  // a post that is published and present. Nothing here can distinguish them
  // afterwards, so the distinction is made where it exists. Audit C1-S9-43.
  if (error) {
    console.error('[blog] post lookup failed', { slug, error: error.message });
    return null;
  }
  return data?.id ?? null;
}

async function likeState(supabase: ReturnType<typeof createServiceClient>, postId: string, visitorId: string | null) {
  const [{ count }, liked] = await Promise.all([
    settle(supabase.from('blog_post_likes').select('id', { count: 'exact', head: true }).eq('post_id', postId)),
    visitorId
      ? supabase.from('blog_post_likes').select('id').eq('post_id', postId).eq('visitor_id', visitorId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return { count: count ?? 0, liked: !!(liked as { data: unknown }).data };
}

export async function GET(req: NextRequest) {
  const t = await getTranslations();
  const slug = normalizeSlug(req.nextUrl.searchParams.get('slug'));
  if (!slug) return NextResponse.json({ error: t('like.invalidSlug') }, { status: 400 });
  // A visitor-less GET still gets the public count with `liked: false`, as it
  // always did — this browser has no ♥ to report. Naming an id it does not
  // carry is refused rather than answered.
  const carried = carriedVisitorId(req);
  if (namesAnotherVisitor(req.nextUrl.searchParams.get('visitorId'), carried)) {
    return NextResponse.json({ error: t('like.notThisVisitor') }, { status: 403 });
  }
  const visitorId = normalizeVisitorId(carried);

  const supabase = createServiceClient();
  const postId = await loadPostId(supabase, slug);
  if (!postId) return NextResponse.json({ error: t('like.notFound') }, { status: 404 });

  const state = await likeState(supabase, postId, visitorId);
  return NextResponse.json(state, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `bloglike:${ip}`, { limit: 60 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: t('like.tooManyRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const parsed = await readBoundedRequestJson(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.reason === 'too_large' ? 'Request body too large.' : 'Bad payload' },
      { status: parsed.reason === 'too_large' ? 413 : 400 },
    );
  }
  const body = (parsed.value && typeof parsed.value === 'object' ? parsed.value : {}) as { slug?: unknown; visitorId?: unknown };

  // A toggle needs a visitor to hold the ♥, and the only one this request can
  // speak for is the one its cookie names. Naming anyone else is checked FIRST,
  // so it is the same 403 whether or not the caller carries a cookie — as GET
  // answers — rather than a 400 that depends on the caller's own cookie jar.
  const carried = carriedVisitorId(req);
  if (namesAnotherVisitor(body.visitorId, carried)) {
    return NextResponse.json({ error: t('like.notThisVisitor') }, { status: 403 });
  }
  const visitorId = normalizeVisitorId(carried);
  if (!visitorId) return NextResponse.json({ error: t('like.visitorCookieRequired') }, { status: 400 });

  const slug = normalizeSlug(body.slug);
  if (!slug) return NextResponse.json({ error: t('like.invalidSlug') }, { status: 400 });

  const postId = await loadPostId(supabase, slug);
  if (!postId) return NextResponse.json({ error: t('like.notFound') }, { status: 404 });

  // Toggle: insert wins the ♥; a unique-violation means it existed → remove it.
  const { error: insertError } = await supabase
    .from('blog_post_likes')
    .insert({ post_id: postId, visitor_id: visitorId });
  if (insertError) {
    if (insertError.code === '23505') {
      // Rows deliberately not checked: the state returned below is RE-READ, so
      // the visitor is never told anything the table does not say. But the
      // result was discarded whole, error included, so a delete that kept
      // failing showed only as a heart that would not un-fill. Logged now.
      // Audit C1-S9-62.
      const { error: unlikeError } = await supabase.from('blog_post_likes').delete().eq('post_id', postId).eq('visitor_id', visitorId);
      if (unlikeError) console.error('[blog/like] unlike failed', { postId, error: unlikeError.message });
    } else {
      return NextResponse.json({ error: t('like.couldNotRecordTheLike') }, { status: 500 });
    }
  }

  const state = await likeState(supabase, postId, visitorId);
  return NextResponse.json(state, { headers: { 'Cache-Control': 'no-store' } });
}

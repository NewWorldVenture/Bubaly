import { NextRequest, NextResponse } from 'next/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { normalizeSlug, normalizeVisitorId } from '@/lib/blog/engagement';

export const runtime = 'nodejs';

// Blog ♥ endpoint. Saving a like now REQUIRES a signed-in account: POST rejects
// unauthenticated callers with 401 { error: 'auth_required' } so the client can
// send them to sign in. A like is keyed to the caller's user id (one per
// post+user, enforced by a DB unique index), written service-role only (no
// client table access), and IP rate limited. GET is public: it returns the
// total { count }, whether the current signed-in user has liked ({ liked }),
// and whether there's a session at all ({ signedIn }). Legacy anonymous rows
// (visitor-keyed, user_id NULL) still count toward the public total.

const MAX_BODY_BYTES = 2_048;

type ServiceClient = ReturnType<typeof createServiceClient>;

async function currentUserId(): Promise<string | null> {
  try {
    const supabase = await createServer();
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}

async function loadPostId(supabase: ServiceClient, slug: string): Promise<string | null> {
  const { data } = await supabase
    .from('blog_posts')
    .select('id')
    .eq('slug', slug)
    .eq('published', true)
    .maybeSingle();
  return data?.id ?? null;
}

async function likeState(supabase: ServiceClient, postId: string, userId: string | null) {
  const [{ count }, liked] = await Promise.all([
    supabase.from('blog_post_likes').select('id', { count: 'exact', head: true }).eq('post_id', postId),
    userId
      ? supabase.from('blog_post_likes').select('id').eq('post_id', postId).eq('user_id', userId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return { count: count ?? 0, liked: !!(liked as { data: unknown }).data };
}

export async function GET(req: NextRequest) {
  const slug = normalizeSlug(req.nextUrl.searchParams.get('slug'));
  if (!slug) return NextResponse.json({ error: 'Invalid slug' }, { status: 400 });

  const supabase = createServiceClient();
  const postId = await loadPostId(supabase, slug);
  if (!postId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const userId = await currentUserId();
  const state = await likeState(supabase, postId, userId);
  return NextResponse.json(
    { ...state, signedIn: !!userId },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `bloglike:${ip}`, { limit: 60 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  // Saving a like requires an account — this is the sign-in gate.
  const userId = await currentUserId();
  if (!userId) {
    return NextResponse.json(
      { error: 'auth_required', message: 'Sign in to save this article.' },
      { status: 401 },
    );
  }

  const parsed = await readBoundedRequestJson(req, MAX_BODY_BYTES);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: parsed.reason === 'too_large' ? 'Request body too large.' : 'Bad payload' },
      { status: parsed.reason === 'too_large' ? 413 : 400 },
    );
  }
  const body = (parsed.value && typeof parsed.value === 'object' ? parsed.value : {}) as {
    slug?: unknown;
    visitorId?: unknown;
  };

  const slug = normalizeSlug(body.slug);
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });
  // visitor id is optional context (analytics/legacy); identity is the session.
  const visitorId = normalizeVisitorId(body.visitorId);

  const postId = await loadPostId(supabase, slug);
  if (!postId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Toggle: insert wins the ♥; a unique-violation on (post_id, user_id) means it
  // already existed → remove it (unlike).
  const { error: insertError } = await supabase
    .from('blog_post_likes')
    .insert({ post_id: postId, user_id: userId, visitor_id: visitorId ?? `user:${userId}` });
  if (insertError) {
    if (insertError.code === '23505') {
      await supabase.from('blog_post_likes').delete().eq('post_id', postId).eq('user_id', userId);
    } else {
      return NextResponse.json({ error: 'Could not record the like' }, { status: 500 });
    }
  }

  const state = await likeState(supabase, postId, userId);
  return NextResponse.json({ ...state, signedIn: true }, { headers: { 'Cache-Control': 'no-store' } });
}

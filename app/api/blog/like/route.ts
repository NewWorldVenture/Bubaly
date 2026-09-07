import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { normalizeSlug, normalizeVisitorId } from '@/lib/blog/engagement';

export const runtime = 'nodejs';

// Public blog ♥ endpoint. Anonymous but not unbounded: keyed by the durable
// bubaly_vid visitor id with one like per (post, visitor) enforced by a DB
// unique constraint, service-role writes only (no client table access), and
// IP rate limiting. GET returns { liked, count }; POST toggles and returns
// the new state.

const MAX_BODY_BYTES = 2_048;

async function loadPostId(supabase: ReturnType<typeof createServiceClient>, slug: string): Promise<string | null> {
  const { data } = await supabase
    .from('blog_posts')
    .select('id')
    .eq('slug', slug)
    .eq('published', true)
    .maybeSingle();
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
  const visitorId = normalizeVisitorId(req.nextUrl.searchParams.get('visitorId'));

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

  const slug = normalizeSlug(body.slug);
  const visitorId = normalizeVisitorId(body.visitorId);
  if (!slug || !visitorId) return NextResponse.json({ error: t('like.slugAndVisitoridRequired') }, { status: 400 });

  const postId = await loadPostId(supabase, slug);
  if (!postId) return NextResponse.json({ error: t('like.notFound') }, { status: 404 });

  // Toggle: insert wins the ♥; a unique-violation means it existed → remove it.
  const { error: insertError } = await supabase
    .from('blog_post_likes')
    .insert({ post_id: postId, visitor_id: visitorId });
  if (insertError) {
    if (insertError.code === '23505') {
      await supabase.from('blog_post_likes').delete().eq('post_id', postId).eq('visitor_id', visitorId);
    } else {
      return NextResponse.json({ error: t('like.couldNotRecordTheLike') }, { status: 500 });
    }
  }

  const state = await likeState(supabase, postId, visitorId);
  return NextResponse.json(state, { headers: { 'Cache-Control': 'no-store' } });
}

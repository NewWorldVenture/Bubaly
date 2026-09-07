import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { normalizeSlug } from '@/lib/blog/engagement';

export const runtime = 'nodejs';

// Signed-in blog ♥ / save endpoint. Unlike the legacy anonymous like, saving an
// article REQUIRES an authenticated Bubaly account — the heart persists a
// per-user bookmark (blog_post_saves, RLS = own rows only). GET returns
// { saved, count, authenticated }; POST toggles and needs a session (401 when
// signed out, so the client can send the reader to sign in). The public count
// is an aggregate produced by the service role — no per-user data is exposed.

const MAX_BODY_BYTES = 2_048;

async function loadPostId(svc: ReturnType<typeof createServiceClient>, slug: string): Promise<string | null> {
  const { data } = await svc.from('blog_posts').select('id').eq('slug', slug).eq('published', true).maybeSingle();
  return data?.id ?? null;
}

async function saveState(svc: ReturnType<typeof createServiceClient>, postId: string, userId: string | null) {
  const [{ count }, saved] = await Promise.all([
    svc.from('blog_post_saves').select('id', { count: 'exact', head: true }).eq('post_id', postId),
    userId
      ? svc.from('blog_post_saves').select('id').eq('post_id', postId).eq('user_id', userId).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  return { count: count ?? 0, saved: !!(saved as { data: unknown }).data };
}

export async function GET(req: NextRequest) {
  const t = await getTranslations();
  const slug = normalizeSlug(req.nextUrl.searchParams.get('slug'));
  if (!slug) return NextResponse.json({ error: t('save.invalidSlug') }, { status: 400 });

  const svc = createServiceClient();
  const postId = await loadPostId(svc, slug);
  if (!postId) return NextResponse.json({ error: t('save.notFound') }, { status: 404 });

  const { data: auth } = await (await createServer()).auth.getUser();
  const state = await saveState(svc, postId, auth.user?.id ?? null);
  return NextResponse.json(
    { ...state, authenticated: !!auth.user },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const svc = createServiceClient();

  // Must be signed in to save — this is the whole point of the feature.
  const { data: auth } = await (await createServer()).auth.getUser();
  if (!auth.user) {
    return NextResponse.json({ error: 'auth_required', authenticated: false }, { status: 401 });
  }
  const userId = auth.user.id;

  const ip = clientIp(req.headers);
  const limited = await enforceRequestRateLimit(svc, `blogsave:${ip}`, { limit: 60 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: t('save.tooManyRequests') },
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
  const body = (parsed.value && typeof parsed.value === 'object' ? parsed.value : {}) as { slug?: unknown };
  const slug = normalizeSlug(body.slug);
  if (!slug) return NextResponse.json({ error: t('save.slugRequired') }, { status: 400 });

  const postId = await loadPostId(svc, slug);
  if (!postId) return NextResponse.json({ error: t('save.notFound') }, { status: 404 });

  // Toggle: insert wins the save; a unique-violation means it existed → remove.
  const { error: insertError } = await svc.from('blog_post_saves').insert({ post_id: postId, user_id: userId });
  if (insertError) {
    if (insertError.code === '23505') {
      await svc.from('blog_post_saves').delete().eq('post_id', postId).eq('user_id', userId);
    } else {
      return NextResponse.json({ error: t('save.couldNotRecordTheSave') }, { status: 500 });
    }
  }

  const state = await saveState(svc, postId, userId);
  return NextResponse.json({ ...state, authenticated: true }, { headers: { 'Cache-Control': 'no-store' } });
}

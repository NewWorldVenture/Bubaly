import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { normalizeEmail, normalizeSource, normalizeVisitorId } from '@/lib/blog/engagement';
import { describeReadError } from '@/lib/supabase/settle';

export const runtime = 'nodejs';

// Public blog subscribe endpoint. An explicit email opt-in from the blog's
// subscribe forms → blog_subscribers (service-role only; RLS denies clients).
// Bot defenses: honeypot field (silently accepted, never written), IP rate
// limit, bounded body, strict email normalization. Re-subscribing after an
// unsubscribe re-activates — a fresh explicit opt-in is new consent.

const MAX_BODY_BYTES = 4_096;

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `blogsub:${ip}`, { limit: 20 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: t('subscribe.tooManyRequests') },
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
  const body = (parsed.value && typeof parsed.value === 'object' ? parsed.value : {}) as {
    email?: unknown; source?: unknown; visitorId?: unknown; website?: unknown;
  };

  // Honeypot: real users never see (or fill) the "website" field. Pretend
  // success so bots learn nothing.
  if (typeof body.website === 'string' && body.website.trim() !== '') {
    return NextResponse.json({ ok: true });
  }

  const email = normalizeEmail(body.email);
  if (!email) return NextResponse.json({ error: t('subscribe.enterAValidEmailAddress') }, { status: 400 });

  const source = normalizeSource(body.source);
  const visitorId = normalizeVisitorId(body.visitorId);

  // `blog_subscribers.email` is UNIQUE (0201_blog_engagement.sql:35), so a
  // refused read here did not create a duplicate — it fell through to the
  // insert and hit the constraint. The person affected is someone who already
  // subscribed and, more pointedly, someone previously unsubscribed who is
  // trying to come back: instead of being reactivated they get an error.
  // Audit C1-S9-41.
  const { data: existing, error: existingError } = await supabase
    .from('blog_subscribers')
    .select('id, status')
    .eq('email', email)
    .maybeSingle();

  if (existingError) {
    console.error('[blog/subscribe] subscriber lookup failed', { error: describeReadError(existingError) });
    return NextResponse.json({ error: t('subscribe.subscriptionIsTemporarilyUnavailable') }, { status: 503 });
  }

  if (existing) {
    if (existing.status !== 'active') {
      const { error } = await supabase
        .from('blog_subscribers')
        .update({ status: 'active', source, unsubscribed_at: null, ...(visitorId ? { visitor_id: visitorId } : {}) })
        .eq('id', existing.id);
      if (error) return NextResponse.json({ error: t('subscribe.couldNotSubscribeRightNow') }, { status: 500 });
    }
    return NextResponse.json({ ok: true, already: existing.status === 'active' });
  }

  const { error } = await supabase
    .from('blog_subscribers')
    .insert({ email, source, visitor_id: visitorId });
  if (error) {
    // A concurrent insert racing us is fine — the subscriber exists either way.
    if (error.code === '23505') return NextResponse.json({ ok: true, already: true });
    return NextResponse.json({ error: t('subscribe.couldNotSubscribeRightNow') }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

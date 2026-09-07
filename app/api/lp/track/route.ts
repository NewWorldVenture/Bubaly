import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
const MAX_LANDING_TRACK_REQUEST_BYTES = 4_096;

/**
 * Public landing-page metric ingestion. Increments views/conversions for a
 * published landing page via the service-role RPC `bump_landing_metric`
 * (marketing tables have no client policies). Best-effort; failures are silent
 * to the visitor.
 */
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `lp:${ip}`, { limit: 60 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: t('track.tooManyRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const parsedBody = await readBoundedRequestJson(req, MAX_LANDING_TRACK_REQUEST_BYTES);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.reason === 'too_large' ? 'Request body too large.' : 'Invalid body' },
      { status: parsedBody.reason === 'too_large' ? 413 : 400 },
    );
  }
  const body = (parsedBody.value && typeof parsedBody.value === 'object' ? parsedBody.value : {}) as {
    slug?: string; kind?: string;
  };

  const slug = (body.slug ?? '').trim().toLowerCase();
  const metric = body.kind === 'conversion' ? 'conversion' : 'view';
  if (!slug) return NextResponse.json({ error: t('track.slugIsRequired') }, { status: 422 });

  const { error } = await supabase.rpc('bump_landing_metric', { p_slug: slug, p_metric: metric });
  if (error) {
    console.error('Landing-page metric recording failed:', error);
    return NextResponse.json({ error: t('track.couldNotRecordTheLanding') }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

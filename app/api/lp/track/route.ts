import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

export const runtime = 'nodejs';

/**
 * Public landing-page metric ingestion. Increments views/conversions for a
 * published landing page via the service-role RPC `bump_landing_metric`
 * (marketing tables have no client policies). Best-effort; failures are silent
 * to the visitor.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `lp:${ip}`, { limit: 60 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  let body: { slug?: string; kind?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }

  const slug = (body.slug ?? '').trim().toLowerCase();
  const metric = body.kind === 'conversion' ? 'conversion' : 'view';
  if (!slug) return NextResponse.json({ error: 'slug is required' }, { status: 422 });

  const { error } = await supabase.rpc('bump_landing_metric', { p_slug: slug, p_metric: metric });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { hasConfiguredVariant } from '@/lib/marketing/ab';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
const MAX_AB_REQUEST_BYTES = 4_096;

/**
 * Public A/B event ingestion. Records an exposure or conversion for a running
 * experiment. Writes via the service-role client (ab_events has no client
 * policies). Deduped per visitor by a unique index, so double-fires are no-ops.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `ab:${ip}`, { limit: 60 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const parsedBody = await readBoundedRequestJson(req, MAX_AB_REQUEST_BYTES);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.reason === 'too_large' ? 'Request body too large.' : 'Invalid body' },
      { status: parsedBody.reason === 'too_large' ? 413 : 400 },
    );
  }
  const body = (parsedBody.value && typeof parsedBody.value === 'object' ? parsedBody.value : {}) as {
    experiment?: string; variant?: string; kind?: string; visitorId?: string;
  };

  const experiment = (body.experiment ?? '').trim();
  const variant = (body.variant ?? '').trim();
  const kind = body.kind === 'conversion' ? 'conversion' : 'exposure';
  const visitorId = (body.visitorId ?? '').trim() || null;
  if (!experiment || !variant) return NextResponse.json({ error: 'experiment and variant are required' }, { status: 422 });
  if (experiment.length > 100 || variant.length > 100 || (visitorId && visitorId.length > 200)) {
    return NextResponse.json({ error: 'Identifier is too long' }, { status: 422 });
  }

  // Only record for experiments that are actually running.
  const { data: exp } = await supabase
    .from('ab_experiments')
    .select('status, variants')
    .eq('key', experiment)
    .is('deleted_at', null)
    .maybeSingle();
  if (!exp || exp.status !== 'running') return NextResponse.json({ ok: true, recorded: false });
  if (!hasConfiguredVariant(exp.variants, variant)) {
    return NextResponse.json({ error: 'Unknown experiment variant' }, { status: 422 });
  }

  // Insert; ignore unique-violation dupes (one exposure/conversion per visitor).
  const { error } = await supabase.from('ab_events').insert({ experiment_key: experiment, variant_key: variant, kind, visitor_id: visitorId });
  if (error && error.code !== '23505') return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, recorded: true });
}

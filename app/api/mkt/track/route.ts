import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getConsentState, canRecordAnalytics } from '@/lib/marketing/consent';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

// Public visitor-intelligence ingest. The site/app calls this with an
// anonymous_id (cookie/device id) plus acquisition params to record a session
// and a touchpoint, upserting the visitor (CDP profile spine). Service-role —
// no auth, but it only ever writes intelligence rows keyed by anonymous_id.
type TrackBody = {
  anonymousId?: string;
  source?: string | null;
  medium?: string | null;
  campaign?: string | null;
  landingPath?: string | null;
  deviceType?: string | null;
  country?: string | null;
  kind?: 'touch' | 'conversion';
  gpc?: boolean;
};

const MAX_TRACK_REQUEST_BYTES = 8_192;

function clean(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, 200) : null;
}

export async function POST(req: NextRequest) {
  // Public service-role ingest → must be rate-limited like the other trackers.
  const ip = clientIp(req.headers);
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `mkt:${ip}`, { limit: 60 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const parsedBody = await readBoundedRequestJson(req, MAX_TRACK_REQUEST_BYTES);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.reason === 'too_large' ? 'Request body too large.' : 'Bad payload' },
      { status: parsedBody.reason === 'too_large' ? 413 : 400 },
    );
  }
  const body = (parsedBody.value && typeof parsedBody.value === 'object' ? parsedBody.value : {}) as TrackBody;

  const anonymousId = clean(body.anonymousId);
  if (!anonymousId) return NextResponse.json({ error: 'anonymousId required' }, { status: 400 });

  const source = clean(body.source);
  const medium = clean(body.medium);
  const campaign = clean(body.campaign);
  const kind = body.kind === 'conversion' ? 'conversion' : 'touch';
  const now = new Date().toISOString();

  // Privacy gate: only record first-party analytics when the visitor permits it.
  // Necessary-only / denied / GPC visitors are acknowledged but not profiled.
  let consent;
  try {
    consent = await getConsentState(supabase, anonymousId, { gpc: body.gpc === true });
  } catch (error) {
    console.error('[mkt-track] consent read failed', error);
    return NextResponse.json({ error: 'Analytics is temporarily unavailable.' }, { status: 503 });
  }
  if (!canRecordAnalytics(consent)) {
    return NextResponse.json({ ok: true, recorded: false, reason: 'analytics_consent_absent' });
  }

  // Upsert the visitor (CDP spine), bump last_seen + session_count.
  const { data: existing, error: existingError } = await supabase
    .from('mkt_visitors')
    .select('id, session_count')
    .eq('anonymous_id', anonymousId)
    .maybeSingle();
  if (existingError) {
    console.error('[mkt-track] visitor read failed', existingError);
    return NextResponse.json({ error: 'Analytics is temporarily unavailable.' }, { status: 503 });
  }

  let visitorId: string | null = existing?.id ?? null;
  if (visitorId) {
    const { error: updateError } = await supabase.from('mkt_visitors').update({
      last_seen: now,
      session_count: (existing!.session_count ?? 0) + 1,
      device_type: clean(body.deviceType) ?? undefined,
      country: clean(body.country) ?? undefined,
    }).eq('id', visitorId);
    if (updateError) {
      console.error('[mkt-track] visitor update failed', updateError);
      return NextResponse.json({ error: 'Analytics is temporarily unavailable.' }, { status: 503 });
    }
  } else {
    const { data: created, error: createError } = await supabase.from('mkt_visitors').insert({
      anonymous_id: anonymousId,
      device_type: clean(body.deviceType),
      country: clean(body.country),
      session_count: 1,
    }).select('id').single();
    if (createError) {
      console.error('[mkt-track] visitor create failed', createError);
      return NextResponse.json({ error: 'Analytics is temporarily unavailable.' }, { status: 503 });
    }
    visitorId = created?.id ?? null;
  }
  if (!visitorId) return NextResponse.json({ error: 'Could not record visitor' }, { status: 500 });

  const [{ error: sessionError }, { error: touchpointError }] = await Promise.all([
    supabase.from('mkt_sessions').insert({ visitor_id: visitorId, source, medium, campaign, landing_path: clean(body.landingPath) }),
    supabase.from('mkt_touchpoints').insert({ visitor_id: visitorId, source, medium, campaign, kind, occurred_at: now }),
  ]);
  if (sessionError || touchpointError) {
    console.error('[mkt-track] attribution write failed', sessionError ?? touchpointError);
    return NextResponse.json({ error: 'Analytics is temporarily unavailable.' }, { status: 503 });
  }

  return NextResponse.json({ ok: true, recorded: true });
}

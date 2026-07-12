import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getConsentState, canRecordAnalytics } from '@/lib/marketing/consent';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';

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

function clean(v: unknown): string | null {
  const s = typeof v === 'string' ? v.trim() : '';
  return s ? s.slice(0, 200) : null;
}

export async function POST(req: NextRequest) {
  // Public service-role ingest → must be rate-limited like the other trackers.
  const ip = clientIp(req.headers);
  const limited = rateLimit(`mkt:${ip}`, { limit: 60, windowMs: 60_000 });
  if (!limited.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  let body: TrackBody;
  try {
    body = (await req.json()) as TrackBody;
  } catch {
    return NextResponse.json({ error: 'Bad payload' }, { status: 400 });
  }

  const anonymousId = clean(body.anonymousId);
  if (!anonymousId) return NextResponse.json({ error: 'anonymousId required' }, { status: 400 });

  const source = clean(body.source);
  const medium = clean(body.medium);
  const campaign = clean(body.campaign);
  const kind = body.kind === 'conversion' ? 'conversion' : 'touch';
  const now = new Date().toISOString();

  const supabase = createServiceClient();

  // Privacy gate: only record first-party analytics when the visitor permits it.
  // Necessary-only / denied / GPC visitors are acknowledged but not profiled.
  const consent = await getConsentState(supabase, anonymousId, { gpc: body.gpc === true });
  if (!canRecordAnalytics(consent)) {
    return NextResponse.json({ ok: true, recorded: false, reason: 'analytics_consent_absent' });
  }

  // Upsert the visitor (CDP spine), bump last_seen + session_count.
  const { data: existing } = await supabase
    .from('mkt_visitors')
    .select('id, session_count')
    .eq('anonymous_id', anonymousId)
    .maybeSingle();

  let visitorId: string | null = existing?.id ?? null;
  if (visitorId) {
    await supabase.from('mkt_visitors').update({
      last_seen: now,
      session_count: (existing!.session_count ?? 0) + 1,
      device_type: clean(body.deviceType) ?? undefined,
      country: clean(body.country) ?? undefined,
    }).eq('id', visitorId);
  } else {
    const { data: created } = await supabase.from('mkt_visitors').insert({
      anonymous_id: anonymousId,
      device_type: clean(body.deviceType),
      country: clean(body.country),
      session_count: 1,
    }).select('id').single();
    visitorId = created?.id ?? null;
  }
  if (!visitorId) return NextResponse.json({ error: 'Could not record visitor' }, { status: 500 });

  await supabase.from('mkt_sessions').insert({
    visitor_id: visitorId, source, medium, campaign, landing_path: clean(body.landingPath),
  });
  await supabase.from('mkt_touchpoints').insert({
    visitor_id: visitorId, source, medium, campaign, kind, occurred_at: now,
  });

  return NextResponse.json({ ok: true, recorded: true });
}

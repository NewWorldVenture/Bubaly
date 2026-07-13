import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { MAX_PUSH_REQUEST_BYTES, parsePushRegistration } from '@/lib/server/push-request';

export const dynamic = 'force-dynamic';

/** Register (or refresh) this device's push subscription for the signed-in user. */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const contentLength = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_PUSH_REQUEST_BYTES) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
  }
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_PUSH_REQUEST_BYTES) {
    return NextResponse.json({ error: 'Request body too large' }, { status: 413 });
  }
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  const parsed = parsePushRegistration(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const supabase = await createServer();
  const limited = await enforceRequestRateLimit(supabase, `push-subscribe:${user.id}`, { limit: 20 });
  if (!limited.ok) {
    return NextResponse.json({ error: 'Too many push registration attempts' }, {
      status: 429,
      headers: { 'Retry-After': String(limited.retryAfter) },
    });
  }
  const { platform, provider, endpoint, p256dh, auth, token, deviceKey, userAgent } = parsed.value;
  // Best-effort family association (nullable) for routing/scoping.
  const { data: member } = await supabase
    .from('family_members')
    .select('family_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  const { error } = await supabase.from('push_devices').upsert(
    {
      user_id: user.id,
      family_id: member?.family_id ?? null,
      platform,
      provider,
      endpoint,
      p256dh,
      auth,
      token,
      device_key: deviceKey,
      user_agent: userAgent,
      enabled: true,
      last_seen_at: new Date().toISOString(),
      created_by: user.id,
      updated_by: user.id,
    },
    { onConflict: 'user_id,device_key' },
  );
  if (error) return NextResponse.json({ error: 'Could not save push subscription' }, { status: 500 });
  return NextResponse.json({ ok: true });
}

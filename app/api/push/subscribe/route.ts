import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { getUser } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { MAX_PUSH_REQUEST_BYTES, parsePushRegistration } from '@/lib/server/push-request';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';
import { isDeliverablePushEndpoint } from '@/lib/server/push-endpoint';

export const dynamic = 'force-dynamic';

/** Register (or refresh) this device's push subscription for the signed-in user. */
export async function POST(req: Request) {
  const t = await getTranslations();
  const user = await getUser();
  if (!user) return NextResponse.json({ error: t('subscribe.unauthorized') }, { status: 401 });

  const boundedBody = await readBoundedRequestText(req, MAX_PUSH_REQUEST_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body too large' : 'Unable to read request body' }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
  const rawBody = boundedBody.text;
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ error: t('subscribe.invalidRequestBody') }, { status: 400 }); }
  const parsed = parsePushRegistration(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  // parsePushRegistration checks the hostname as a string. This asks DNS where
  // it actually points, because the server POSTs to this endpoint later with no
  // further say from the user. Audit C3-S5-03.
  if (parsed.value.endpoint && !(await isDeliverablePushEndpoint(parsed.value.endpoint))) {
    return NextResponse.json({ error: 'Invalid web push subscription' }, { status: 400 });
  }

  const supabase = await createServer();
  const limited = await enforceRequestRateLimit(supabase, `push-subscribe:${user.id}`, { limit: 20 });
  if (!limited.ok) {
    return NextResponse.json({ error: t('subscribe.tooManyPushRegistrationAttempts') }, {
      status: 429,
      headers: { 'Retry-After': String(limited.retryAfter) },
    });
  }
  const { platform, provider, endpoint, p256dh, auth, token, deviceKey, userAgent } = parsed.value;
  // Family association for routing/scoping. Genuinely nullable — a user with no
  // family has none — but the error was dropped, so a REFUSED read produced the
  // same null and the device was registered unscoped.
  //
  // That is sticky in a way a page render is not: `lib/server/push.ts` filters
  // candidates by `family_id`, so the row persists and this device misses every
  // family-scoped notification until some later subscribe happens to succeed.
  // The one thing this route exists to set up is silently set up wrong, and the
  // client is told it worked. A failed read is the one case where writing
  // nothing and letting the client retry is better. Audit C1-S9-39.
  const { data: member, error: memberError } = await supabase
    .from('family_members')
    .select('family_id')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (memberError) {
    console.error('[push/subscribe] family lookup failed; refusing to register an unscoped device', {
      userId: user.id, error: memberError.message,
    });
    return NextResponse.json({ error: t('subscribe.couldNotRegisterThisDevice') }, { status: 503 });
  }

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
  if (error) return NextResponse.json({ error: t('subscribe.couldNotSavePushSubscription') }, { status: 500 });
  return NextResponse.json({ ok: true });
}

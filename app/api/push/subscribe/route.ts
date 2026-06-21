import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/** Register (or refresh) this device's push subscription for the signed-in user. */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const platform = ['web', 'ios', 'android'].includes(body.platform) ? body.platform : 'web';
  const provider = ['webpush', 'fcm', 'apns'].includes(body.provider) ? body.provider : 'webpush';
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : null;
  const token = typeof body.token === 'string' ? body.token : null;
  const deviceKey = endpoint ?? token;
  if (!deviceKey) return NextResponse.json({ error: 'Missing endpoint or token' }, { status: 400 });

  const supabase = await createServer();
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
      p256dh: typeof body.p256dh === 'string' ? body.p256dh : null,
      auth: typeof body.auth === 'string' ? body.auth : null,
      token,
      device_key: deviceKey,
      user_agent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 400) : null,
      enabled: true,
      last_seen_at: new Date().toISOString(),
      created_by: user.id,
      updated_by: user.id,
    },
    { onConflict: 'user_id,device_key' },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

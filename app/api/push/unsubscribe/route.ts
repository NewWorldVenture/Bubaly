import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

/** Remove this device's push subscription (or disable it) for the signed-in user. */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const deviceKey = typeof body.endpoint === 'string' ? body.endpoint : (typeof body.token === 'string' ? body.token : null);
  if (!deviceKey) return NextResponse.json({ error: 'Missing endpoint or token' }, { status: 400 });

  const supabase = await createServer();
  const { error } = await supabase
    .from('push_devices')
    .delete()
    .eq('user_id', user.id)
    .eq('device_key', deviceKey);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

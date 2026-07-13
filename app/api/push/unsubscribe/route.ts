import { NextResponse } from 'next/server';
import { getUser } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { MAX_PUSH_REQUEST_BYTES, parsePushDeviceKey } from '@/lib/server/push-request';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';

export const dynamic = 'force-dynamic';

/** Remove this device's push subscription (or disable it) for the signed-in user. */
export async function POST(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const boundedBody = await readBoundedRequestText(req, MAX_PUSH_REQUEST_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body too large' : 'Unable to read request body' }, { status: boundedBody.reason === 'too_large' ? 413 : 400 });
  const rawBody = boundedBody.text;
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }
  const deviceKey = parsePushDeviceKey(body);
  if (!deviceKey) return NextResponse.json({ error: 'Missing endpoint or token' }, { status: 400 });

  const supabase = await createServer();
  const limited = await enforceRequestRateLimit(supabase, `push-unsubscribe:${user.id}`, { limit: 30 });
  if (!limited.ok) {
    return NextResponse.json({ error: 'Too many push removal attempts' }, {
      status: 429,
      headers: { 'Retry-After': String(limited.retryAfter) },
    });
  }
  const { error } = await supabase
    .from('push_devices')
    .delete()
    .eq('user_id', user.id)
    .eq('device_key', deviceKey);
  if (error) return NextResponse.json({ error: 'Could not remove push subscription' }, { status: 500 });
  return NextResponse.json({ ok: true });
}

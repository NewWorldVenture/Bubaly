import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';

export const runtime = 'nodejs';

/** Public: bump an exit-intent offer's impression/conversion counter via the
 *  SECURITY DEFINER RPC. Best-effort; failures are silent to the visitor. */
export async function POST(req: NextRequest) {
  const limit = rateLimit(`ei-track:${clientIp(req.headers)}`, { limit: 60, windowMs: 60_000 });
  if (!limit.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  let body: { id?: string; kind?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Invalid body' }, { status: 400 }); }

  const id = (body.id ?? '').trim();
  const metric = body.kind === 'conversion' ? 'conversion' : 'impression';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 422 });

  const { error } = await createServiceClient().rpc('bump_exit_intent', { p_id: id, p_metric: metric });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

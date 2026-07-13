import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestJson } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

/** Public: bump an exit-intent offer's impression/conversion counter via the
 *  SECURITY DEFINER RPC. Best-effort; failures are silent to the visitor. */
export async function POST(req: NextRequest) {
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `ei-track:${clientIp(req.headers)}`, { limit: 60 });
  if (!limited.ok) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
  }

  const parsedBody = await readBoundedRequestJson(req, 2_048);
  if (!parsedBody.ok) {
    return NextResponse.json(
      { error: parsedBody.reason === 'too_large' ? 'Request body too large.' : 'Invalid body' },
      { status: parsedBody.reason === 'too_large' ? 413 : 400 },
    );
  }
  const body = (parsedBody.value && typeof parsedBody.value === 'object' ? parsedBody.value : {}) as {
    id?: string; kind?: string;
  };

  const id = (body.id ?? '').trim();
  const metric = body.kind === 'conversion' ? 'conversion' : 'impression';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 422 });

  const { error } = await supabase.rpc('bump_exit_intent', { p_id: id, p_metric: metric });
  if (error) {
    console.error('Exit-intent metric recording failed:', error);
    return NextResponse.json({ error: 'Could not record the offer event.' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

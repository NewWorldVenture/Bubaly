import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const start = Date.now();
  let dbOk = false;

  try {
    const sb = createServiceClient();
    const { error } = await sb.from('families').select('id').limit(1);
    dbOk = !error;
  } catch {
    dbOk = false;
  }

  const latencyMs = Date.now() - start;

  const status = dbOk ? 200 : 503;
  return NextResponse.json(
    {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'connected' : 'unreachable',
      latencyMs,
      timestamp: new Date().toISOString(),
    },
    { status },
  );
}

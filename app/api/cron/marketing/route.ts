import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { processMarketingGenerationJobs } from '@/lib/marketing/platform';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Durable marketing worker. Vercel invokes this frequently; the database RPC
 * claims rows with SKIP LOCKED so concurrent invocations do not duplicate work. */
export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const limit = Math.min(25, Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? 10) || 10));
    const summary = await processMarketingGenerationJobs(createServiceClient(), limit);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    console.error('[marketing-worker] failed', error);
    return NextResponse.json({ error: 'Marketing worker failed' }, { status: 500 });
  }
}

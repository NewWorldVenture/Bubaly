import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { syncMarketingProviders } from '@/lib/marketing/provider-sync';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const summary = await syncMarketingProviders(createServiceClient());
  return NextResponse.json({ ok: summary.completed, ready: summary.ready, results: summary.results }, { status: summary.completed ? 200 : 502 });
}

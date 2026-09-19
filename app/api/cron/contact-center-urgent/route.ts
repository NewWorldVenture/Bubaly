import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { drainUrgentDeliveries } from '@/lib/contact-center/urgent-delivery';

export const runtime = 'nodejs';
export const maxDuration = 110;

export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const counts = await drainUrgentDeliveries(createServiceClient());
    const ok = counts.pending + counts.unknown + counts.rejected + counts.legacy_unknown + counts.failed === 0;
    return NextResponse.json({ ok, ...counts }, { status: ok ? 200 : 503 });
  } catch {
    return NextResponse.json({ ok: false, failed: 1 }, { status: 503 });
  }
}

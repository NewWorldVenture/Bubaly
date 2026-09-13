import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { drainGuardianSmsReceipts } from '@/lib/guardian/sms-recovery';

export const runtime = 'nodejs';
export const maxDuration = 110;

export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const counts = await drainGuardianSmsReceipts(createServiceClient(), { signal: req.signal });
    const ok = counts.unavailable === 0;
    return NextResponse.json({ ok, ...counts }, { status: ok ? 200 : 503 });
  } catch {
    return NextResponse.json({ ok: false, unavailable: 1 }, { status: 503 });
  }
}

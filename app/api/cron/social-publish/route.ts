import { NextRequest, NextResponse } from 'next/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { runScheduledPublishDrain } from '@/lib/social/scheduled-publish';

export const runtime = 'nodejs';
export const maxDuration = 110;

export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const summary = await runScheduledPublishDrain();
    const ok = summary.failed === 0 && summary.unknown === 0;
    return NextResponse.json({ ok, ...summary }, { status: ok ? 200 : 503 });
  } catch { return NextResponse.json({ ok: false, failed: 1 }, { status: 503 }); }
}

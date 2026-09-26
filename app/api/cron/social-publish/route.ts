import { NextRequest, NextResponse } from 'next/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { runScheduledPublishDrain } from '@/lib/social/scheduled-publish';

export const runtime = 'nodejs';
export const maxDuration = 110;

export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    // `req.signal` matters here: every database call inside the drain is wired
    // to `abortSignal`, so when the platform kills this invocation at
    // `maxDuration` the in-flight work aborts cooperatively and the receipt
    // machine records a state, instead of being severed mid-claim. The drain
    // was built to accept it and this caller simply never passed it —
    // `app/api/cron/guardian-sms-recovery/route.ts` already does, which is what
    // made the omission visible. Audit C1-S9-13.
    const summary = await runScheduledPublishDrain({ signal: req.signal });
    const ok = summary.failed === 0 && summary.unknown === 0;
    return NextResponse.json({ ok, ...summary }, { status: ok ? 200 : 503 });
  } catch { return NextResponse.json({ ok: false, failed: 1 }, { status: 503 }); }
}

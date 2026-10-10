import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { drainGuardianSmsReceipts } from '@/lib/guardian/sms-recovery';
import { retryUndeliveredGuardianEscalations } from '@/lib/guardian/escalation-retry';

export const runtime = 'nodejs';
export const maxDuration = 110;

// Two sweeps on one tick. The receipt drain resumes inbound SMS left mid-way;
// the escalation retry re-attempts recent emergency escalations whose record
// says no manager was reached — the SMS lane's, the WhatsApp route's and the
// screening route's alike, none of which has another way back once Twilio has
// been answered. It rides here rather than on a route of its own because this
// is the Guardian job the dispatcher already fires every five minutes, and a
// new route would need a schedule in vercel.json and the dispatcher table.
export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) return NextResponse.json({ ok: false }, { status: 401 });
  try {
    const client = createServiceClient();
    const counts = await drainGuardianSmsReceipts(client, { signal: req.signal });
    const escalations = await retryUndeliveredGuardianEscalations(client, { signal: req.signal });
    // Non-2xx whenever something is still owed, so the dispatcher logs it: an
    // SMS that could not be resumed, or an escalation that still reached nobody.
    const ok = counts.unavailable === 0 && escalations.undelivered === 0 && escalations.unavailable === 0;
    return NextResponse.json({ ok, ...counts, escalations }, { status: ok ? 200 : 503 });
  } catch {
    return NextResponse.json({ ok: false, unavailable: 1 }, { status: 503 });
  }
}

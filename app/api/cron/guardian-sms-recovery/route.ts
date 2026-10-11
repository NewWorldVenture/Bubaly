import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { drainGuardianSmsReceipts, type GuardianSmsRecoveryCounts } from '@/lib/guardian/sms-recovery';
import { NO_GUARDIAN_ESCALATION_RETRIES, retryUndeliveredGuardianEscalations, type GuardianEscalationRetryCounts } from '@/lib/guardian/escalation-retry';

export const runtime = 'nodejs';
export const maxDuration = 110;

/**
 * Both sweeps end inside this, leaving the rest of maxDuration to answer. The
 * platform kills the function at maxDuration without firing req.signal, so a
 * deadline nothing shares was no deadline: the drain could take 80 s and the
 * retry sweep then start ten 30 s attempts, and the invocation was killed
 * mid-send — the dispatcher got a 504 and no counts, and a claim was left
 * `processing` with its record unwritten.
 */
const RECOVERY_RUN_MS = 100_000;
/** The receipt drain's part of it. The escalation sweep always has the rest. */
const RECOVERY_DRAIN_MS = 55_000;

// Two sweeps on one tick. The receipt drain resumes inbound SMS left mid-way;
// the escalation retry re-attempts recent emergency escalations whose record
// says no manager was reached — the SMS lane's, the WhatsApp route's and the
// screening route's alike. It finds only what an escalation left behind: its
// record, or the work item written in the record's place (by the escalation
// when the record failed, or by the screening route when the escalation could
// not run at all, which has no other way back once Twilio has been answered).
// With neither, only the caller's own retry can come back for it. It rides
// here rather than on a route of its own because a new
// route would need a schedule in vercel.json and the dispatcher table. That
// table asks for this job every five minutes; what vercel.json guarantees is
// one run a day (10 2 * * *), and the GitHub ticks between have been measured
// hours apart (scripts/cron-dispatch.mjs).
//
// The two are independent: a drain that throws (a cursor it cannot read, a
// query that times out) does not cost the emergency retries their tick, and
// the answer always says what the sweep did.
export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) return NextResponse.json({ ok: false }, { status: 401 });
  const startedAt = Date.now();
  let client: ReturnType<typeof createServiceClient>;
  try {
    client = createServiceClient();
  } catch {
    return NextResponse.json({ ok: false, unavailable: 1, escalations: { ...NO_GUARDIAN_ESCALATION_RETRIES, unavailable: 1 } }, { status: 503 });
  }
  let counts: GuardianSmsRecoveryCounts;
  try {
    counts = await drainGuardianSmsReceipts(client, { signal: req.signal, deadline: startedAt + RECOVERY_DRAIN_MS });
  } catch {
    // Counted, never described: the reason stays on the server.
    counts = { examined: 0, completed: 0, busy: 0, unavailable: 1 };
  }
  let escalations: GuardianEscalationRetryCounts;
  try {
    escalations = await retryUndeliveredGuardianEscalations(client, { signal: req.signal, deadline: startedAt + RECOVERY_RUN_MS });
  } catch {
    escalations = { ...NO_GUARDIAN_ESCALATION_RETRIES, unavailable: 1 };
  }
  // Non-2xx whenever something is still owed, so the dispatcher logs it: an
  // SMS that could not be resumed, or an escalation that still reached nobody
  // or was not reached by this run.
  const ok = counts.unavailable === 0 && escalations.undelivered === 0 && escalations.unavailable === 0 && escalations.deferred === 0;
  return NextResponse.json({ ok, ...counts, escalations }, { status: ok ? 200 : 503 });
}

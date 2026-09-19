import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readAll } from '@/lib/supabase/read-all';
import { fireAutomationEvent } from '@/lib/marketing/automation-events';
import { eventSubjectKey } from '@/lib/marketing/automation-triggers';
import { selectAbandonedSessions } from '@/lib/billing/checkout-abandonment';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';

// Abandoned-checkout follow-up. A checkout is "abandoned" once it's sat pending
// past a grace window without completing. We fire the `checkout_abandoned`
// automation workflow for each (deduped by session id) and mark the row so it
// never fires twice. Runs a few times a day so the nudge is timely.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('checkoutAbandoned.unauthorized') }, { status: 401 });
  }

  const supabase = createServiceClient();
  // Every one, not the first thousand: an unbounded select stops at PostgREST's
  // row ceiling and reports nothing, so the reminders past it would simply never
  // be sent. See lib/supabase/read-all.ts.
  const { rows: pending, error } = await readAll<{
    session_id: string; email: string | null; name: string | null; status: string; created_at: string;
  }>((from, to) => supabase
    .from('checkout_sessions')
    .select('session_id, email, name, status, created_at')
    .eq('status', 'pending')
    .order('session_id')
    .range(from, to));
  if (error) {
    console.error('Abandoned-checkout cron read failed:', error);
    return NextResponse.json({ error: t('checkoutAbandoned.abandonedCheckoutProcessingFailed') }, { status: 500 });
  }

  const abandoned = selectAbandonedSessions(pending ?? [], Date.now(), { graceMinutes: 60, maxAgeHours: 24 });

  let fired = 0;
  // Both halves of the sweep were logged and then dropped on the floor, and the
  // response was a hardcoded 200. scripts/cron-dispatch.mjs records nothing but
  // the status, so a run in which every nudge threw read exactly like a clean
  // one — the defect F-009 closed for the rest of this directory.
  let failed = 0;
  for (const s of abandoned) {
    try {
      await fireAutomationEvent(supabase, {
        trigger: 'checkout_abandoned',
        email: s.email,
        name: s.name,
        subjectKey: eventSubjectKey('checkout_abandoned', [s.session_id]),
        context: { sessionId: s.session_id },
      });
      fired += 1;
    } catch (e) {
      failed += 1;
      console.error(`checkout_abandoned fire failed for ${s.session_id}:`, e);
    }
    // Mark abandoned regardless of fire result so we never re-sweep this row —
    // and notice when that write is refused. Nothing else moves the row off
    // 'pending', so a lost mark means the session is swept again on every run
    // until it ages out of the 24h look-back, silently. The fire itself is
    // deduped on (workflow_id, subject_key), so the re-sweep does not double
    // send; it is the run's own report that was wrong.
    const { error: markError } = await supabase
      .from('checkout_sessions')
      .update({ status: 'abandoned', abandoned_at: new Date().toISOString() })
      .eq('session_id', s.session_id);
    if (markError) {
      failed += 1;
      console.error(`checkout_abandoned mark failed for ${s.session_id}:`, markError);
    }
  }

  const ok = failed === 0;
  return NextResponse.json(
    { ok, pending: (pending ?? []).length, abandoned: abandoned.length, fired, failed },
    { status: ok ? 200 : 502 },
  );
}

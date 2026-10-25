import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readAll } from '@/lib/supabase/read-all';
import { readAllInChunks } from '@/lib/supabase/chunked-in';
import { wroteNoRows } from '@/lib/supabase/errors';
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
    session_id: string; family_id: string | null; email: string | null; name: string | null; status: string; created_at: string;
  }>((from, to) => supabase
    .from('checkout_sessions')
    .select('session_id, family_id, email, name, status, created_at')
    .eq('status', 'pending')
    // `session_id` is unique, so this sort is already total — `id` is appended
    // because the primary key is the one tiebreaker that does not depend on
    // which migration is live. `uq_subscriptions_family`, the index that makes
    // a sibling sweep total, is itself pending production.
    .order('session_id')
    .order('id')
    .range(from, to));
  if (error) {
    console.error('Abandoned-checkout cron read failed:', error);
    return NextResponse.json({ error: t('checkoutAbandoned.abandonedCheckoutProcessingFailed') }, { status: 500 });
  }

  const abandoned = selectAbandonedSessions(pending ?? [], Date.now(), { graceMinutes: 60, maxAgeHours: 24 });

  // A family that has since paid through ANOTHER session is not nudged about
  // this one. Opening checkout twice and paying through the second leaves the
  // first pending, and "your plan is waiting" then reached a family that had
  // already paid. A checkout completed before this one began does not count:
  // that is a paying family that left a later plan change. Unreadable means
  // nobody is nudged or marked; the rows stay pending for the next run.
  const familyIds = [...new Set(abandoned.map((s) => s.family_id).filter((id): id is string => Boolean(id)))];
  const { data: completed, error: completedError } = await readAllInChunks<{ family_id: string | null; completed_at: string | null }>(
    familyIds,
    (chunk, from, to) => supabase
      .from('checkout_sessions')
      .select('family_id, completed_at')
      .eq('status', 'completed')
      .in('family_id', chunk)
      .order('id')
      .range(from, to),
  );
  if (completedError) {
    console.error('Abandoned-checkout cron completed-checkout read failed:', completedError);
    return NextResponse.json({ error: t('checkoutAbandoned.abandonedCheckoutProcessingFailed') }, { status: 500 });
  }
  const paidSince = (s: (typeof abandoned)[number]) => Boolean(s.family_id) && (completed ?? []).some((c) =>
    c.family_id === s.family_id && c.completed_at !== null && Date.parse(c.completed_at) >= Date.parse(s.created_at));

  let fired = 0;
  // Both halves of the sweep were logged and then dropped on the floor, and the
  // response was a hardcoded 200. scripts/cron-dispatch.mjs records nothing but
  // the status, so a run in which every nudge threw read exactly like a clean
  // one — the defect F-009 closed for the rest of this directory.
  let failed = 0;
  // Settled without a nudge: the family paid through another session.
  let superseded = 0;
  for (const s of abandoned) {
    // Claim the row BEFORE the nudge, and only while it is still pending. The
    // write used to come after the nudge and match `session_id` alone, so a
    // session the Stripe webhook completed in between was nudged anyway and its
    // `completed` row rewritten to `abandoned`. Zero rows now means it is no
    // longer pending (completed, or claimed by an overlapping run) or gone, and
    // either way there is nobody to nudge. Claimed regardless of the nudge's
    // fate, so the row is never swept again; the nudge itself is deduped on
    // (workflow_id, subject_key). A refused write nudges nobody and counts as a
    // failure: the row stays pending and the next run tries again.
    const claimedAt = new Date().toISOString();
    const { data: claimed, error: markError } = await supabase
      .from('checkout_sessions')
      .update({ status: 'abandoned', abandoned_at: claimedAt })
      .eq('session_id', s.session_id)
      .eq('status', 'pending')
      .select('session_id');
    if (markError) {
      failed += 1;
      console.error(`checkout_abandoned mark failed for ${s.session_id}:`, markError);
      continue;
    }
    if (wroteNoRows(claimed)) continue;
    if (paidSince(s)) { superseded += 1; continue; }
    // The row is claimed BEFORE the nudge, so a nudge that did not go out would
    // never be swept again. Hand the row back — only while it is still this
    // run's claim (status and stamp as written) — so the next run retries it
    // inside the session's window. A hand-back that matches nothing is a row
    // the webhook completed or another run took in between: nothing to retry.
    const unclaim = async () => {
      const { data: restored, error: restoreError } = await supabase
        .from('checkout_sessions')
        .update({ status: 'pending', abandoned_at: null })
        .eq('session_id', s.session_id)
        .eq('status', 'abandoned')
        .eq('abandoned_at', claimedAt)
        .select('session_id');
      if (restoreError || wroteNoRows(restored)) {
        console.error(`checkout_abandoned claim could not be handed back for ${s.session_id}; the nudge is lost:`, restoreError ?? 'no rows updated');
      }
    };
    try {
      // The result is READ. `fireAutomationEvent` reports a failed send as
      // `failures` and a refused read or reservation as `errors`; counting the
      // call itself as `fired` answered 200 ok for a nudge nobody received.
      const outcome = await fireAutomationEvent(supabase, {
        trigger: 'checkout_abandoned',
        email: s.email,
        name: s.name,
        subjectKey: eventSubjectKey('checkout_abandoned', [s.session_id]),
        context: { sessionId: s.session_id },
      });
      if (outcome.failures > 0 || outcome.errors > 0) {
        failed += 1;
        console.error(`checkout_abandoned nudge did not go out for ${s.session_id}:`, outcome);
        await unclaim();
      } else {
        fired += 1;
      }
    } catch (e) {
      failed += 1;
      console.error(`checkout_abandoned fire failed for ${s.session_id}:`, e);
      await unclaim();
    }
  }

  const ok = failed === 0;
  return NextResponse.json(
    { ok, pending: (pending ?? []).length, abandoned: abandoned.length, fired, superseded, failed },
    { status: ok ? 200 : 502 },
  );
}

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { countOrNull, type MetricCount } from './count';
import { summarizeRework, type ReworkSummary } from '@/lib/ai/activity';
import { decisionCompression, type DecisionCompression } from '@/lib/reasoning/engine';
import { conversionAfterValue, type ConversionAfterValue } from '@/lib/billing/conversion';
import { referralCoefficient, type ReferralCoefficient } from '@/lib/referrals/core';
import { FIRST_VALUE_MILESTONE } from '@/lib/analytics/activation';

type DB = SupabaseClient<Database>;

const DAY_MS = 86_400_000;
/** Rows read per metric. Enough for a platform this size; capped so one bad
 *  query cannot pull the whole ledger into a page render. */
const ROW_CAP = 2000;

/**
 * The four platform metrics the admin report shows: X3 rework, X5 decision
 * compression, X10 conversion after value, X12 referral coefficient.
 *
 * EVERY FIELD IS INDEPENDENTLY NULLABLE, and null means "we could not read it".
 * The tiles render an explicit unavailable state for a null; none of them falls
 * back to 0. That is the whole point of the section — a report that shows 0%
 * rework during an outage is worse than one that shows nothing, because
 * somebody will believe it.
 */
export type StrategyMetrics = {
  rework: ReworkSummary | null;
  compression: DecisionCompression | null;
  /** Distinguishes "no signals this week" (compression is null but read fine) from a failed read. */
  compressionRead: 'ok' | 'failed';
  conversion: ConversionAfterValue | null;
  referrals: ReferralCoefficient | null;
};

/**
 * Read the four metrics with the caller's client. The admin report passes the
 * SERVICE client, because these are platform-wide numbers over every family and
 * an RLS-scoped client would silently answer for one household.
 *
 * `windowDays` bounds the run/signal metrics; X10 and X12 are lifetime numbers,
 * because "did families who saw value ever pay" is not a weekly question.
 */
export async function loadStrategyMetrics(sb: DB, now: Date = new Date(), windowDays = 7): Promise<StrategyMetrics> {
  const sinceIso = new Date(now.getTime() - windowDays * DAY_MS).toISOString();

  const [
    runsRes, plansRes, eventsRes,
    signalCount, suggestionCount, recommendationCount, decidedCount,
    activationRes, subsRes, householdCount, referralRes, inviteRes, billingEventRes,
  ] = await Promise.all([
    sb.from('family_automation_runs').select('id, request_id, state').gte('created_at', sinceIso).limit(ROW_CAP),
    sb.from('ai_plans').select('request_id').gte('created_at', sinceIso).limit(ROW_CAP),
    sb.from('ai_run_events').select('run_id, event_type').gte('created_at', sinceIso).limit(ROW_CAP),

    countOrNull(sb.from('family_signals').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso), 'family signals'),
    countOrNull(sb.from('autopilot_suggestions').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso), 'autopilot suggestions'),
    countOrNull(sb.from('family_ai_recommendations').select('id', { count: 'exact', head: true }).gte('created_at', sinceIso), 'ai recommendations'),
    countOrNull(sb.from('approval_requests').select('id', { count: 'exact', head: true }).not('decided_at', 'is', null).gte('decided_at', sinceIso), 'approvals decided'),

    sb.from('activation_events').select('family_id, created_at').eq('milestone', FIRST_VALUE_MILESTONE).not('family_id', 'is', null).limit(ROW_CAP),
    // `created_at` is deliberately NOT selected: this repo writes one
    // subscriptions row per family at family creation and updates it in place,
    // so that column is the family's birthday, not the day it started paying.
    // `updated_at` (kept fresh by trg_set_updated_at) is the row's own upper
    // bound on the paid transition; the billing event below is the real one.
    sb.from('subscriptions').select('family_id, plan, status, updated_at').limit(ROW_CAP),
    countOrNull(sb.from('families').select('id', { count: 'exact', head: true }), 'families'),
    sb.from('referrals').select('status').limit(ROW_CAP),
    sb.from('invites').select('status').limit(ROW_CAP),
    // The billing EVENT: the webhook records one `admin_notifications` row of
    // kind 'subscription' the first time a family goes paid+active
    // (`isNewPaidConversion` fires once, not on renewals), with the family id in
    // `related_id`. That row's `created_at` IS the conversion instant.
    sb.from('admin_notifications').select('related_id, created_at')
      .eq('kind', 'subscription').not('related_id', 'is', null).limit(ROW_CAP),
  ]);

  // X3 — rework rate over the window's runs.
  let rework: ReworkSummary | null = null;
  if (runsRes.error || plansRes.error || eventsRes.error) {
    console.error('[metric] rework read failed', runsRes.error ?? plansRes.error ?? eventsRes.error);
  } else {
    const plansByRequest: Record<string, number> = {};
    for (const p of plansRes.data ?? []) {
      if (!p.request_id) continue;
      plansByRequest[p.request_id] = (plansByRequest[p.request_id] ?? 0) + 1;
    }
    rework = summarizeRework(
      (runsRes.data ?? []).map((r) => ({ id: r.id, request_id: r.request_id, state: r.state })),
      plansByRequest,
      (eventsRes.data ?? []).map((e) => ({ run_id: e.run_id, event_type: e.event_type })),
    );
  }

  // X5 — decision compression. A null from the pure function means "no signals",
  // which is a real answer; a failed count means we do not know, and the two are
  // reported separately so the tile can say which.
  const compressionRead: 'ok' | 'failed' =
    signalCount === null || suggestionCount === null || recommendationCount === null || decidedCount === null
      ? 'failed' : 'ok';
  const compression = compressionRead === 'ok'
    ? decisionCompression({
      rawSignals: (signalCount as number) + (suggestionCount as number) + (recommendationCount as number),
      humanDecisions: decidedCount as number,
    })
    : null;

  // X10 — conversion among families that reached first value.
  //
  // A failed billing-event read is NOT fatal here: the fallback is the paid
  // row's own `updated_at`, which the pure function then marks approximate. A
  // failed activation or subscription read is, because there is nothing left to
  // divide.
  let conversion: ConversionAfterValue | null = null;
  if (activationRes.error || subsRes.error) {
    console.error('[metric] conversion-after-value read failed', activationRes.error ?? subsRes.error);
  } else {
    if (billingEventRes.error) console.error('[metric] billing conversion events read failed', billingEventRes.error);
    const eventPaidAt = new Map<string, string>();
    for (const row of billingEventRes.data ?? []) {
      if (!row.related_id) continue;
      const prev = eventPaidAt.get(row.related_id);
      if (prev === undefined || row.created_at < prev) eventPaidAt.set(row.related_id, row.created_at);
    }
    conversion = conversionAfterValue(
      (activationRes.data ?? [])
        .filter((a): a is typeof a & { family_id: string } => Boolean(a.family_id))
        .map((a) => ({ familyId: a.family_id, reachedAt: a.created_at })),
      (subsRes.data ?? []).map((s) => {
        const event = eventPaidAt.get(s.family_id);
        return {
          familyId: s.family_id, plan: s.plan, status: s.status,
          paidAt: event ?? s.updated_at,
          basis: (event ? 'event' : 'row_updated_at') as 'event' | 'row_updated_at',
        };
      }),
    );
  }

  // X12 — new households per existing household.
  let referrals: ReferralCoefficient | null = null;
  if (referralRes.error || inviteRes.error || householdCount === null) {
    console.error('[metric] referral coefficient read failed', referralRes.error ?? inviteRes.error ?? 'household count read failed');
  } else {
    referrals = referralCoefficient({
      households: householdCount,
      referralRows: (referralRes.data ?? []).map((r) => ({ status: r.status })),
      inviteRows: (inviteRes.data ?? []).map((r) => ({ status: r.status })),
    });
  }

  return { rework, compression, compressionRead, conversion, referrals };
}

/** Per-family decision compression, for a household-scoped surface. */
export async function loadFamilyDecisionCompression(
  sb: DB,
  familyId: string,
  now: Date = new Date(),
  windowDays = 7,
): Promise<{ ok: true; data: DecisionCompression | null } | { ok: false }> {
  const sinceIso = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const scoped = (table: 'family_signals' | 'autopilot_suggestions' | 'family_ai_recommendations') =>
    sb.from(table).select('id', { count: 'exact', head: true }).eq('family_id', familyId).gte('created_at', sinceIso);

  const [signals, suggestions, recommendations, decided] = await Promise.all([
    countOrNull(scoped('family_signals'), 'family signals'),
    countOrNull(scoped('autopilot_suggestions'), 'autopilot suggestions'),
    countOrNull(scoped('family_ai_recommendations'), 'ai recommendations'),
    countOrNull(
      sb.from('approval_requests').select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).not('decided_at', 'is', null).gte('decided_at', sinceIso),
      'approvals decided',
    ),
  ]);

  const parts: MetricCount[] = [signals, suggestions, recommendations, decided];
  if (parts.some((p) => p === null)) return { ok: false };
  return {
    ok: true,
    data: decisionCompression({
      rawSignals: (signals as number) + (suggestions as number) + (recommendations as number),
      humanDecisions: decided as number,
    }),
  };
}

// TODO(S-15, needs migration): none of these is persisted. Charting them over
// time needs `family_metric_weeks` (and a platform-wide equivalent); the DDL is
// in the section's notes rather than in `supabase/migrations`, which only the
// repository owner writes to.

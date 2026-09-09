import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { summarizeRework, type ReworkSummary } from '@/lib/ai/activity';
import { decisionCompression, type DecisionCompression } from '@/lib/reasoning/engine';
import { conversionAfterValue, type ConversionAfterValue } from '@/lib/billing/conversion';
import { referralCoefficient, type ReferralCoefficient } from '@/lib/referrals/core';
import { FIRST_VALUE_MILESTONE } from '@/lib/analytics/activation';

type DB = SupabaseClient<Database>;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 400;
type PageQuery<T> = PromiseLike<{ data: T[] | null; error: unknown }> & {
  gt(column: 'id', value: string): PageQuery<T>;
};

/** Read to an empty page, including when the server imposes a smaller page cap.
 * IDs keep deletion of an earlier row from shifting subsequent pages. These
 * live reads share a time upper bound, but are not a database snapshot. */
async function readAll<T extends { id: string }>(makeQuery: () => PageQuery<T>): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (;;) {
    const query = makeQuery();
    const result: { data: T[] | null; error: unknown } = await (cursor === null ? query : query.gt('id', cursor));
    const { data, error } = result;
    if (error) throw error;
    if (!Array.isArray(data)) throw new Error('Missing metric rows');
    if (data.length === 0) return rows;
    for (const row of data) {
      if (typeof row.id !== 'string' || !row.id || (cursor !== null && row.id <= cursor)) {
        throw new Error('Nonadvancing metric cursor');
      }
      cursor = row.id;
      rows.push(row);
    }
  }
}

async function exactCount(makeQuery: () => PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count, error } = await makeQuery();
  if (error) throw error;
  if (count === null || !Number.isSafeInteger(count) || count < 0) throw new Error('Missing exact metric count');
  return count;
}

/** A rejected transport or query builder fails only its dependent metric. */
async function readMetric<T>(label: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    console.error(`[metric] ${label} read failed`, error);
    return null;
  }
}

export type StrategyMetrics = {
  rework: ReworkSummary | null;
  compression: DecisionCompression | null;
  /** Separates a failed read from a successful read with no signals. */
  compressionRead: 'ok' | 'failed';
  conversion: ConversionAfterValue | null;
  referrals: ReferralCoefficient | null;
};

/** Admin callers supply the service client for platform-wide numbers.
 * Runs/signals use the requested window. First-value and referral evidence is
 * lifetime through now; subscription status is current at the time of reading. */
export async function loadStrategyMetrics(sb: DB, now: Date = new Date(), windowDays = 7): Promise<StrategyMetrics> {
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const until = now.toISOString();
  const [rework, compressionResult, conversion, referrals] = await Promise.all([
    readMetric('rework', async () => {
      const [runs, plans, events] = await Promise.all([
        readAll(() => sb.from('family_automation_runs').select('id, request_id, state')
          .gte('created_at', since).lte('created_at', until).order('id').limit(PAGE_SIZE)),
        readAll(() => sb.from('ai_plans').select('id, request_id')
          .gte('created_at', since).lte('created_at', until).order('id').limit(PAGE_SIZE)),
        readAll(() => sb.from('ai_run_events').select('id, run_id, event_type')
          .gte('created_at', since).lte('created_at', until).order('id').limit(PAGE_SIZE)),
      ]);
      const plansByRequest: Record<string, number> = {};
      for (const plan of plans) {
        if (plan.request_id) plansByRequest[plan.request_id] = (plansByRequest[plan.request_id] ?? 0) + 1;
      }
      return summarizeRework(runs, plansByRequest, events);
    }),
    readMetric('decision compression', async () => {
      const [signals, suggestions, recommendations, decided] = await Promise.all([
        exactCount(() => sb.from('family_signals').select('id', { count: 'exact', head: true })
          .gte('created_at', since).lte('created_at', until)),
        exactCount(() => sb.from('autopilot_suggestions').select('id', { count: 'exact', head: true })
          .gte('created_at', since).lte('created_at', until)),
        exactCount(() => sb.from('family_ai_recommendations').select('id', { count: 'exact', head: true })
          .gte('created_at', since).lte('created_at', until)),
        exactCount(() => sb.from('approval_requests').select('id', { count: 'exact', head: true })
          .not('decided_at', 'is', null).gte('decided_at', since).lte('decided_at', until)),
      ]);
      return { data: decisionCompression({ rawSignals: signals + suggestions + recommendations, humanDecisions: decided }) };
    }),
    readMetric('recorded paid activations', async () => {
      const [activations, subscriptions, receipts] = await Promise.all([
        readAll(() => sb.from('activation_events').select('id, family_id, created_at')
          .eq('milestone', FIRST_VALUE_MILESTONE).not('family_id', 'is', null)
          .lte('created_at', until).order('id').limit(PAGE_SIZE)),
        readAll(() => sb.from('subscriptions').select('id, family_id, plan, status')
          .lte('created_at', until).order('id').limit(PAGE_SIZE)),
        readAll(() => sb.from('admin_notifications').select('id, kind, related_type, related_id, created_at, meta')
          .eq('kind', 'subscription').eq('related_type', 'subscription').not('related_id', 'is', null)
          .lte('created_at', until).order('id').limit(PAGE_SIZE)),
      ]);
      return conversionAfterValue(
        activations.filter((a): a is typeof a & { family_id: string } => Boolean(a.family_id))
          .map((a) => ({ familyId: a.family_id, reachedAt: a.created_at })),
        subscriptions.map((s) => ({ familyId: s.family_id, plan: s.plan, status: s.status })),
        receipts.map((r) => ({
          familyId: r.related_id, recordedAt: r.created_at, kind: r.kind, relatedType: r.related_type, meta: r.meta,
        })),
        now,
      );
    }),
    readMetric('referral coefficient', async () => {
      const [households, referralRows, inviteRows] = await Promise.all([
        exactCount(() => sb.from('families').select('id', { count: 'exact', head: true }).lte('created_at', until)),
        readAll(() => sb.from('referrals').select('id, status').lte('created_at', until).order('id').limit(PAGE_SIZE)),
        readAll(() => sb.from('invites').select('id, status').lte('created_at', until).order('id').limit(PAGE_SIZE)),
      ]);
      return referralCoefficient({ households, referralRows, inviteRows });
    }),
  ]);
  return {
    rework, compression: compressionResult?.data ?? null,
    compressionRead: compressionResult === null ? 'failed' : 'ok', conversion, referrals,
  };
}

/** Per-family decision compression, with the same bounded time window. */
export async function loadFamilyDecisionCompression(
  sb: DB, familyId: string, now: Date = new Date(), windowDays = 7,
): Promise<{ ok: true; data: DecisionCompression | null } | { ok: false }> {
  const since = new Date(now.getTime() - windowDays * DAY_MS).toISOString();
  const until = now.toISOString();
  const result = await readMetric('family decision compression', async () => {
    const scoped = (table: 'family_signals' | 'autopilot_suggestions' | 'family_ai_recommendations') =>
      sb.from(table).select('id', { count: 'exact', head: true }).eq('family_id', familyId)
        .gte('created_at', since).lte('created_at', until);
    const [signals, suggestions, recommendations, decided] = await Promise.all([
      exactCount(() => scoped('family_signals')), exactCount(() => scoped('autopilot_suggestions')),
      exactCount(() => scoped('family_ai_recommendations')),
      exactCount(() => sb.from('approval_requests').select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).not('decided_at', 'is', null).gte('decided_at', since).lte('decided_at', until)),
    ]);
    return { data: decisionCompression({ rawSignals: signals + suggestions + recommendations, humanDecisions: decided }) };
  });
  return result === null ? { ok: false } : { ok: true, data: result.data };
}

// TODO(S-15, needs migration): chart history requires family_metric_weeks and
// a platform-wide equivalent. Only the repository owner adds that schema.

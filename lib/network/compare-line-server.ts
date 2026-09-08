// Loads the persisted inputs for one family's weekly comparison line.
//
// Reads ONLY what the nightly aggregation already wrote — the family's consent
// row, its own banded contribution row and the cohort's published aggregates —
// so the digest can never claim a comparison the pipeline did not compute. A
// failed read is logged and yields null: the digest then simply carries no
// comparison line, which is the fail-closed answer for an optional claim.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { compareLine, type CompareLine } from './compare-line';
import type { ConsentState, ConsentScope } from './insights';
import type { NetworkAggregate } from './aggregate';

type DB = SupabaseClient<Database>;

export async function loadCompareLine(sb: DB, familyId: string): Promise<CompareLine | null> {
  const { data: consent, error: consentError } = await sb.from('network_consent')
    .select('enabled, scopes').eq('family_id', familyId).maybeSingle();
  if (consentError) {
    console.error(`[network] compare line consent read failed for ${familyId}`, consentError);
    return null;
  }
  const consentState: ConsentState = {
    enabled: consent?.enabled === true,
    scopes: ((consent?.scopes ?? {}) as ConsentState['scopes']),
  };
  // Cheapest exit: most families have not opted into benchmarks, and there is
  // nothing to read for them.
  if (!consentState.enabled || consentState.scopes.benchmarks !== true) return null;

  const { data: contribution, error: contributionError } = await sb.from('network_contributions')
    .select('cohort_key, metrics').eq('family_id', familyId).maybeSingle();
  if (contributionError) {
    console.error(`[network] compare line contribution read failed for ${familyId}`, contributionError);
    return null;
  }
  if (!contribution) return null;

  const { data: rows, error: aggregateError } = await sb.from('network_aggregates')
    .select('scope, cohort_key, metric, value, count, cohort_size')
    .eq('cohort_key', contribution.cohort_key).eq('scope', 'benchmarks').limit(500);
  if (aggregateError) {
    console.error(`[network] compare line aggregate read failed for ${familyId}`, aggregateError);
    return null;
  }
  const aggregates: NetworkAggregate[] = (rows ?? []).map((a) => ({
    scope: a.scope as ConsentScope, cohortKey: a.cohort_key, metric: a.metric,
    value: a.value, count: a.count, cohortSize: a.cohort_size,
  }));
  const metrics = (contribution.metrics && typeof contribution.metrics === 'object' && !Array.isArray(contribution.metrics)
    ? contribution.metrics : {}) as Record<string, unknown>;
  const banded: Record<string, string> = {};
  for (const [k, v] of Object.entries(metrics)) if (typeof v === 'string') banded[k] = v;

  return compareLine({ consent: consentState, cohortKey: contribution.cohort_key, metrics: banded }, aggregates);
}

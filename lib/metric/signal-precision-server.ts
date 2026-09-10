import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { countOrNull } from './count';
import { signalPrecision, type SignalPrecision } from './signal-precision';

type DB = SupabaseClient<Database>;
export type SignalPrecisionResult = { available: true; data: SignalPrecision } | { available: false };
type MetricScope = { familyId: string } | { allFamilies: true };

/** Family callers use their RLS client AND an explicit family id. Only the
 * guarded admin page passes allFamilies with its service client.
 *
 * family_signals has no resolved_at: updated_at records the current decision,
 * which detection preserves. Autopilot has its own resolved_at. Restoring a
 * signal removes its previous decision from this current-state measure; a
 * historical weekly series still requires family_metric_weeks (owner DDL). */
export async function loadSignalPrecision(sb: DB, scope: MetricScope, now = new Date()): Promise<SignalPrecisionResult> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const until = now.toISOString();
  if ('familyId' in scope && !scope.familyId) return { available: false };

  // Each async function owns builder throws and transport rejections before
  // the next read starts. A missing exact count is unavailable, never zero.
  async function count(table: 'family_signals' | 'autopilot_suggestions', statuses: string[]): Promise<number | null> {
    try {
      const timestamp = table === 'family_signals' ? 'updated_at' : 'resolved_at';
      let query = sb.from(table).select('id', { head: true, count: 'exact' })
        .in('status', statuses).gte(timestamp, since).lte(timestamp, until);
      if ('familyId' in scope) query = query.eq('family_id', scope.familyId);
      const result = await query;
      if (!result.error && (result.count === null || !Number.isSafeInteger(result.count) || result.count < 0)) {
        console.error('[metric] signal precision count unavailable', table);
        return null;
      }
      return await countOrNull(Promise.resolve(result), `signal precision ${table}`);
    } catch (error) {
      console.error('[metric] signal precision read failed', table, error);
      return null;
    }
  }

  const [acknowledged, signalsDismissed, accepted, suggestionsDismissed] = await Promise.all([
    count('family_signals', ['acknowledged']),
    count('family_signals', ['dismissed']),
    count('autopilot_suggestions', ['approved', 'executed', 'auto_executed']),
    count('autopilot_suggestions', ['dismissed']),
  ]);
  if (acknowledged === null || signalsDismissed === null || accepted === null || suggestionsDismissed === null) return { available: false };
  return { available: true, data: signalPrecision([
    { kind: 'family_signals', status: 'acknowledged', count: acknowledged },
    { kind: 'family_signals', status: 'dismissed', count: signalsDismissed },
    { kind: 'autopilot', status: 'approved', count: accepted },
    { kind: 'autopilot', status: 'dismissed', count: suggestionsDismissed },
  ]) };
}

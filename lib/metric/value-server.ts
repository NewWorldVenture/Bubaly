import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadCompletedValueRuns } from './value-runs-server';
import { annualListPriceCents, type FamilyValueResult } from './value';

/** Session-scoped clients only. A missing/failed price read never invents a free plan. */
export async function loadFamilyValue(
  db: SupabaseClient<Database>, familyId: string, now = new Date(),
): Promise<FamilyValueResult> {
  try {
    const { data: sub, error } = await db.from('subscriptions').select('family_id,plan,status')
      .eq('family_id', familyId).maybeSingle();
    if (error || !sub || sub.family_id !== familyId) {
      console.error('[family-value] subscription read incomplete', error);
      return { state: 'unavailable' };
    }
    const annualListCents = annualListPriceCents(sub.plan);
    if (annualListCents === null) return { state: 'unavailable' };
    if (!['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired', 'unpaid'].includes(sub.status)) return { state: 'unavailable' };
    if (annualListCents === 0 || sub.status !== 'active') return { state: 'ineligible' };
    const runs = await loadCompletedValueRuns(db, familyId, now);
    if (!runs.available) return { state: 'unavailable' };
    return { state: 'available', completedRuns: runs.completedRuns, undatedCompletedRuns: runs.undatedCompletedRuns, annualListCents };
  } catch (error) {
    console.error('[family-value] read failed', error);
    return { state: 'unavailable' };
  }
}

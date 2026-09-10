'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { loadFamilyValue } from '@/lib/metric/value-server';
import type { FamilyValueResult } from '@/lib/metric/value';

export type FamilyValueSnapshot = { familyId: string; result: FamilyValueResult };

export async function loadFamilyValueComparisonAction(): Promise<FamilyValueSnapshot> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  try {
    return { familyId, result: await loadFamilyValue(await createServer(), familyId) };
  } catch (error) {
    console.error('[family-value] client unavailable', error);
    return { familyId, result: { state: 'unavailable' } };
  }
}

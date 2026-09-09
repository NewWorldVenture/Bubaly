'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { loadTimeSaved } from '@/lib/metric/time-saved-server';
import type { TimeSavedResult } from '@/lib/metric/time-saved';

export type FamilyDeliveredValue = { familyId: string; result: TimeSavedResult };

/** The session chooses the household; callers cannot request another family's value. */
export async function loadFamilyDeliveredValueAction(): Promise<FamilyDeliveredValue> {
  // Authentication redirects must retain their normal behavior.
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  try {
    const db = await createServer();
    return { familyId, result: await loadTimeSaved(db, familyId) };
  } catch (error) {
    console.error('[billing-value] handled work read failed', error);
    return { familyId, result: { available: false } };
  }
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { billPaidPatch, type BillScheduleChoice } from './bill-schedule';
import { whereBillIsAsSeen, writeBillPatch, isMissingDueDayColumn, isDueDayNotKept } from './recurring';

/** Refuse missing snapshots; every retry keeps the same conditional write. */
export async function saveBillPayment(
  client: SupabaseClient<Database>,
  familyId: string,
  bill: Tables<'bills'> | null | undefined,
  today: string,
  choice?: BillScheduleChoice,
  reopen = false,
) {
  if (!bill?.updated_at)
    return { data: null, error: new Error('This bill changed. Refresh before marking it paid.') };
  const patch = reopen ? { status: 'upcoming' as const } : billPaidPatch(bill, today, choice);
  return writeBillPatch(patch, (p) =>
    whereBillIsAsSeen(
      client.from('bills').update(p).eq('id', bill.id).eq('family_id', familyId),
      bill,
    ).select('id'),
  );
}

/** Both an absent column and a refused unsafe fallback need the update notice. */
export function isMissingBillDueDay(error: unknown): boolean {
  return isMissingDueDayColumn(error) || isDueDayNotKept(error);
}

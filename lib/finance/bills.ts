import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { billPaidPatch, billSchedulePatch, type BillScheduleChoice } from './bill-schedule';
import { whereBillIsAsSeen, writeBillPatch, isMissingDueDayColumn, isDueDayNotKept } from './recurring';
import { readCountedRows } from '@/lib/calendar/occurrences';

/** Cached rows are only a first-paint prefix, never a complete financial list. */
export const BILL_READ_CONTRACT = 'complete-bills-v1';

export type BillScheduleSnapshot = Pick<Tables<'bills'>, 'id' | 'family_id' | 'updated_at' | 'due_date' | 'due_day' | 'status' | 'is_recurring' | 'recurrence'>;

export async function saveBillSchedule(client: SupabaseClient<Database>, familyId: string, bill: BillScheduleSnapshot, choice: BillScheduleChoice) {
  if (!bill || bill.family_id !== familyId || !familyId || typeof bill.id !== 'string' || !bill.id
    || typeof bill.updated_at !== 'string' || !Number.isFinite(Date.parse(bill.updated_at))
    || typeof bill.status !== 'string' || typeof bill.is_recurring !== 'boolean'
    || !(bill.recurrence === null || typeof bill.recurrence === 'string')
    || !(bill.due_day === undefined || bill.due_day === null || Number.isInteger(bill.due_day))) {
    return { data: null, error: new Error('Refresh this bill before confirming its schedule.') };
  }
  const patch = billSchedulePatch(bill, choice);
  return writeBillPatch(patch, p => whereBillIsAsSeen(
    client.from('bills').update(p).eq('id', bill.id).eq('family_id', familyId), bill,
  ).select('id'));
}

export async function readCompleteBills(client: SupabaseClient<Database>, familyId: string) {
  if (!familyId) return { data: null, error: { message: 'A family is required to read bills.' } };
  // `*` retains the payment CAS snapshot and works before the due_day migration.
  const query = () => client.from('bills').select('*', { count: 'exact' })
    .eq('family_id', familyId).order('due_date', { ascending: true }).order('id', { ascending: true });
  const result = await readCountedRows<Tables<'bills'>>(
    () => query().limit(1000), (from, to) => query().range(from, to), 10_000, 'bills',
  );
  if (result.error) return { data: null, error: {
    message: 'The complete bill list could not be loaded.', details: result.error.message,
  } };
  if (result.data?.some(row => row.family_id !== familyId)) {
    return { data: null, error: { message: 'The complete bill list could not be loaded.' } };
  }
  return result;
}

/** Refuse missing snapshots; every retry keeps the same conditional write. */
export async function saveBillPayment(
  client: SupabaseClient<Database>,
  familyId: string,
  bill: Tables<'bills'> | null | undefined,
  today: string,
  choice?: BillScheduleChoice,
  reopen = false,
  isCurrent: () => boolean = () => true,
) {
  if (!isCurrent()) return { data: null, error: new Error('This bill view is no longer current.') };
  if (!bill?.updated_at)
    return { data: null, error: new Error('This bill changed. Refresh before marking it paid.') };
  const patch = reopen ? { status: 'upcoming' as const } : billPaidPatch(bill, today, choice);
  return writeBillPatch(patch, (p) => {
    // Missing-column compatibility may retry after an awaited HTTP refusal.
    // Recheck the calling view before every dispatch, not only the first one.
    if (!isCurrent()) return Promise.resolve({ data: null, error: new Error('This bill view is no longer current.') });
    return whereBillIsAsSeen(
      client.from('bills').update(p).eq('id', bill.id).eq('family_id', familyId),
      bill,
    ).select('id');
  });
}

/** Both an absent column and a refused unsafe fallback need the update notice. */
export function isMissingBillDueDay(error: unknown): boolean {
  return isMissingDueDayColumn(error) || isDueDayNotKept(error);
}

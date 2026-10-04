import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';
import { billPaidPatch, type BillScheduleChoice } from './bill-schedule';

/** The update matches the occurrence the owner saw, including later edits. */
export async function saveBillPayment(
  client: SupabaseClient<Database>, familyId: string, bill: Tables<'bills'>,
  today: string, choice?: BillScheduleChoice, reopen = false,
) {
  const patch = reopen ? { status: 'upcoming' as const } : billPaidPatch(bill, today, choice);
  if (!patch || !bill.updated_at) return { data: null, error: new Error('Confirm this bill’s recurrence and day of month before marking it paid.') };
  let query = client.from('bills').update(patch).eq('id', bill.id).eq('family_id', familyId)
    .eq('updated_at', bill.updated_at).eq('due_date', bill.due_date).eq('status', bill.status)
    .eq('is_recurring', bill.is_recurring);
  query = bill.recurrence === null ? query.is('recurrence', null) : query.eq('recurrence', bill.recurrence);
  // Never retry without due_day: that would lose the original anchor forever.
  return query.select('id');
}

/** Only the exact column absence permits a read retry on an older schema. */
export function isMissingBillDueDay(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message } = error as { code?: string; message?: string };
  return (code === '42703' || code === 'PGRST204') && /\bdue_day\b/i.test(message ?? '');
}

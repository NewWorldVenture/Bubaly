import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Tables } from '@/lib/database.types';

type Page = { data: unknown[] | null; count: number | null; error: { message: string } | null };
const PAGE_SIZE = 1000;
export const CFO_ROW_LIMIT = 20_000;
export const CFO_EXPENSE_LIMIT = 50_000;

/** A broken existing column is not an optional, unprovisioned table. */
export function isCfoMissingTable(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return error.code === '42P01' || error.code === 'PGRST205';
}

/** Complete bounded reads, not a cross-table transaction snapshot. */
async function read<T>(page: (from: number, to: number) => PromiseLike<Page>, max: number, label: string) {
  const rows: T[] = [], ids = new Set<string>();
  let total: number | null = null;
  const fail = (reason: string) => ({ data: null, error: { message: `The ${label} summary is incomplete: ${reason}` } });
  try {
    for (;;) {
      const result = await page(rows.length, Math.min(rows.length + PAGE_SIZE, total ?? max) - 1);
      if (result.error) return { data: null, error: result.error };
      if (!Number.isSafeInteger(result.count) || result.count === null || result.count < 0) return fail('missing exact count');
      if (total !== null && total !== result.count) return fail('count changed while reading');
      total = result.count;
      if (total > max) return fail(`more than ${max} rows`);
      if (!Array.isArray(result.data)) return fail('page unavailable');
      for (const row of result.data) {
        const id = row && typeof row === 'object' && 'id' in row ? row.id : null;
        if (typeof id !== 'string' || !id || ids.has(id)) return fail('missing or repeated row identity');
        ids.add(id); rows.push(row as T);
      }
      if (rows.length > total) return fail('more rows than counted');
      if (rows.length === total) return { data: rows, error: null };
      if (!result.data.length) return fail('stopped before counted end');
    }
  } catch (cause) { return fail(cause instanceof Error ? cause.message : String(cause)); }
}

/** Keep the CFO tiles' own filters; the forecast answers a different window. */
export async function loadCfoSummaryRows(db: SupabaseClient<Database>, familyId: string, window: { today: string; in30: string; monthStart: string }) {
  const { today, in30, monthStart } = window;
  // Transaction dates are civil DATE values. Bound both sides of the named
  // month, including December rollover, without binding a device timezone.
  const nextMonth = new Date(`${monthStart}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = nextMonth.toISOString().slice(0, 10);
  return Promise.all([
    read<Tables<'financial_accounts'>>((from, to) => db.from('financial_accounts').select('*', { count: 'exact' }).eq('family_id', familyId).order('id').range(from, to), CFO_ROW_LIMIT, 'accounts'),
    read<Tables<'bills'>>((from, to) => db.from('bills').select('*', { count: 'exact' }).eq('family_id', familyId).neq('status', 'paid').gte('due_date', today).lte('due_date', in30).order('due_date').order('id').range(from, to), CFO_ROW_LIMIT, 'upcoming bills'),
    read<Tables<'savings_goals'>>((from, to) => db.from('savings_goals').select('*', { count: 'exact' }).eq('family_id', familyId).order('created_at').order('id').range(from, to), CFO_ROW_LIMIT, 'savings goals'),
    read<Pick<Tables<'transactions'>, 'id' | 'amount' | 'category' | 'type'>>((from, to) => db.from('transactions').select('id, amount, category, type', { count: 'exact' }).eq('family_id', familyId).eq('type', 'expense').gte('date', monthStart).lt('date', monthEnd).order('id').range(from, to), CFO_EXPENSE_LIMIT, 'monthly spending'),
    read<Tables<'budgets'>>((from, to) => db.from('budgets').select('*', { count: 'exact' }).eq('family_id', familyId).order('id').range(from, to), CFO_ROW_LIMIT, 'budgets'),
  ] as const);
}

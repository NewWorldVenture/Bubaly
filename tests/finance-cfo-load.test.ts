import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { CFO_EXPENSE_LIMIT, CFO_ROW_LIMIT, loadCfoSummaryRows } from '@/lib/finance/cfo-load';

const tables = ['financial_accounts', 'bills', 'savings_goals', 'transactions', 'budgets'] as const;
type Row = Record<string, string | number | null>;
const window = { today: '2026-10-08', in30: '2026-11-07', monthStart: '2026-10-01' };
function rows(table: string): Row[] {
  return [1, 1, 9000].map((amount, i) => ({ id: `${table}-${i}`, family_id: 'family', balance: amount, amount, type: table === 'transactions' ? 'expense' : 'checking', category: 'Food', status: 'unpaid', due_date: '2026-10-15', date: '2026-10-08', created_at: '2026-10-08' }));
}
type Fault = (table: string, call: number, data: Row[], count: number) => { data?: unknown; count?: number | null; status?: number; error?: object } | undefined;
function server(options: { cap?: number; fault?: Fault; expenseDate?: string; extra?: Partial<Record<typeof tables[number], Row[]>> } = {}) {
  const calls: URL[] = [], counts: Record<string, number> = {};
  const db = createClient<Database>('https://synthetic.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)), table = url.pathname.split('/').pop()!;
    calls.push(url); const call = counts[table] = (counts[table] ?? 0) + 1;
    expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
    expect(url.searchParams.get('family_id')).toBe('eq.family');
    expect(url.searchParams.get('order')).toMatch(/(?:^|,)id\.asc(?:,|$)/);
    let all = [...rows(table).map(row => table === 'transactions' && options.expenseDate ? { ...row, date: options.expenseDate } : row), ...(options.extra?.[table as typeof tables[number]] ?? [])];
    for (const [column, condition] of url.searchParams) {
      if (!/^(eq|neq|gte|lte|lt)\./.test(condition)) continue;
      const [op, ...rest] = condition.split('.'); const value = rest.join('.');
      all = all.filter(row => { const actual = row[column]; if (actual == null) return false; const a = String(actual); return op === 'eq' ? a === value : op === 'neq' ? a !== value : op === 'gte' ? a >= value : op === 'lte' ? a <= value : a < value; });
    }
    const order = url.searchParams.get('order')!.split(',').map(s => s.split('.')[0]);
    all.sort((a, b) => { for (const key of order) { const cmp = String(a[key]).localeCompare(String(b[key])); if (cmp) return cmp; } return 0; });
    const from = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 1000);
    const data = all.slice(from, from + Math.min(limit, options.cap ?? 2));
    const fault = options.fault?.(table, call, data, all.length);
    const count = fault && 'count' in fault ? fault.count : all.length;
    return new Response(JSON.stringify(fault?.error ?? (fault && 'data' in fault ? fault.data : data)), { status: fault?.status ?? 200, headers: { 'Content-Type': 'application/json', ...(count == null ? {} : { 'Content-Range': `${data.length ? `${from}-${from + data.length - 1}` : '*'}/${count}` }) } });
  } } });
  return { db, calls };
}

describe('Family CFO summary reads use actual counted SDK pages', () => {
  it.each([1, 2, 3])('preserves every figure under a server cap of %s', async cap => {
    const { db, calls } = server({ cap }); const results = await loadCfoSummaryRows(db, 'family', window);
    for (const result of results) { expect(result.error).toBeNull(); expect(result.data).toHaveLength(3); }
    expect(results[0].data!.reduce((sum, a) => sum + Number(a.balance), 0)).toBe(9002);
    expect(results[3].data!.reduce((sum, t) => sum + Number(t.amount), 0)).toBe(9002);
    expect(calls.filter(u => u.pathname.endsWith('transactions')).map(u => Number(u.searchParams.get('offset')))).toEqual(cap === 1 ? [0, 1, 2] : cap === 2 ? [0, 2] : [0]);
  });
  it('keeps family, upcoming-bill and expense filters on every page', async () => {
    const { db } = server({ cap: 1, extra: { financial_accounts: [{ ...rows('financial_accounts')[0], id: 'foreign', family_id: 'other', balance: 999999 }], bills: [{ ...rows('bills')[0], id: 'paid', status: 'paid' }, { ...rows('bills')[0], id: 'early', due_date: '2026-10-07' }, { ...rows('bills')[0], id: 'late', due_date: '2026-11-08' }], transactions: [{ ...rows('transactions')[0], id: 'income', type: 'income' }, { ...rows('transactions')[0], id: 'previous', date: '2026-09-30' }] } });
    const result = await loadCfoSummaryRows(db, 'family', window); expect(result.map(r => r.data?.length)).toEqual([3, 3, 3, 3, 3]);
  });
  it.each([['2026-10-01', '2026-11-01'], ['2026-12-01', '2027-01-01'], ['2024-02-01', '2024-03-01']])('monthly spending from %s excludes %s and later', async (monthStart, nextMonth) => {
    const { db } = server({ expenseDate: monthStart, extra: { transactions: [{ ...rows('transactions')[0], id: 'future-month', date: nextMonth, amount: 999999 }] } });
    const result = await loadCfoSummaryRows(db, 'family', { ...window, monthStart });
    expect(result[3].data?.some(row => row.id === 'future-month')).toBe(false);
    expect(result[3].data).toHaveLength(3);
  });
  it.each(tables)('refuses missing count metadata for %s', async table => {
    const { db } = server({ fault: t => t === table ? { count: null } : undefined }); const result = (await loadCfoSummaryRows(db, 'family', window))[tables.indexOf(table)]; expect(result.data).toBeNull(); expect(result.error?.message).toContain('count');
  });
  it.each(tables)('refuses count drift for %s', async table => {
    const { db } = server({ fault: (t, call) => t === table && call === 2 ? { count: 4 } : undefined }); const result = (await loadCfoSummaryRows(db, 'family', window))[tables.indexOf(table)]; expect(result.data).toBeNull(); expect(result.error?.message).toContain('changed');
  });
  it.each(tables)('refuses missing and repeated identities for %s', async table => {
    for (const data of [[{ amount: 1 }], [rows(table)[0]]]) {
      const { db } = server({ cap: 1, fault: (t, call) => t === table && call === 2 ? { data } : undefined }); const result = (await loadCfoSummaryRows(db, 'family', window))[tables.indexOf(table)]; expect(result.data).toBeNull(); expect(result.error?.message).toContain('identity');
    }
  });
  it.each(tables)('refuses premature empty pages and unavailable pages for %s', async table => {
    for (const data of [[], null]) {
      const { db } = server({ cap: 1, fault: (t, call) => t === table && call === 2 ? { data } : undefined }); const result = (await loadCfoSummaryRows(db, 'family', window))[tables.indexOf(table)]; expect(result.data).toBeNull(); expect(result.error).not.toBeNull();
    }
  });
  it.each(tables)('returns permission and missing-table errors rather than inventing zero for %s', async table => {
    for (const code of ['42501', 'PGRST205']) {
      const { db } = server({ fault: t => t === table ? { status: code === '42501' ? 403 : 404, error: { code, message: 'synthetic refusal', details: null, hint: null } } : undefined }); const result = (await loadCfoSummaryRows(db, 'family', window))[tables.indexOf(table)]; expect(result.data).toBeNull(); expect(result.error).toMatchObject({ code });
    }
  });
  it.each(tables)('refuses an over-limit %s without reading a prefix as complete', async table => {
    const max = table === 'transactions' ? CFO_EXPENSE_LIMIT : CFO_ROW_LIMIT;
    const { db, calls } = server({ fault: t => t === table ? { count: max + 1 } : undefined }); const result = (await loadCfoSummaryRows(db, 'family', window))[tables.indexOf(table)]; expect(result.data).toBeNull(); expect(result.error?.message).toContain(`more than ${max}`); expect(calls.filter(u => u.pathname.endsWith(table))).toHaveLength(1);
  });
  it('settles transport rejection for one collection while preserving successful reads', async () => {
    const { db } = server({ fault: t => { if (t === 'transactions') throw new Error('synthetic offline'); return undefined; } }); const result = await loadCfoSummaryRows(db, 'family', window); expect(result[3].data).toBeNull(); expect(result[3].error?.message).toContain('synthetic offline'); expect(result[0].data).toHaveLength(3);
  });
});

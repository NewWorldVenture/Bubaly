import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

// The real Family CFO page, the real forecast loader and the actual Supabase
// SDK, against a database that has not applied the held 0488 (bills.due_day).
// Owner decision: until it is applied the dashboard loads as production did
// before 0488 — a bill due on the 28th–30th, or a recurring bill without a
// cadence, steps from its due date's own day — and only the exact
// missing-column answer selects that behaviour.
const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({ requireFeature: async () => ({ active: { familyId: 'family', family: { timezone: 'UTC' } } }) }));
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: async () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' } }) }));
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async () => ({ fmtMoney: (cents: number) => `USD:${cents}` }) }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: 'PageHeader' }));
vi.mock('@/components/family/shell', () => ({ StatTile: 'StatTile', SectionCard: 'SectionCard', MiniEmpty: 'MiniEmpty' }));
vi.mock('@/components/ui/states', () => ({ ErrorState: 'ErrorState' }));
vi.mock('@/components/modules/handle-it-button', () => ({ HandleItButton: 'HandleItButton' }));
vi.mock('@/components/finance/affordability-scenario', () => ({ AffordabilityScenario: 'AffordabilityScenario' }));
import FamilyCfoPage from '@/app/(app)/dashboard/family-cfo/page';
import { resetDueDayWarningForTests } from '@/lib/finance/recurring';

type Node = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node; return [node, ...nodes(node.props.children)];
}
const BILLS = [
  { id: 'bill-30th', name: 'Rent', amount: 1000, due_date: '2026-10-30', is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: false },
  { id: 'bill-28th', name: 'Power', amount: 80, due_date: '2026-10-28', is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: false },
  { id: 'bill-legacy', name: 'Water', amount: 40, due_date: '2026-10-29', is_recurring: true, recurrence: null, status: 'upcoming', category: null, autopay: false },
];
/** `forecastBills` answers the forecast's select naming due_day; null serves the column. */
function fixture(forecastBills: { code: string; message: string } | null, rows: Record<string, unknown>[] = BILLS) {
  const billSelects: string[] = [];
  h.db = createClient<Database>('https://synthetic-cfo.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input) => {
      const url = new URL(String(input));
      const table = url.pathname.split('/').pop()!;
      const select = url.searchParams.get('select') ?? '';
      if (table !== 'bills') return Response.json([], { headers: { 'content-range': '*/0' } });
      billSelects.push(select);
      if (forecastBills && select.split(',').some(c => c.trim() === 'due_day')) return Response.json(forecastBills, { status: 400 });
      const shaped = rows.map(row => select === '*' ? row : Object.fromEntries(select.split(',').map(c => [c.trim(), row[c.trim()] ?? null])));
      return Response.json(shaped, { headers: { 'content-range': `0-${shaped.length - 1}/${shaped.length}` } });
    } },
  });
  return billSelects;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
  resetDueDayWarningForTests();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Family CFO and its 12-week forecast without bills.due_day (0488 held)', () => {
  it.each([
    { code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache" },
    { code: '42703', message: 'column bills.due_day does not exist' },
  ])('loads for month-end and cadence-less bills on the exact $code answer, warning once with the migration', async (answer) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const selects = fixture(answer);
    const tree = nodes(await FamilyCfoPage());
    expect(tree.some(n => n.type === 'ErrorState')).toBe(false);
    expect(tree.some(n => n.type === 'StatTile')).toBe(true);
    expect(selects.filter(s => s !== '*')).toEqual([
      'id,name,amount,due_date,due_day,is_recurring,recurrence,status,category,autopay',
      'id,name,amount,due_date,is_recurring,recurrence,status,category,autopay',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('0488_a_month_end_bill_keeps_its_day.sql');
    // A second load in the same process does not warn again.
    fixture(answer); await FamilyCfoPage();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: '42501', message: 'permission denied for table bills' },
    { code: '42703', message: 'column bills.due_day_backup does not exist' },
    { code: 'PGRST205', message: "Could not find the table 'public.bills' in the schema cache" },
  ])('fails closed on another answer ($code) instead of falling back', async (answer) => {
    const selects = fixture(answer);
    const tree = nodes(await FamilyCfoPage());
    expect(tree.some(n => n.type === 'ErrorState')).toBe(true);
    expect(tree.some(n => n.type === 'StatTile')).toBe(false);
    expect(selects.filter(s => s !== '*')).toHaveLength(1);
  });

  it('loads with the column present and anchored rows, reading once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const selects = fixture(null, BILLS.map(row => ({ ...row, recurrence: 'monthly', due_day: Number(row.due_date.slice(8)) })));
    const tree = nodes(await FamilyCfoPage());
    expect(tree.some(n => n.type === 'ErrorState')).toBe(false);
    expect(tree.some(n => n.type === 'StatTile')).toBe(true);
    expect(selects.filter(s => s !== '*')).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
});

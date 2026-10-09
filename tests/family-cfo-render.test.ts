import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

// Execute the real async page, real counted loader and actual Supabase SDK.
// Only auth, display components and the separately qualified forecast read
// are replaced; summary figures and failure classification are not mocked.
const h = vi.hoisted(() => ({ db: null as unknown, forecast: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireFeature: async () => ({ active: { familyId: 'family', family: { timezone: 'UTC' } } }) }));
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: async () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' } }) }));
vi.mock('@/lib/utils/format-server', () => ({ getFormat: async () => ({ fmtMoney: (cents: number) => `USD:${cents}` }) }));
vi.mock('@/lib/finance/timeline-load', () => ({ loadMoneyTimelineInput: h.forecast }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: 'PageHeader' }));
vi.mock('@/components/family/shell', () => ({ StatTile: 'StatTile', SectionCard: 'SectionCard', MiniEmpty: 'MiniEmpty' }));
vi.mock('@/components/ui/states', () => ({ ErrorState: 'ErrorState' }));
vi.mock('@/components/modules/handle-it-button', () => ({ HandleItButton: 'HandleItButton' }));
vi.mock('@/components/finance/affordability-scenario', () => ({ AffordabilityScenario: 'AffordabilityScenario' }));
import FamilyCfoPage from '@/app/(app)/dashboard/family-cfo/page';

const tables = ['financial_accounts', 'bills', 'savings_goals', 'transactions', 'budgets'] as const;
type Node = { type: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node; return [node, ...nodes(node.props.children)];
}
function fixture(faultTable?: string, code?: string) {
  const requests: URL[] = [];
  h.db = createClient<Database>('https://synthetic-cfo.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input)); requests.push(url);
      const table = url.pathname.split('/').pop()!;
      expect(url.searchParams.get('family_id')).toBe('eq.family');
      expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
      if (table === faultTable) return Response.json({ code, message: `Synthetic ${code} refusal`, details: null, hint: null }, { status: code === '42501' ? 403 : 400 });
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const rows = [1, 1, 9000].slice(offset, offset + 2).map((amount, n) => ({
        id: `${table}-${offset + n}`, family_id: 'family', balance: amount, amount,
        type: table === 'financial_accounts' ? 'checking' : 'expense', category: 'Food', name: 'Synthetic item',
        due_date: '2026-10-15', date: '2026-10-08', status: 'unpaid', target_amount: 10000, current_amount: 0,
      }));
      return Response.json(rows, { headers: { 'content-range': `${offset}-${offset + rows.length - 1}/3` } });
    } },
  });
  return requests;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
  h.forecast.mockReset().mockResolvedValue({ bills: [], goals: [], events: [], startingBalance: 0, now: new Date('2026-10-08T12:00:00Z') });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('actual Family CFO rendered summary boundary', () => {
  it('renders complete 9002 figures despite an actual SDK response cap of two', async () => {
    const requests = fixture(); const tree = nodes(await FamilyCfoPage());
    expect(tree.find(n => n.type === 'StatTile' && n.props.label === 'dashboardFamilyCfo.netPosition')?.props.value).toBe('USD:900200');
    expect(tree.find(n => n.type === 'StatTile' && n.props.label === 'dashboardFamilyCfo.spentThisMonth')?.props.value).toBe('USD:900200');
    expect(tree.some(n => n.type === 'ErrorState')).toBe(false);
    expect(requests.filter(u => u.pathname.endsWith('transactions')).map(u => u.searchParams.get('offset'))).toEqual(['0', '2']);
  });
  it.each(tables.flatMap(table => ['PGRST204', '42703', '42501'].map(code => [table, code] as const)))('fails closed before money tiles when %s returns %s', async (table, code) => {
    fixture(table, code); const tree = nodes(await FamilyCfoPage());
    expect(tree.some(n => n.type === 'ErrorState')).toBe(true);
    expect(tree.some(n => n.type === 'StatTile')).toBe(false);
    expect(tree.some(n => n.type === 'MiniEmpty')).toBe(false);
    expect(h.forecast).not.toHaveBeenCalled();
  });
  it.each(tables.flatMap(table => ['PGRST205', '42P01'].map(code => [table, code] as const)))('preserves intentional absent-table behavior for %s / %s with a healthy forecast', async (table, code) => {
    fixture(table, code); const tree = nodes(await FamilyCfoPage());
    expect(tree.some(n => n.type === 'ErrorState')).toBe(false);
    expect(tree.some(n => n.type === 'StatTile')).toBe(true);
    expect(h.forecast).toHaveBeenCalledOnce();
  });
  it('renders an error rather than summary tiles if the separate forecast read fails', async () => {
    fixture(); h.forecast.mockRejectedValueOnce(new Error('Synthetic forecast failure'));
    const tree = nodes(await FamilyCfoPage()); expect(tree.some(n => n.type === 'ErrorState')).toBe(true); expect(tree.some(n => n.type === 'StatTile')).toBe(false);
  });
});

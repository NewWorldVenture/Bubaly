import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BILL_READ_CONTRACT, readCompleteBills } from '@/lib/finance/bills';
import type { Database, Tables } from '@/lib/database.types';
import * as cache from '@/lib/offline/cache';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { bill } from './helpers/recurring-bill-store';

type Bill = Tables<'bills'>;
const family = 'synthetic-family';
const rows = Array.from({ length: 5 }, (_, i) => bill({ id: `bill${i}`, name: `Synthetic bill ${i}`, amount: i === 4 ? 9000 : 1 }));
type Mode = 'ok' | 'no-count' | 'changed-count' | 'duplicate' | 'empty-page' | 'later-403' | 'null' | 'too-many' | 'wrong-family' | 'transport';
function database(mode: Mode = 'ok', inputRows = rows) {
  const requests: { url: URL; headers: Headers }[] = [];
  const client = createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      requests.push({ url, headers });
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (mode === 'transport' && offset) throw new Error('synthetic transport refusal');
      if (mode === 'later-403' && offset) return Response.json({ code: '42501', message: 'synthetic denied' }, { status: 403 });
      const filtered = inputRows.filter(row => `eq.${row.family_id}` === url.searchParams.get('family_id'))
        .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id));
      let page = filtered.slice(offset, offset + Math.min(Number(url.searchParams.get('limit') ?? 2), 2));
      if (mode === 'duplicate' && offset) page = filtered.slice(0, 2);
      if (mode === 'empty-page' && offset) page = [];
      if (mode === 'wrong-family') page = page.map(row => ({ ...row, family_id: 'synthetic-other' }));
      const count = mode === 'too-many' ? 10_001 : filtered.length + (mode === 'changed-count' && offset ? 1 : 0);
      return Response.json(mode === 'null' ? null : page, { headers: {
        'content-range': `${offset}-${offset + Math.max(0, page.length - 1)}/${mode === 'no-count' ? '*' : count}`,
      } });
    } },
  });
  return { client, requests };
}

/** Execute each real UI's options, including its owner-sensitive dependency key. */
const consumers = ['components/finance/bills-view.tsx', 'components/modules/billing-module.tsx', 'components/modules/finances-module.tsx'].map(file => {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const options: ts.ObjectLiteralExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'useRealtimeQuery') {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg) && arg.properties.some(p => ts.isPropertyAssignment(p)
        && p.name.getText(source) === 'table' && p.initializer.getText(source) === "'bills'")) options.push(arg);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (options.length !== 1) throw new Error(`Expected exactly one bills reader in ${file}`);
  const js = ts.transpileModule(`return (${options[0].getText(source)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return { file, options: new Function('familyId', 'userId', 'BILL_READ_CONTRACT', 'readCompleteBills', js) as
    (familyId: string, userId: string, contract: string, read: typeof readCompleteBills) => {
      table: string; familyId: string; deps: unknown[]; fetcher: (client: SupabaseClient<Database>) => ReturnType<typeof readCompleteBills>;
    } };
});

describe.each(consumers)('$file complete bills', ({ options }) => {
  it('reads past the actual SDK cap, keeps full payment snapshots, and includes the last bill in the total', async () => {
    const db = database('ok', [...rows].reverse().concat(bill({ id: 'foreign', family_id: 'synthetic-other', amount: 100000 })));
    const query = options(family, 'owner-a', BILL_READ_CONTRACT, readCompleteBills);
    const result = await query.fetcher(db.client);
    expect(result.error).toBeNull();
    expect(result.data?.map(row => row.id)).toEqual(rows.map(row => row.id));
    expect(result.data?.reduce((total, row) => total + row.amount, 0)).toBe(9004);
    expect(result.data?.every(row => row.updated_at === rows[0].updated_at)).toBe(true);
    expect(db.requests.map(r => Number(r.url.searchParams.get('offset') ?? 0))).toEqual([0, 2, 4]);
    for (const request of db.requests) {
      expect(request.url.searchParams.get('select')).toBe('*');
      expect(request.url.searchParams.get('family_id')).toBe(`eq.${family}`);
      expect(request.url.searchParams.get('order')).toBe('due_date.asc,id.asc');
      expect(request.headers.get('Prefer')).toContain('count=exact');
    }
  });
  it.each<Mode>(['no-count', 'changed-count', 'duplicate', 'empty-page', 'later-403', 'null', 'too-many', 'wrong-family', 'transport'])('refuses all partial rows on %s', async mode => {
    const db = database(mode);
    const result = await options(family, 'owner-a', BILL_READ_CONTRACT, readCompleteBills).fetcher(db.client);
    expect(result.data).toBeNull();
    expect(result.error?.message).toBe('The complete bill list could not be loaded.');
    expect(result.error?.message).not.toContain('calendar');
    // The installed SDK retries a transport failure, but not a denied HTTP read.
    expect(db.requests.length).toBeLessThanOrEqual(mode === 'transport' ? 5 : 3);
  });
  it('supports the older schema without asking for or guessing due_day', async () => {
    const db = database();
    const result = await options(family, 'owner-a', BILL_READ_CONTRACT, readCompleteBills).fetcher(db.client);
    expect(result.error).toBeNull();
    expect(result.data?.[0]).not.toHaveProperty('due_day');
  });
  it('distinguishes a complete zero from a refusal and never queries without a family', async () => {
    const db = database('ok', []);
    expect(await options(family, 'owner-a', BILL_READ_CONTRACT, readCompleteBills).fetcher(db.client)).toEqual({ data: [], error: null });
    expect((await options('', 'owner-a', BILL_READ_CONTRACT, readCompleteBills).fetcher(db.client)).data).toBeNull();
    expect(db.requests).toHaveLength(1);
  });
});

const ui = vi.hoisted(() => ({ siblings: {} as Record<string, {loading?: boolean; error?: string | null}>, bills: { data: [] as unknown[], loading: false, stale: false, error: null as string | null } }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'synthetic-family', userId: 'owner-a', role: 'owner', members: [] }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: ({ table }: { table: string }) => ({
  ...(table === 'bills' ? ui.bills : { data: [], loading: false, stale: false, error: null, ...ui.siblings[table] }), refresh() {},
}) }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string) => key, useLocale: () => ({ code: 'en-US' }), useFamilyTimeZone: () => 'UTC',
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success() {}, error() {} }) }));
vi.mock('@/components/ui/confirm', () => ({ useConfirm: () => async () => false }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock('@/lib/hooks/use-billing-subscription', () => ({ useBillingSubscription: () => ({ subscription: null, status: 'ready', reload() {}, isCurrentReady: () => true }) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/components/billing/family-delivered-value', () => ({ FamilyDeliveredValue: () => null }));
vi.mock('@/components/billing/family-value-comparison', () => ({ FamilyValueComparison: () => null }));
vi.mock('@/app/(app)/dashboard/billing/actions', () => ({
  createSavingsGoalAction() {}, createTransactionAction() {}, deleteBudgetAction() {}, deleteSavingsGoalAction() {}, deleteTransactionAction() {}, setBudgetAction() {},
}));
const { BillsView } = await import('@/components/finance/bills-view');
const { BillingModule } = await import('@/components/modules/billing-module');
const { FinancesModule } = await import('@/components/modules/finances-module');
describe('actual bill consumer presentation', () => {
  const views = [
    { view: () => React.createElement(BillsView, { mode: 'all' }), amount: '9,004.00' },
    { view: () => React.createElement(BillingModule), amount: '9,000.00' },
    { view: () => React.createElement(FinancesModule), amount: '9,000.00' },
  ];
  it.each(views)('includes the final capped-page bill in rendered financial figures', async ({ view, amount }) => {
    const complete = await readCompleteBills(database().client, family);
    ui.bills = { data: complete.data!, loading: false, stale: false, error: null };
    const html = renderToStaticMarkup(view());
    expect(html).toContain(amount);
    expect(html).toContain('Synthetic bill 4');
  });
  it.each(views)('hides retained rows, totals and payment controls on error, pending and cached-prefix states', ({ view }) => {
    for (const state of [
      { loading: false, stale: true, error: 'complete bills unavailable' },
      { loading: true, stale: false, error: null },
      { loading: false, stale: true, error: null },
    ]) {
      ui.bills = { data: rows, ...state };
      const html = renderToStaticMarkup(view());
      expect(html).not.toContain('Synthetic bill');
      expect(html).not.toContain('9,004.00');
      expect(html).not.toContain('No bills yet');
      expect(html).not.toContain('bills.markPaid');
    }
  });
});

/** Real hook bytes with a deterministic effect scheduler; no hook implementation substitute. */
function hookHost(client: SupabaseClient<Database>, cached = false) {
  const slots: unknown[] = [];
  let cursor = 0;
  const effects: (() => void)[] = [];
  const cleanups = new Set<() => void>();
  let authScope: null | { key: string; familyId: string; partition: cache.CachePartition } = cached ? {
    key: 'synthetic-auth', familyId: family, partition: { userId: 'owner-a', sessionId: 'synthetic-session', accessIdentity: 'synthetic-access' },
  } : null;
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  function memo(make: () => unknown, deps?: unknown[]) {
    const index = cursor++, prior = slots[index] as { value: unknown; deps?: unknown[] } | undefined;
    if (!prior || !same(prior.deps, deps)) slots[index] = { value: make(), deps };
    return (slots[index] as { value: unknown }).value;
  }
  const react = {
    useMemo: memo, useCallback: (callback: unknown, deps: unknown[]) => memo(() => callback, deps),
    useRef: (initial: unknown) => { const index = cursor++; return slots[index] ??= { current: initial }; },
    useState: (initial: unknown) => {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next: unknown) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = cursor++, prior = slots[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
      if (prior && same(prior.deps, deps)) return;
      effects.push(() => {
        prior?.cleanup?.();
        if (prior?.cleanup) cleanups.delete(prior.cleanup);
        const cleanup = effect();
        slots[index] = { deps, cleanup };
        if (cleanup) cleanups.add(cleanup);
      });
    },
  };
  const map: Record<string, unknown> = {
    react,
    '@/lib/supabase/client': { createClient: () => client },
    '@/lib/supabase/errors': { describeDbError: (e: { message: string }) => e.message },
    '@/lib/offline/cache': cache,
    '@/lib/offline/cache-scope': { useAuthenticatedCacheScope: () => authScope, isAuthenticatedCacheScopeCurrent: (scope: unknown) => scope === authScope },
    '@/lib/realtime/published-tables': { realtimeChannelFor: () => null },
    '@/lib/realtime/own-channel': { ownChannel: () => { throw new Error('Unexpected channel'); } },
  };
  const exports: { useRealtimeQuery?: (options: ReturnType<typeof consumers[0]['options']>) => { data: Bill[]; loading: boolean; stale: boolean; error: string | null; refresh: () => Promise<void> } } = {};
  const source = ts.transpileModule(readFileSync('lib/hooks/use-realtime-query.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function('require', 'exports', source)((id: string) => {
    if (!(id in map)) throw new Error(`Unexpected real hook import ${id}`);
    return map[id];
  }, exports);
  return {
    render(options: ReturnType<typeof consumers[0]['options']>) { cursor = 0; return exports.useRealtimeQuery!(options); },
    flush() { effects.splice(0).forEach(run => run()); },
    dispose() { cleanups.forEach(run => run()); },
    scope: authScope,
    clearScope() { authScope = null; },
  };
}
function deferred() { let resolve!: (response: Response) => void; const promise = new Promise<Response>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(() => vi.unstubAllGlobals());
describe.each(consumers)('$file real hook owner/cache boundary', ({ options }) => {
  it('rejects late same-family owner and family ABA responses in network-only mode', async () => {
    const pending: ReturnType<typeof deferred>[] = [];
    const client = createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: () => { const request = deferred(); pending.push(request); return request.promise; } },
    });
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    const host = hookHost(client);
    const a = options(family, 'owner-a', BILL_READ_CONTRACT, readCompleteBills);
    host.render(a); host.flush();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const b = options(family, 'owner-b', BILL_READ_CONTRACT, readCompleteBills);
    expect(host.render(b)).toMatchObject({ data: [], loading: true }); host.flush();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const other = options('synthetic-other', 'owner-b', BILL_READ_CONTRACT, readCompleteBills);
    host.render(other); host.flush();
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    expect(host.render(a)).toMatchObject({ data: [], loading: true }); host.flush();
    await vi.waitFor(() => expect(pending).toHaveLength(4));
    for (const request of pending.slice(0, 3)) request.resolve(Response.json([rows[0]], { headers: { 'content-range': '0-0/1' } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(host.render(a)).toMatchObject({ data: [], loading: true });
    pending[3].resolve(Response.json([rows[4]], { headers: { 'content-range': '0-0/1' } }));
    await vi.waitFor(() => expect(host.render(a)).toMatchObject({ data: [rows[4]], loading: false, stale: false, error: null }));
    host.dispose();
  });
  it('marks a real 200-row persisted prefix stale and never treats failed revalidation as complete', async () => {
    const storage = new Map<string, string>();
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
    }, addEventListener() {}, removeEventListener() {} });
    const db = database('later-403');
    const host = hookHost(db.client, true);
    const query = options(family, 'owner-a', BILL_READ_CONTRACT, readCompleteBills);
    const identity = cache.cacheIdentity(host.scope!.partition, 'bills', family, query.deps)!;
    cache.writePartitionedCache(identity, Array.from({ length: 205 }, (_, i) => bill({ id: `cached${i}` })));
    expect(cache.readPartitionedCache(identity)?.rows).toHaveLength(200);
    host.render(query); host.flush();
    expect(host.render(query)).toMatchObject({ loading: false, stale: true, error: null });
    expect(host.render(query).data).toHaveLength(200);
    await vi.waitFor(() => expect(host.render(query).error).toBeTruthy());
    expect(host.render(query).stale).toBe(true);
    host.clearScope();
    expect(host.render(query)).toMatchObject({ data: [], loading: true });
    host.dispose();
  });
});


describe('actual finance overview bill calendar and unpaid tail', () => {
  it('includes unpaid tail amount and overdue calendar dot after capped paid rows', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const input = [
      bill({ id: 'paid1', name: 'Paid prefix one', status: 'paid', due_date: `${month}-01` }),
      bill({ id: 'paid2', name: 'Paid prefix two', status: 'paid', due_date: `${month}-02` }),
      bill({ id: 'tail', name: 'Unpaid overdue tail', status: 'overdue', due_date: `${month}-03`, amount: 9876 }),
    ];
    const options = consumers.find(consumer => consumer.file === 'components/modules/finances-module.tsx')!.options;
    const complete = await options(family, 'owner-a', BILL_READ_CONTRACT, readCompleteBills).fetcher(database('ok', input).client);
    expect(complete.error).toBeNull();
    ui.bills = { data: complete.data!, loading: false, stale: false, error: null };
    const html = renderToStaticMarkup(React.createElement(FinancesModule));
    expect(html).toContain('Unpaid overdue tail');
    expect(html).toContain('9,876.00');
    expect(html).not.toContain('Paid prefix one');
    expect(html).not.toContain('Paid prefix two');
    expect(html).not.toContain('finances.noUpcomingBills');
    expect(html).toContain('mt-0.5 h-1.5 w-1.5 rounded-full bg-amber-500');
  });
  it('shows error and retry rather than a spinner after failed stale revalidation', () => {
    ui.bills = { data: rows, loading: false, stale: true, error: 'synthetic complete read failed' };
    const html = renderToStaticMarkup(React.createElement(FinancesModule));
    expect(html).toContain('financesModule.couldNotLoadFinancialData');
    expect(html).toContain('<button');
    expect(html).not.toContain('Synthetic bill');
    expect(html).not.toContain('animate-pulse');
  });
});

afterEach(() => { ui.siblings = {}; });
describe('finance stale bill and sibling query precedence', () => {
  const siblingTables = ['financial_accounts', 'transactions', 'budgets', 'savings_goals'];
  it.each(siblingTables)('renders error and retry for settled %s refusal while bills remain stale', table => {
    ui.bills = { data: rows, loading: false, stale: true, error: null };
    ui.siblings = { [table]: { loading: false, error: 'synthetic sibling refusal' } };
    const html = renderToStaticMarkup(React.createElement(FinancesModule));
    expect(html).toContain('financesModule.couldNotLoadFinancialData');
    expect(html).toContain('<button');
    expect(html).not.toContain('animate-pulse');
    expect(html).not.toContain('Synthetic bill');
    expect(html).not.toContain('9,000.00');
  });
  it.each(siblingTables)('preserves actual loading precedence for %s even with another query error', table => {
    ui.bills = { data: rows, loading: false, stale: true, error: null };
    ui.siblings = { financial_accounts: { loading: false, error: 'synthetic sibling refusal' }, [table]: { loading: true, error: 'synthetic loading refusal' } };
    const html = renderToStaticMarkup(React.createElement(FinancesModule));
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('financesModule.couldNotLoadFinancialData');
    expect(html).not.toContain('Synthetic bill');
  });
  it('retains pending presentation for stale bills without any query error', () => {
    ui.bills = { data: rows, loading: false, stale: true, error: null };
    ui.siblings = {};
    const html = renderToStaticMarkup(React.createElement(FinancesModule));
    expect(html).toContain('animate-pulse');
    expect(html).not.toContain('financesModule.couldNotLoadFinancialData');
    expect(html).not.toContain('Synthetic bill');
  });
});

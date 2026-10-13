import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient as createSdkClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { at, between } from './helpers/source-order';
import { cacheKey } from '@/lib/offline/cache';
import { addedInScope, narrowedToAdder, readsHouseholdMoney, transactionsInScope } from '@/lib/finance/household-money';

// The held 0514, the owner's decision: the household's money is a parent's or
// adult's. A member also reads the transactions tagged to them, and whoever
// added a paperwork item, warranty, registration or auto policy keeps reading
// it. The screens show each viewer what that rule gives them, the same before
// and after release, and say so to anyone who reads only their own.

const MIGRATION = 'supabase/reserved/0514_household_money_is_a_parents_or_adults.sql';
const PROBE = 'docs/audit/reserved/household-money-is-a-parents-or-adults-check.sql';
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const read = (p: string) => readFileSync(p, 'utf8');

type Txn = { id: string; family_id: string; member_id: string | null; name: string; amount: number; type: string; date: string; category: string | null; merchant: string | null };
type Query = { table: string; familyId: string; deps: unknown[]; fetcher: (sb: SupabaseClient) => PromiseLike<{ data: Txn[] | null; error: { message: string } | null }> };

const harness = vi.hoisted(() => ({
  viewer: { familyId: 'synthetic-family', userId: 'synthetic-teen-user', role: 'teen', selfMember: { id: 'synthetic-teen' } as { id: string } | null },
  rows: [] as Txn[],
  query: null as Query | null,
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => harness.viewer }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: (query: Query) => { harness.query = query; return { data: harness.rows, loading: false, error: null, stale: false, refresh: vi.fn() }; } }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/ui/states', () => ({ SkeletonList: () => null, ErrorState: () => null, EmptyState: () => null }));
vi.mock('@/components/i18n/locale-provider', () => ({ useLocale: () => ({ code: 'en-US' }), useTranslations: () => (key: string) => key }));
vi.mock('@/components/i18n/use-format', () => ({ useFamilyClock: () => ({ todayKey: () => '2026-10-11' }), useFormat: () => ({ fmtDate: (value: string) => value }) }));

const { PaymentsView } = await import('@/components/finance/payments-view');

function txn(id: string, member: string | null, day: number): Txn {
  return { id, family_id: 'synthetic-family', member_id: member, name: id, amount: -10, type: 'expense', date: `2026-10-${String(day).padStart(2, '0')}`, category: null, merchant: null };
}
/** 501 newer purchases by the household, then the teen's own, older one. */
function household(): Txn[] {
  return [...Array.from({ length: 501 }, (_, i) => txn(`synthetic-household-${i}`, i % 2 ? 'synthetic-parent' : null, 11)), txn('synthetic-own', 'synthetic-teen', 1)];
}
function render(rows: Txn[] = []) {
  harness.rows = rows;
  const html = renderToStaticMarkup(createElement(PaymentsView));
  return { html, query: harness.query! };
}
async function execute(query: Query, rows: Txn[]) {
  const calls: URL[] = [];
  const sb = createSdkClient('https://synthetic-money.example.test', 'synthetic-not-a-live-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      expect(url.pathname).toBe('/rest/v1/transactions');
      calls.push(url);
      let selected = [...rows];
      for (const key of ['family_id', 'member_id'] as const) {
        const expression = url.searchParams.get(key);
        if (expression) selected = selected.filter((r) => r[key] === expression.slice(3));
      }
      selected.sort((a, b) => b.date.localeCompare(a.date));
      return new Response(JSON.stringify(selected.slice(0, Number(url.searchParams.get('limit')))), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  return { ...(await query.fetcher(sb)), calls };
}

beforeEach(() => {
  Object.assign(harness.viewer, { familyId: 'synthetic-family', userId: 'synthetic-teen-user', role: 'teen', selfMember: { id: 'synthetic-teen' } });
  harness.rows = [];
  harness.query = null;
});

describe('who reads the household\'s money', () => {
  it('a parent and an adult; nobody else', () => {
    for (const role of ['parent', 'adult']) expect(readsHouseholdMoney(role), role).toBe(true);
    for (const role of ['teen', 'child', 'caregiver', 'guest', null, undefined]) expect(readsHouseholdMoney(role), String(role)).toBe(false);
  });

  it('anyone else reads the transactions tagged to them, and nothing tagged to nobody', () => {
    const rows = [{ id: 'a', member_id: 'me' }, { id: 'b', member_id: 'sib' }, { id: 'c', member_id: null }];
    expect(transactionsInScope(rows, 'teen', 'me').map((r) => r.id)).toEqual(['a']);
    expect(transactionsInScope(rows, 'caregiver', null)).toEqual([]);
    expect(transactionsInScope(rows, 'adult', 'me').map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('anyone else reads the records they added, and a record added by nobody is not theirs', () => {
    const rows = [{ id: 'a', created_by: 'u-me' }, { id: 'b', created_by: 'u-parent' }, { id: 'c', created_by: null }];
    expect(addedInScope(rows, 'child', 'u-me').map((r) => r.id)).toEqual(['a']);
    expect(addedInScope(rows, 'parent', 'u-parent').map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(narrowedToAdder({ role: 'teen', userId: 'u-me' })).toBe('u-me');
    expect(narrowedToAdder({ role: 'parent', userId: 'u-parent' })).toBeNull();
  });
});

describe('the payments view reads a member\'s own spending, before its limit', () => {
  it('the teen\'s older purchase survives 501 newer household ones, and they are told whose the rest is', async () => {
    const result = await execute(render().query, household());
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].searchParams.get('member_id')).toBe('eq.synthetic-teen');
    expect(result.data?.map((r) => r.id)).toEqual(['synthetic-own']);
    const { html } = render(result.data ?? []);
    expect(html).toContain('synthetic-own');
    expect(html).toContain('householdMoney.onlyYourOwnSpending');
  });

  it('a household purchase is not shown to the teen even if a server returned it', () => {
    const { html } = render(household());
    expect(html).toContain('synthetic-own');
    expect(html).not.toContain('synthetic-household-');
  });

  it('with no member record of their own nothing is asked for', async () => {
    harness.viewer.selfMember = null;
    const result = await execute(render().query, household());
    expect(result.calls).toHaveLength(0);
    expect(result.data).toEqual([]);
  });

  it.each(['parent', 'adult'])('%s reads the household\'s, unchanged, with no note', async (role) => {
    harness.viewer.role = role;
    const result = await execute(render().query, household());
    expect(result.calls[0].searchParams.get('member_id')).toBeNull();
    expect(result.data).toHaveLength(500);
    expect(render(result.data ?? []).html).not.toContain('householdMoney.onlyYourOwnSpending');
  });

  it('a change of role or member is a different cached read', () => {
    const teen = render().query;
    harness.viewer.role = 'parent';
    const parent = render().query;
    harness.viewer.role = 'teen';
    harness.viewer.selfMember = { id: 'synthetic-sibling' };
    const sibling = render().query;
    expect(new Set([teen, parent, sibling].map((q) => cacheKey(q.table, q.familyId, q.deps))).size).toBe(3);
  });
});

describe('the server reads an added-by record only for whoever added it', () => {
  const calls: Array<[string, unknown[]]> = [];
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'is', 'order', 'limit']) chain[m] = (...args: unknown[]) => { calls.push([m, args]); return chain; };
  chain.then = (onF: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(onF);
  vi.doMock('@/lib/supabase/server', () => ({ createServer: async () => ({ from: (t: string) => { calls.push(['from', [t]]); return chain; } }) }));
  vi.doMock('server-only', () => ({}));

  it.each([
    ['home_warranties', async (reader: { role: string; userId: string }) => (await import('@/lib/home/queries')).getWarranties('fam', reader)],
    ['vehicle_registrations', async (reader: { role: string; userId: string }) => (await import('@/lib/auto/queries')).getRegistrations('fam', reader)],
    ['auto_insurance_policies', async (reader: { role: string; userId: string }) => (await import('@/lib/auto/queries')).getPolicies('fam', reader)],
  ])('%s', async (table, load) => {
    calls.length = 0;
    await load({ role: 'teen', userId: 'u-teen' });
    expect(calls).toContainEqual(['from', [table]]);
    expect(calls).toContainEqual(['eq', ['created_by', 'u-teen']]);
    calls.length = 0;
    await load({ role: 'parent', userId: 'u-parent' });
    expect(calls.some(([m, a]) => m === 'eq' && a[0] === 'created_by')).toBe(false);
  });
});

describe('the screens say whose the household\'s money is', () => {
  it('the Family CFO page is a parent\'s or adult\'s, decided before anything is read', () => {
    const src = read('app/(app)/dashboard/family-cfo/page.tsx');
    expect(src).toContain("if (!readsHouseholdMoney(ctx.active.role)) {");
    expect(src).toContain("title={tr('householdMoney.keptByParents')}");
    expect(at(src, 'readsHouseholdMoney(ctx.active.role)')).toBeLessThan(at(src, 'loadCfoSummaryRows('));
  });

  it('the billing page tells anyone else whose it is, except the plan the gate sent them to', () => {
    const src = read('app/(app)/dashboard/billing/page.tsx');
    expect(src).toContain("if (!readsHouseholdMoney(ctx.active.role) && params.upgrade !== '1' && typeof params.checkout !== 'string') {");
    expect(at(src, "params.upgrade !== '1'")).toBeLessThan(at(src, '<FinancesModule />'));
    const billing = read('components/modules/billing-module.tsx');
    expect(billing).toContain('const seesHouseholdMoney = readsHouseholdMoney(role);');
    expect(billing).toContain(': Promise.resolve({ data: [] as FinancialAccount[], error: null }),');
    expect(billing).toContain(': Promise.resolve({ data: [] as Transaction[], error: null }),');
    expect(billing).toContain('if (!seesHouseholdMoney) {');
  });

  it('the home page\'s Family Finances card, and its read, are a manager\'s', () => {
    const src = read('app/(app)/home/page.tsx');
    // The month's whole read (SUMMED-READ-SIB), asked for only past the gate.
    expect(src).toContain('readsHouseholdMoney(ctx.active.role)\n      ? readAllByIdAsQuery<HomeTxn & { id: string }>((after, limit) => {');
    expect(between(src, 'readsHouseholdMoney(ctx.active.role)\n      ? readAllByIdAsQuery', ': Promise.resolve({ data: [] as HomeTxn[], error: null }),')).toContain("supabase.from('transactions')");
    expect(src).toContain(': Promise.resolve({ data: [] as HomeTxn[], error: null }),');
    expect(src).toContain('{manager && <Card>');
  });

  it.each([
    ['components/finance/payments-view.tsx', "householdMoney.onlyYourOwnSpending"],
    ['components/finance/budgets-view.tsx', "householdMoney.onlyYourOwnSpending"],
    ['components/wallet/wallet-hub.tsx', "householdMoney.onlyYourOwnSpending"],
  ])('%s narrows a member\'s transactions before reading them', (file, note) => {
    const src = read(file);
    expect(src).toContain("query.eq('member_id', selfId!)");
    expect(src).toContain('transactionsInScope(');
    expect(src).toContain(note);
  });

  it('the wallet hub does not ask for the household\'s accounts for anyone else', () => {
    expect(read('components/wallet/wallet-hub.tsx')).toContain(': Promise.resolve({ data: [] as Account[], error: null }),');
  });

  it('the paperwork inbox reads what a member added, before its limit, and says so', () => {
    const src = read('app/(app)/dashboard/paperwork/page.tsx');
    expect(src).toContain("const inbox = await (seesAll ? scoped : scoped.eq('created_by', ctx.user.id))");
    expect(src).toContain('<PaperworkModule items={items} ownOnly={!seesAll} />');
    expect(read('components/modules/paperwork-module.tsx')).toContain("{ownOnly && <p className=\"mt-1 max-w-xl text-xs text-muted\">{t('householdMoney.onlyWhatYouAdded')}</p>}");
  });

  it.each([
    ['app/(app)/dashboard/home/warranties/page.tsx', 'getWarranties(ctx.active.familyId, { role: ctx.active.role, userId: ctx.user.id })', 'components/home/warranties-client.tsx'],
    ['app/(app)/dashboard/auto/registration/page.tsx', 'getRegistrations(ctx.active.familyId, { role: ctx.active.role, userId: ctx.user.id })', 'components/auto/registration-client.tsx'],
    ['app/(app)/dashboard/auto/insurance/page.tsx', 'getPolicies(ctx.active.familyId, { role: ctx.active.role, userId: ctx.user.id })', 'components/auto/insurance-client.tsx'],
  ])('%s reads as its viewer and says so', (page, call, client) => {
    const src = read(page);
    expect(src).toContain(call);
    expect(src).toContain('ownOnly={!readsHouseholdMoney(ctx.active.role)}');
    expect(read(client)).toContain("householdMoney.onlyWhatYouAdded");
  });

  it('every member\'s wallet pages ask the server whether the wallet is on', () => {
    for (const page of ['activity', 'cards', 'invest', 'send', 'treasury']) {
      const src = read(`app/(app)/wallet/${page}/page.tsx`);
      expect(src, page).toContain('await readFamilyWalletIsActive(familyId)');
      expect(src, page).not.toMatch(/supabase\s*\.from\('family_wallets'\)/);
    }
    expect(read('lib/wallet/family-wallet-status.ts')).toContain(".from('family_wallets').select('is_active').eq('family_id', familyId).maybeSingle()");
  });

  it('the cards page asks the server for the Stripe account\'s status flags, not the row', () => {
    const src = read('app/(app)/wallet/cards/page.tsx');
    expect(src).toContain('readConnectedAccountStatus(familyId),');
    expect(src).not.toMatch(/supabase\.from\('stripe_connected_accounts'\)/);
    expect(read('lib/wallet/family-wallet-status.ts')).toContain(".select('status, charges_enabled, details_submitted, card_issuing_enabled').eq('family_id', familyId).maybeSingle()");
  });

  it('the budget simulator, the intelligence preview and needs-you do not stand a member\'s own spending in for the household\'s', () => {
    const twin = read('app/(app)/dashboard/family-digital-twin/actions.ts');
    // The budget and its spending are read in budgetHeadroom; each action asks
    // for them only past its gate (TWIN-SIB: the projection's Cost line too).
    expect(twin).toContain(".from('budgets').select('id, category, amount, period, created_at')");
    expect(at(twin, 'if (!readsHouseholdMoney(ctx.active.role)) {')).toBeLessThan(at(twin, 'await budgetHeadroom(supabase, familyId, input.category,'));
    expect(at(twin, 'if (checksCost && !readsHouseholdMoney(ctx.active.role)) {')).toBeLessThan(at(twin, '? budgetHeadroom(supabase, familyId, input.costCategory!,'));
    const intel = read('app/(app)/dashboard/intelligence/page.tsx');
    expect(intel).toContain('typicalWeeklySpend: seesSpending ? typicalWeeklySpend(');
    expect(intel).toContain(': Promise.resolve({ data: [] as { amount: number }[], error: null }),');
    expect(read('app/(app)/dashboard/needs-you/page.tsx')).toContain(".eq('family_id', familyId).eq('created_by', ctx.user.id))");
  });

  it('says so in the seven base locales', () => {
    for (const locale of LOCALES) {
      const m = JSON.parse(read(`lib/i18n/messages/${locale}.json`)) as Record<string, string>;
      for (const key of ['householdMoney.keptByParents', 'householdMoney.keptByParentsBody', 'householdMoney.onlyYourOwnSpending', 'householdMoney.onlyWhatYouAdded']) {
        expect(m[key], `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});

describe('the database half', () => {
  it('reads the twelve tables by three rules and leaves every write as it was', () => {
    const sql = read(MIGRATION);
    for (const t of ['financial_accounts', 'family_wallets', 'stripe_connected_accounts', 'stripe_financial_accounts', 'billing_customers',
      'checkout_sessions', 'babysitter_payments', 'transactions', 'home_warranties', 'auto_insurance_policies', 'vehicle_registrations', 'paperwork_items']) {
      expect(sql, t).toContain(`'${t}'`);
    }
    expect(sql).toContain("when 'managers' then 'public.can_manage_family(family_id)'");
    expect(sql).toContain("when 'member' then '(public.can_manage_family(family_id) or public.is_self_member(member_id))'");
    expect(sql).toContain("else '(public.can_manage_family(family_id) or created_by = auth.uid())'");
    expect(sql).toContain("raise exception '0514: public.% had % write policies and now has %'");
    const probe = read(PROBE);
    expect(probe).toContain("rule_mgr  constant text := '(is_family_member(family_id) AND can_manage_family(family_id))';");
    expect(probe).toContain("rule_add  constant text := '(is_family_member(family_id) AND (can_manage_family(family_id) OR (created_by = auth.uid())))';");
  });

  it('a released probe that re-runs 0275 leaves the reads as it found them', () => {
    const src = read('docs/audit/wallet-write-rls-check.sql');
    expect(at(src, 'create temp table wallet_probe_reads_before')).toBeLessThan(at(src, '\\ir ../../supabase/migrations/0275_money_permissive_write_sweep.sql'));
    expect(src).toContain("and (c.relname::text, p.polname::text) not in (select b.t, b.pol from wallet_probe_reads_before b)");
  });
});

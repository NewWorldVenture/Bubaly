import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadMoneyTimeline, loadMoneyTimelineInput, planCommitments } from '@/lib/finance/timeline-load';

// A chainable query stub: every builder method returns the chain and the chain
// is thenable, resolving to the supplied PostgREST-shaped `{ data, error }`.
// Mirrors the loader's calls (`from(t).select().eq().in().gte().lte().lt().order().limit()`).
type Reply = { data: unknown; error: unknown };
/** A table's answer: one reply for every call, or one per call in order (the pre-0488 retry asks `bills` twice). */
type Answer = Reply | ((call: number) => Reply);
function matchesExpression(row: Record<string, unknown>, expression: string): boolean {
  const split = (value: string) => { const parts: string[] = []; let depth = 0, start = 0; for (let i = 0; i < value.length; i++) { if (value[i] === '(') depth++; if (value[i] === ')') depth--; if (value[i] === ',' && depth === 0) { parts.push(value.slice(start, i)); start = i + 1; } } parts.push(value.slice(start)); return parts; };
  if (expression.startsWith('and(')) return split(expression.slice(4, -1)).every(part => matchesExpression(row, part));
  if (expression.startsWith('or(')) return split(expression.slice(3, -1)).some(part => matchesExpression(row, part));
  const [, column, op, value] = /^([^.]+)\.([^.]+)\.(.*)$/.exec(expression) ?? [];
  const actual = row[column];
  if (op === 'is') return value === 'null' ? actual == null : String(actual) === value;
  if (actual == null) return false;
  if (op === 'in') return value.slice(1, -1).split(',').includes(String(actual));
  if (op === 'eq') return String(actual) === value;
  if (op === 'neq') return String(actual) !== value;
  if (op === 'gte') return String(actual) >= value;
  if (op === 'lte') return String(actual) <= value;
  if (op === 'gt') return String(actual) > value;
  if (op === 'lt') return String(actual) < value;
  throw new Error(`Unsupported synthetic filter ${expression}`);
}
function chain(result: Reply, onSelect?: (columns: string) => void, table = 'synthetic') {
  const c: Record<string, unknown> = {};
  let from = 0, to = Infinity, counted = false;
  const predicates: string[] = [], orders: string[] = [];
  for (const op of ['eq', 'neq', 'in', 'gte', 'gt', 'lte', 'lt']) c[op] = (column: string, value: unknown) => { predicates.push(`${column}.${op}.${Array.isArray(value) ? `(${value.join(',')})` : String(value)}`); return c; };
  c.or = (value: string) => { predicates.push(`or(${value})`); return c; };
  c.order = (column: string) => { orders.push(column); return c; };
  c.limit = (limit: number) => { to = from + limit - 1; return c; };
  c.select = (columns: string, options?: { count?: string }) => { counted = options?.count === 'exact'; onSelect?.(columns); return c; };
  c.range = (start: number, end: number) => { from = start; to = end; return c; };
  const reply = () => {
    if (!Array.isArray(result.data) || result.error) return result;
    const rows = result.data.map((row, index) => ({ id: `${table}-${index}`, family_id: 'fam-1', all_day: false, recurrence: null, recurrence_until: null, ends_at: null, ...row }) as Record<string, unknown>).filter(row => predicates.every(p => matchesExpression(row, p)));
    rows.sort((a, b) => { for (const column of orders) { const cmp = String(a[column]).localeCompare(String(b[column])); if (cmp) return cmp; } return 0; });
    return { ...result, count: counted ? rows.length : null, data: rows.slice(from, to + 1) };
  };
  c.then = (res: (v: Reply) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(reply()).then(res, rej);
  return c;
}

function fakeSupabase(results: Record<string, Answer>, seen: string[] = [], selects: Record<string, string[]> = {}): SupabaseClient<Database> {
  const calls: Record<string, number> = {};
  return {
    from: (table: string) => {
      seen.push(table);
      const n = (calls[table] = (calls[table] ?? 0) + 1);
      const answer = results[table];
      const reply = typeof answer === 'function' ? answer(n) : answer ?? { data: [], error: null };
      return chain(reply, (columns) => { (selects[table] ??= []).push(columns); }, table);
    },
  } as unknown as SupabaseClient<Database>;
}

const NOW = new Date('2026-01-05T00:00:00Z'); // a Monday
// The zone is named on every call, because the loader now resolves its day keys
// in the FAMILY's zone and "unbound" is not a zone. These cases pin it to 'UTC',
// where the instant above is already 2026-01-05, so the literals below are about
// the mapping rather than about the calendar. What the mapping does in a zone
// that disagrees with Greenwich is
// tests/the-money-forecast-is-the-familys-week.test.ts.
const TZ = 'UTC';

describe('planCommitments (row → forecast mapping)', () => {
  it('maps cents to dollars and places each plan on the date its money is needed', () => {
    const plans = planCommitments({
      subscriptions: [
        { name: 'Streaming', cost_cents: 1599, cadence: 'monthly', status: 'active', next_charge: '2026-01-15', category: 'entertainment' },
        { name: 'Cloud backup', cost_cents: 12000, cadence: 'yearly', status: 'trial', next_charge: null, category: null },
        { name: 'Old gym', cost_cents: 4000, cadence: 'monthly', status: 'canceled', next_charge: '2026-01-10', category: null },
      ],
      vacations: [
        { id: 'v1', title: 'Spring break', start_date: '2026-02-14', status: 'booked', budget_cents: 500000 },
        { id: 'v2', title: 'No budget lines', start_date: '2026-03-01', status: 'planning', budget_cents: 80000 },
        { id: 'v3', title: 'Already gone', start_date: '2025-12-20', status: 'booked', budget_cents: 100000 },
        { id: 'v4', title: 'Cancelled', start_date: '2026-02-01', status: 'cancelled', budget_cents: 100000 },
      ],
      vacationBudgets: [
        { vacation_id: 'v1', planned_cents: 200000 },
        { vacation_id: 'v1', planned_cents: 100000 },
      ],
      vacationExpenses: [
        { vacation_id: 'v1', amount_cents: 50000 },
        { vacation_id: 'v2', amount_cents: 90000 },
      ],
      moves: [
        { title: 'Move to Elm St', move_date: '2026-03-02', status: 'packing', budget_cents: 300000, spent_cents: 120000 },
        { title: 'Done move', move_date: '2026-01-20', status: 'done', budget_cents: 300000, spent_cents: 0 },
      ],
      projects: [
        { title: 'Kitchen tap', status: 'scheduled', budget_cents: 30000, target_start: '2026-01-20', target_end: null },
        { title: 'Fence', status: 'in_progress', budget_cents: 45000, target_start: null, target_end: null },
        { title: 'Someday deck', status: 'idea', budget_cents: 900000, target_start: null, target_end: null },
        { title: 'Undated plan', status: 'planning', budget_cents: 10000, target_start: null, target_end: null },
      ],
    }, TZ, NOW);

    expect(plans).toEqual([
      // Real cost on the real cadence from next_charge; a canceled one is not live.
      { label: 'Streaming', amount: 15.99, date: '2026-01-15', source: 'subscription', recurrence: 'monthly', category: 'entertainment' },
      // No next charge: the monthly equivalent ($120/yr → $10/mo) accrues from the 1st of next month.
      { label: 'Cloud backup', amount: 10, date: '2026-02-01', source: 'subscription', recurrence: 'monthly', category: 'subscriptions' },
      // Budget lines (2000 + 1000) minus spent (500) = 2500, needed by departure. The trip's own
      // budget_cents is only the fallback when there are no lines.
      { label: 'Spring break', amount: 2500, date: '2026-02-14', source: 'vacation', category: 'travel' },
      // No lines → budget_cents 800 minus spent 900 → nothing left → skipped; past/cancelled trips skipped.
      { label: 'Move to Elm St', amount: 1800, date: '2026-03-02', source: 'move', category: 'moving' },
      { label: 'Kitchen tap', amount: 300, date: '2026-01-20', source: 'project', category: 'home' },
      // In progress with no date is spending now; an idea or an undated plan is not a commitment yet.
      { label: 'Fence', amount: 450, date: '2026-01-05', source: 'project', category: 'home' },
    ]);
  });
});

describe('loadMoneyTimelineInput read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fails closed (throws) on a real read error and logs which table failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const readError = { code: '42501', message: 'permission denied for table subscriptions_tracked' };
    const supabase = fakeSupabase({
      bills: { data: [{ name: 'Rent', amount: 1000, due_date: '2026-01-10', is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: true }], error: null },
      subscriptions_tracked: { data: null, error: readError },
    });

    // Design: a forecast missing a table's commitments is a reassuring-but-wrong
    // balance, so the loader never degrades to "no commitments" on a real error.
    await expect(loadMoneyTimelineInput(supabase, 'fam-1', TZ, NOW)).rejects.toEqual(readError);
    expect(err).toHaveBeenCalledWith('[finance/timeline] money timeline read failed', { table: 'subscriptions_tracked', error: readError });
  });

  it.each(['PGRST205', '42P01'])('a missing bills table remains fatal (%s)', async (code) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = { code, message: 'The bills table does not exist' };
    await expect(loadMoneyTimelineInput(fakeSupabase({ bills: { data: null, error } }), 'fam-1', TZ, NOW)).rejects.toEqual(error);
  });

  it('tolerates a genuinely missing plan table as "no commitments from that module"', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const supabase = fakeSupabase({
      financial_accounts: { data: [{ balance: 4000, type: 'checking' }, { balance: -900, type: 'credit' }], error: null },
      moves: { data: null, error: { code: '42P01', message: 'relation "public.moves" does not exist' } },
      home_projects: { data: [{ title: 'Kitchen tap', status: 'scheduled', budget_cents: 30000, target_start: '2026-01-20', target_end: null }], error: null },
    });

    const input = await loadMoneyTimelineInput(supabase, 'fam-1', TZ, NOW);
    expect(input.startingBalance).toBe(4000);
    expect(input.plans).toEqual([{ label: 'Kitchen tap', amount: 300, date: '2026-01-20', source: 'project', category: 'home' }]);
    expect(err).not.toHaveBeenCalled();
  });

  it('does not read a missing column as a missing table: a bills read that failed is thrown, not an empty bill list', async () => {
    // Review 5985670764. The shared isMissingTableError also accepts PGRST204 and
    // 42703, so a bills read refused for a column other than due_day came back
    // as "no bills" and the forecast looked complete with the rent missing.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const columnError of [
      { code: 'PGRST204', message: "Could not find the 'autopay' column of 'bills' in the schema cache" },
      { code: '42703', message: 'column bills.category does not exist' },
    ]) {
      const supabase = fakeSupabase({ bills: { data: null, error: columnError } });
      await expect(loadMoneyTimelineInput(supabase, 'fam-1', TZ, NOW)).rejects.toEqual(columnError);
      expect(err).toHaveBeenCalledWith('[finance/timeline] money timeline read failed', { table: 'bills', error: columnError });
    }
    // The same for any source table, and a missing TABLE is still tolerated.
    const plan = { code: '42703', message: 'column home_projects.target_start does not exist' };
    await expect(loadMoneyTimelineInput(fakeSupabase({ home_projects: { data: null, error: plan } }), 'fam-1', TZ, NOW)).rejects.toEqual(plan);
    const gone = fakeSupabase({ moves: { data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.moves' in the schema cache" } } });
    await expect(loadMoneyTimelineInput(gone, 'fam-1', TZ, NOW)).resolves.toBeTruthy();
  });

  it('reads every plan table and hands bills (with autopay) and plans to the brain', async () => {
    const seen: string[] = [];
    const supabase = fakeSupabase({
      bills: { data: [{ name: 'Rent', amount: 1000, due_date: '2026-01-10', is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: true }], error: null },
      financial_accounts: { data: [{ balance: 5000, type: 'checking' }], error: null },
      vacations: { data: [{ id: 'v1', title: 'Spring break', start_date: '2026-02-14', status: 'booked', budget_cents: 120000 }], error: null },
      vacation_expenses: { data: [{ vacation_id: 'v1', amount_cents: 20000 }], error: null },
    }, seen);

    const timeline = await loadMoneyTimeline(supabase, 'fam-1', TZ, NOW);
    expect(seen).toEqual(expect.arrayContaining([
      'bills', 'savings_goals', 'financial_accounts', 'calendar_events',
      'subscriptions_tracked', 'vacations', 'vacation_budgets', 'vacation_expenses', 'moves', 'home_projects',
    ]));
    expect(timeline.coverage.coveredCount).toBe(3);  // three rent payments…
    expect(timeline.coverage.coveredBills).toBe(1);  // …from one covered bill
    expect(timeline.coverage.totalBills).toBe(1);
    expect(timeline.planOutflow).toBe(1000);
    // Rent (Feb 10) shares the week of Feb 9 with the trip (Feb 14); the trip is the plan moment.
    const trip = timeline.weeks.find((w) => w.weekStart === '2026-02-09')!.moments.find((m) => m.kind === 'plan');
    expect(trip).toMatchObject({ label: 'Spring break', kind: 'plan', source: 'vacation', amount: 1000, date: '2026-02-14' });
    expect(timeline.lowestBalance).toBe(5000 - 3000 - 1000);
  });

  // Review 5981518473 / 5981566086 on #932: the forecast steps a month-end bill
  // by `due_day` (0488), but this loader's projection omitted the column, so a
  // row already clamped to Feb 28 with its anchor 31 recorded forecast March 28
  // in production however right the pure builder was. The projection carries
  // the column; a database that has not applied 0488 refuses it and is asked
  // once more without it.
  it('reads each bill\'s anchor day, so a clamped month-end row forecasts the month end again', async () => {
    const selects: Record<string, string[]> = {};
    const supabase = fakeSupabase({
      bills: { data: [{ name: 'Rent', amount: 1000, due_date: '2026-02-28', due_day: 31, is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: false }], error: null },
    }, [], selects);
    const input = await loadMoneyTimelineInput(supabase, 'fam-1', TZ, new Date('2026-02-20T00:00:00Z'));
    expect(selects.bills).toEqual(['id, name, amount, due_date, due_day, is_recurring, recurrence, status, category, autopay']);
    expect(input.bills).toEqual([expect.objectContaining({ due_date: '2026-02-28', due_day: 31 })]);
    const timeline = await loadMoneyTimeline(supabase, 'fam-1', TZ, new Date('2026-02-20T00:00:00Z'));
    const rent = timeline.weeks.flatMap((w) => w.moments).filter((m) => m.label === 'Rent').map((m) => m.date);
    expect(rent).toContain('2026-03-31');
    expect(rent).not.toContain('2026-03-28');
  });

  it('a database without 0488 is asked once more without the column, and steps the bill from its due date\'s day', async () => {
    const selects: Record<string, string[]> = {};
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const supabase = fakeSupabase({
      bills: (call) => (call === 1
        ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache" } }
        : { data: [{ name: 'Rent', amount: 1000, due_date: '2026-02-15', is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: false }], error: null }),
    }, [], selects);
    const input = await loadMoneyTimelineInput(supabase, 'fam-1', TZ, new Date('2026-02-20T00:00:00Z'));
    expect(selects.bills).toEqual([
      'id, name, amount, due_date, due_day, is_recurring, recurrence, status, category, autopay',
      'id, name, amount, due_date, is_recurring, recurrence, status, category, autopay',
    ]);
    expect(input.bills).toEqual([expect.objectContaining({ due_date: '2026-02-15' })]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('0488_a_month_end_bill_keeps_its_day'));
    // Any other refusal is the loader's failure, as before.
    const refused = fakeSupabase({ bills: { data: null, error: { code: '42501', message: 'permission denied for table bills' } } });
    await expect(loadMoneyTimelineInput(refused, 'fam-1', TZ, new Date('2026-02-20T00:00:00Z'))).rejects.toMatchObject({ code: '42501' });
  });

  it('passes a scenario through to the brain without re-reading', async () => {
    const seen: string[] = [];
    const supabase = fakeSupabase({ financial_accounts: { data: [{ balance: 1000, type: null }], error: null } }, seen);
    const timeline = await loadMoneyTimeline(supabase, 'fam-1', TZ, NOW, { scenario: { label: 'Laptop', amount: 900, date: '2026-01-21' } });
    expect(timeline.scenarioOutflow).toBe(900);
    expect(timeline.lowestBalance).toBe(100);
    expect(seen.filter((t) => t === 'bills')).toHaveLength(1);
  });
});

describe('bill anchors in the timeline read', () => {
  afterEach(() => vi.restoreAllMocks());
  const row = { id: 'synthetic-rent', name: 'Synthetic rent', amount: 100, due_date: '2026-02-28', due_day: 31, is_recurring: true, recurrence: 'monthly', status: 'upcoming', category: null, autopay: false };
  function transport(bill: object, refusal?: { code: string; message: string }) {
    const selects: string[] = [];
    const client = createClient<Database>('https://synthetic-timeline.invalid', 'synthetic-key', {
      auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input) => {
        const url = new URL(String(input));
        const table = url.pathname.split('/').at(-1);
        if (table !== 'bills') return new Response('[]', { headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } });
        expect(url.searchParams.get('family_id')).toBe('eq.family-1');
        const select = url.searchParams.get('select') ?? '';
        selects.push(select);
        if (refusal && select.includes('due_day')) return new Response(JSON.stringify(refusal), { status: 400, headers: { 'Content-Type': 'application/json' } });
        const projection = Object.fromEntries(select.split(',').map((name) => [name.trim(), bill[name.trim() as keyof typeof bill]]));
        return new Response(JSON.stringify([projection]), { headers: { 'Content-Type': 'application/json', 'Content-Range': '0-0/1' } });
      } },
    });
    return { client, selects };
  }

  it('selects the persisted day and forecasts March 31 from the clamped February row', async () => {
    const db = transport(row);
    const timeline = await loadMoneyTimeline(db.client, 'family-1', 'UTC', new Date('2026-02-23T00:00:00Z'));
    expect(db.selects).toHaveLength(1);
    expect(db.selects[0]).toContain('due_day');
    expect(timeline.weeks.flatMap((week) => week.moments).map((moment) => moment.date)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });

  it('reports an incomplete forecast on an older schema with monthly commitments', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = transport(row, { code: 'PGRST204', message: "Could not find the 'due_day' column of 'bills' in the schema cache" });
    await expect(loadMoneyTimeline(db.client, 'family-1', 'UTC', NOW)).rejects.toThrow(/anchors are unavailable/);
    expect(db.selects).toHaveLength(2);
    expect(db.selects[1]).not.toContain('due_day');
  });

  it.each([{ is_recurring: false, recurrence: null }, { is_recurring: true, recurrence: 'weekly' }])('can read an older schema when the bill needs no month anchor', async (over) => {
    const db = transport({ ...row, ...over }, { code: '42703', message: 'column bills.due_day does not exist' });
    const input = await loadMoneyTimelineInput(db.client, 'family-1', 'UTC', NOW);
    expect(input.bills).toHaveLength(1);
    expect(db.selects).toHaveLength(2);
  });

  it.each([{ code: '42501', message: 'due_day permission denied' }, { code: '42703', message: 'column bills.amount does not exist' }])('does not retry a different read refusal', async (refusal) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = transport(row, refusal);
    await expect(loadMoneyTimelineInput(db.client, 'family-1', 'UTC', NOW)).rejects.toMatchObject(refusal);
    expect(db.selects).toHaveLength(1);
  });
});

describe('complete counted bill reads under a lower server cap', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `bill-${i}`, name: `Synthetic ${i}`, amount: i === 4 ? 9000 : 1, due_date: '2026-01-15', due_day: null, is_recurring: true, recurrence: 'weekly', status: 'upcoming', category: null, autopay: false }));
  function capped(options: { legacy?: boolean; ambiguousLast?: boolean; missingCount?: boolean; changedCount?: boolean; duplicate?: boolean; emptyLast?: boolean; total?: number; pageError?: boolean } = {}) {
    const requests: URL[] = [];
    const client = createClient<Database>('https://synthetic-timeline.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/bills')) return new Response('[]', { headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } });
      requests.push(url);
      expect(url.searchParams.get('family_id')).toBe('eq.family-1');
      const select = url.searchParams.get('select') ?? '';
      if (options.legacy && select.includes('due_day')) return new Response(JSON.stringify({ code: '42703', message: 'column bills.due_day does not exist' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const offset = Number(url.searchParams.get('offset') ?? 0);
      if (options.pageError && offset > 0) return new Response(JSON.stringify({ code: '42501', message: 'later page denied' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      const data = options.emptyLast && offset > 0 ? [] : rows.slice(options.duplicate ? 0 : offset, (options.duplicate ? 0 : offset) + 2).map(row => options.ambiguousLast && row.id === 'bill-4' ? { ...row, recurrence: 'monthly', due_date: '2026-02-28' } : row);
      const total = options.total ?? (options.changedCount && offset > 0 ? 6 : rows.length);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (!options.missingCount) headers['Content-Range'] = `${offset}-${offset + data.length - 1}/${total}`;
      return new Response(JSON.stringify(data), { headers });
    } } });
    return { client, requests };
  }
  it.each([false, true])('reads every bill across server cap2, legacy=%s', async legacy => {
    const db = capped({ legacy });
    const result = await loadMoneyTimelineInput(db.client, 'family-1', TZ, NOW);
    expect(result.bills.map(row => row.name)).toEqual(rows.map(row => row.name));
    expect(db.requests.filter(url => !legacy || !url.searchParams.get('select')!.includes('due_day')).map(url => url.searchParams.get('offset'))).toEqual(['0', '2', '4']);
    expect(db.requests.every(url => url.searchParams.get('order') === 'id.asc')).toBe(true);
  });
  it('refuses a legacy ambiguous anchor on the later page', async () => {
    await expect(loadMoneyTimelineInput(capped({ legacy: true, ambiguousLast: true }).client, 'family-1', TZ, NOW)).rejects.toThrow(/anchors are unavailable/);
  });
  it.each([{ missingCount: true }, { changedCount: true }, { duplicate: true }, { emptyLast: true }, { total: 10001 }, { pageError: true }])('refuses an incomplete or unstable read %j', async options => {
    await expect(loadMoneyTimelineInput(capped(options).client, 'family-1', TZ, NOW)).rejects.toBeTruthy();
  });
});

describe('all forecast collections and calendar overlays are complete', () => {
  const limits = { financial_accounts: 200, savings_goals: 500, subscriptions_tracked: 500, vacations: 200, moves: 100, home_projects: 500, vacation_budgets: 2000, vacation_expenses: 5000 };
  type Collection = keyof typeof limits;
  const collections = Object.keys(limits) as Collection[];
  function row(table: string, index: number): Record<string, unknown> {
    const amount = index === 2 ? 9000 : 1;
    const base = { id: `synthetic-${index}`, family_id: 'family-1', name: `Synthetic ${index}`, title: `Synthetic ${index}` };
    if (table === 'financial_accounts') return { ...base, balance: amount, type: 'checking' };
    if (table === 'savings_goals') return { ...base, target_amount: amount, current_amount: 0, target_date: '2026-02-01' };
    if (table === 'subscriptions_tracked') return { ...base, cost_cents: amount * 100, cadence: 'monthly', status: 'active', next_charge: '2026-01-15', category: null };
    if (table === 'vacations') return { ...base, start_date: '2026-01-15', status: 'booked', budget_cents: amount * 100 };
    if (table === 'moves') return { ...base, move_date: '2026-01-15', status: 'planning', budget_cents: amount * 100, spent_cents: 0 };
    if (table === 'home_projects') return { ...base, target_start: '2026-01-15', target_end: null, status: 'scheduled', budget_cents: amount * 100 };
    if (table === 'vacation_budgets') return { ...base, vacation_id: 'vacation-1', planned_cents: amount * 100 };
    if (table === 'vacation_expenses') return { ...base, vacation_id: 'vacation-1', amount_cents: amount * 100 };
    return { ...base, starts_at: '2026-01-15T09:00:00Z', ends_at: '2026-01-15T10:00:00Z', all_day: false, recurrence: null, recurrence_until: null };
  }
  function transport(table: string, options: { failure?: 'count' | 'drift' | 'duplicate' | 'empty' | 'permission' | 'network' | 'max'; events?: Record<string, unknown>[] } = {}) {
    const requests: URL[] = [];
    const dataset = options.events ?? Array.from({ length: 3 }, (_, i) => row(table, i));
    const withForeign = [...dataset, { ...row(table, 2), id: 'foreign', family_id: 'family-2' }];
    const client = createClient<Database>('https://synthetic-timeline.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
      const url = new URL(String(input)), current = url.pathname.split('/').at(-1)!;
      let candidates = current === table ? withForeign : (table === 'vacation_budgets' || table === 'vacation_expenses') && current === 'vacations' ? [{ ...row('vacations', 0), id: 'vacation-1', budget_cents: 1_000_000 }] : [];
      candidates = candidates.filter(r => [...url.searchParams].every(([column, expression]) => ['select', 'order', 'limit', 'offset'].includes(column) || matchesExpression(r, column === 'or' ? `or${expression}` : `${column}.${expression}`)));
      candidates.sort((a, b) => { for (const column of (url.searchParams.get('order') ?? '').split(',').map(value => value.split('.')[0])) { const cmp = String(a[column]).localeCompare(String(b[column])); if (cmp) return cmp; } return 0; });
      const count = candidates.length, offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 1000);
      if (current === table) {
        requests.push(url);
        expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
        expect(url.searchParams.get('family_id')).toBe('eq.family-1');
        expect(url.searchParams.get('order')).toContain('id.asc');
        if (options.failure === 'network' && offset > 0) throw new DOMException('synthetic interrupted network read', 'AbortError');
        if (options.failure === 'permission' && offset > 0) return new Response(JSON.stringify({ code: '42501', message: 'later page denied' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }
      let data = candidates.slice(options.failure === 'duplicate' && current === table ? 0 : offset, (options.failure === 'duplicate' && current === table ? 0 : offset) + Math.min(limit, 2));
      if (options.failure === 'empty' && current === table && offset > 0) data = [];
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (!(options.failure === 'count' && current === table)) headers['Content-Range'] = `${data.length ? `${offset}-${offset + data.length - 1}` : '*'}/${current === table && options.failure === 'max' ? limits[table as Collection] + 1 : current === table && options.failure === 'drift' && offset > 0 ? count + 1 : count}`;
      return new Response(JSON.stringify(data), { headers });
    } } });
    return { client, requests };
  }
  it.each(collections)('reads all %s across cap2 and excludes foreign family rows', async table => {
    const db = transport(table);
    const input = await loadMoneyTimelineInput(db.client, 'family-1', TZ, NOW);
    if (table === 'financial_accounts') expect(input.startingBalance).toBe(9002);
    else if (table === 'savings_goals') expect(input.goals).toHaveLength(3);
    else expect(input.plans!.reduce((sum, plan) => sum + plan.amount, 0)).toBe(table === 'vacation_expenses' ? 998 : 9002);
    expect(db.requests.map(url => url.searchParams.get('offset'))).toEqual(['0', '2']);
  });
  it.each(collections.flatMap(table => (['count', 'drift', 'duplicate', 'empty', 'permission', 'network', 'max'] as const).map(failure => ({ table, failure }))))('refuses $table $failure rather than returning a complete-looking forecast', async ({ table, failure }) => {
    await expect(loadMoneyTimelineInput(transport(table, { failure }).client, 'family-1', TZ, NOW)).rejects.toBeTruthy();
  });
  it('reads every native calendar single across a lower server cap', async () => {
    const input = await loadMoneyTimelineInput(transport('calendar_events').client, 'family-1', TZ, NOW);
    expect(input.events.map(event => event.title)).toEqual(['Synthetic 0', 'Synthetic 1', 'Synthetic 2']);
  });
  it('expands an ongoing native weekly series whose seed predates the window', async () => {
    const event = { ...row('calendar_events', 0), starts_at: '2025-01-06T09:00:00Z', ends_at: '2025-01-06T10:00:00Z', recurrence: 'weekly' };
    const input = await loadMoneyTimelineInput(transport('calendar_events', { events: [event] }).client, 'family-1', TZ, NOW);
    expect(input.events).toHaveLength(14);
    expect(input.events[0].starts_at).toBe('2026-01-05');
    expect(input.events.at(-1)!.starts_at).toBe('2026-04-06');
  });
  it('keeps native all-day source dates in Los Angeles, including the first family day', async () => {
    const events = [4, 15].map(day => ({ ...row('calendar_events', day), starts_at: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`, ends_at: `2026-01-${String(day + 1).padStart(2, '0')}T00:00:00Z`, all_day: true }));
    const input = await loadMoneyTimelineInput(transport('calendar_events', { events }).client, 'family-1', 'America/Los_Angeles', NOW);
    expect(input.events.map(event => event.starts_at)).toEqual(['2026-01-04', '2026-01-15']);
  });
  it('refuses more than 500 native occurrences rather than slicing overlays', async () => {
    const events = Array.from({ length: 501 }, (_, i) => row('calendar_events', i));
    await expect(loadMoneyTimelineInput(transport('calendar_events', { events }).client, 'family-1', TZ, NOW)).rejects.toThrow(/More than 500 calendar occurrences/);
  });
});

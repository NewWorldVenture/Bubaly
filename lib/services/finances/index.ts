// Household money, read the only way the assistant is allowed to read it:
// from rows. Every figure a caller gets back here is a sum, a count or a
// comparison over `transactions`, `budgets`, `bills` and `savings_goals`
// (migration 0006, extended by 0110 `member_id` and 0113 `merchant`/`status`).
// Nothing is estimated, and an empty table produces an honest empty result
// rather than a plausible-looking number — a family will act on what the
// assistant says about their spending, so a fabricated figure is not a
// cosmetic bug.
//
// UNITS. The finance tables store dollars as `numeric(12,2)`, unlike the
// vacation and subscription tables which store cents. Every sum below is
// accumulated in integer cents and converted back once, so a month of
// $0.10 coffees does not drift by a cent through floating-point addition.
// Public shapes carry dollars (`amount`, `spent`, `limit`) rounded to 2 dp,
// matching what the Finances module shows.
//
// WHO MAY READ. `finances` is a HIGH_STAKES_AI_DOMAIN and is on every
// non-manager role's sensitive list, so the tool gate already denies a child
// or teen actor. The check is repeated here because a service is also called
// from server actions and crons that never pass through the gate; a second
// door is cheaper than a leaked statement.
//
// DATES. `transactions.date` is a `date` column holding the family's local
// day, so windows are expressed as `YYYY-MM-DD` keys and resolved in
// `scope.tz`; passing an ISO instant would shift the last hours of every day
// into the wrong month for any family west of UTC.
import 'server-only';
import type { BudgetPeriod, Tables, TransactionType } from '@/lib/database.types';
import { isManager } from '@/lib/constants/roles';
import { describeDbError } from '@/lib/supabase/errors';
import { recordActivitySafely } from '../activity';
import { withIdempotency } from '../idempotency';
import { dayKeyInTz, scopeNow } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type TransactionRow = Tables<'transactions'>;
export type BudgetRow = Tables<'budgets'>;
export type SavingsGoalRow = Tables<'savings_goals'>;

const DAY_MS = 86_400_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;
const PERIODS: BudgetPeriod[] = ['weekly', 'monthly', 'yearly'];
const TYPES: TransactionType[] = ['income', 'expense', 'transfer'];
/** Hard cap on rows pulled for any analysis; a household with more has a different problem. */
const MAX_ROWS = 5000;

// ── money helpers ─────────────────────────────────────────────────────────────

/** Dollars (numeric from Postgres) → integer cents. Non-numeric input counts as zero, never NaN. */
export function toCents(amount: number | string | null | undefined): number {
  const n = typeof amount === 'string' ? Number.parseFloat(amount) : amount;
  if (!Number.isFinite(n as number)) return 0;
  return Math.round((n as number) * 100);
}

/** Integer cents → dollars rounded to 2 dp, the shape every public result carries. */
export function toDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/** "$1,234.56" for narrative summaries. */
export function formatDollars(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(toDollars(cents));
}

// ── access ────────────────────────────────────────────────────────────────────

/**
 * Reads are for the adults who run the household and for system actors doing
 * the household's own work (crons, the run executor); everyone else is
 * refused here regardless of what the caller's client would let through.
 */
function assertFinanceReader(scope: ServiceScope): ServiceResult<null> {
  if (scope.role === 'system' || isManager(scope.role)) return ok(null);
  return fail('Family finances are private to the adults in this family.', { code: SERVICE_CODES.denied });
}

/**
 * The same rule for the two writes, which had no rule at all.
 *
 * Seven reads in this file assert `assertFinanceReader` and the two writes
 * did not, which mattered because 0267's RLS cannot see them: the run executor
 * writes with the SERVICE ROLE, so the database's new boundary is bypassed on
 * exactly the path the AI takes. A teen asking Bubaly to set a budget was held
 * by the trust engine's risk tier, and by nothing else if a household had ever
 * saved a broad allow policy.
 *
 * `system` is allowed for the same reason it is on the read: a cron doing the
 * household's own work has no person to ask, and the trust gate has already
 * decided whether that work may happen.
 */
function assertFinanceWriter(scope: ServiceScope, noun = 'change the family budget'): ServiceResult<null> {
  if (scope.role === 'system' || isManager(scope.role)) return ok(null);
  return fail(`Only a parent or another adult can ${noun}.`, { code: SERVICE_CODES.denied });
}

/** 0256's CHECK on `transactions.source`. */
const TRANSACTION_SOURCES = ['manual', 'receipt', 'import', 'ai'];

// ── date windows ──────────────────────────────────────────────────────────────

export type DateRange = { from: string; to: string };

function addDaysKey(dayKey: string, days: number): string {
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetweenKeys(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** First and last day of a `YYYY-MM` month. */
export function monthBounds(monthKey: string): DateRange {
  const [y, m] = monthKey.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${monthKey}-01`, to: `${monthKey}-${String(last).padStart(2, '0')}` };
}

/**
 * Normalise a caller's window. Missing bounds default to the last 30 family-
 * local days; a `to` before `from` is an error rather than a silently empty
 * result, because "you spent nothing" is exactly the wrong answer to give for
 * a typo.
 */
export function resolveRange(scope: ServiceScope, input?: { from?: string | null; to?: string | null }): ServiceResult<DateRange> {
  const today = dayKeyInTz(scopeNow(scope), scope.tz);
  const to = input?.to ?? today;
  // Validate `to` before deriving `from` from it: addDaysKey on a bad key
  // would throw a RangeError instead of returning this friendly failure.
  if (!DAY_KEY.test(to)) return fail('Dates must be given as YYYY-MM-DD.', { code: SERVICE_CODES.invalidInput });
  const from = input?.from ?? addDaysKey(to, -29);
  if (!DAY_KEY.test(from)) return fail('Dates must be given as YYYY-MM-DD.', { code: SERVICE_CODES.invalidInput });
  if (Date.parse(`${to}T00:00:00Z`) < Date.parse(`${from}T00:00:00Z`)) {
    return fail('The end of that window is before its start.', { code: SERVICE_CODES.invalidInput });
  }
  return ok({ from, to });
}

/** The window of the same length that ends the day before `range` starts. */
export function previousRange(range: DateRange): DateRange {
  const length = daysBetweenKeys(range.from, range.to) + 1;
  const to = addDaysKey(range.from, -1);
  return { from: addDaysKey(to, -(length - 1)), to };
}

/**
 * The days a budget of `period` covers when judged at `refDay`: the calendar
 * month or year containing it, or the seven days ending on it. Returned with
 * the result so a narrative can say which days a "$412 of $500" refers to.
 */
export function budgetWindow(period: BudgetPeriod, refDay: string): DateRange {
  if (period === 'monthly') return monthBounds(refDay.slice(0, 7));
  if (period === 'yearly') return { from: `${refDay.slice(0, 4)}-01-01`, to: `${refDay.slice(0, 4)}-12-31` };
  return { from: addDaysKey(refDay, -6), to: refDay };
}

// ── reads ─────────────────────────────────────────────────────────────────────

async function loadTransactions(
  scope: ServiceScope,
  range: DateRange,
  opts?: { type?: TransactionType | null; category?: string | null; memberId?: string | null; limit?: number },
): Promise<ServiceResult<TransactionRow[]>> {
  let query = scope.db
    .from('transactions')
    .select('*')
    .eq('family_id', scope.familyId)
    .gte('date', range.from)
    .lte('date', range.to)
    .order('date', { ascending: false })
    .limit(Math.min(Math.max(opts?.limit ?? MAX_ROWS, 1), MAX_ROWS));
  if (opts?.type) query = query.eq('type', opts.type);
  if (opts?.memberId) query = query.eq('member_id', opts.memberId);
  if (opts?.category?.trim()) {
    const term = opts.category.trim().replace(/[%_]/g, (m) => `\\${m}`);
    query = query.ilike('category', term);
  }
  const { data, error } = await query;
  if (error) {
    console.error('[service:finances] transactions read failed', error);
    return fail(describeDbError(error, 'Could not load your transactions.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

export type ListTransactionsInput = {
  from?: string | null;
  to?: string | null;
  type?: TransactionType | null;
  category?: string | null;
  memberId?: string | null;
  limit?: number;
};

export type TransactionSummary = {
  id: string;
  name: string;
  merchant: string | null;
  amount: number;
  category: string | null;
  date: string;
  type: TransactionType;
  memberId: string | null;
  accountId: string | null;
};

function toSummary(row: TransactionRow): TransactionSummary {
  return {
    id: row.id,
    name: row.name,
    merchant: row.merchant,
    amount: toDollars(toCents(row.amount)),
    category: row.category,
    date: row.date,
    type: row.type,
    memberId: row.member_id,
    accountId: row.account_id,
  };
}

/** Transactions in a window, newest first. */
export async function listTransactions(
  scope: ServiceScope,
  input: ListTransactionsInput = {},
): Promise<ServiceResult<{ range: DateRange; transactions: TransactionSummary[]; total: number }>> {
  const access = assertFinanceReader(scope);
  if (!access.ok) return access;
  const range = resolveRange(scope, input);
  if (!range.ok) return range;
  if (input.type && !TYPES.includes(input.type)) {
    return fail('That transaction type is not one Bubaly knows.', { code: SERVICE_CODES.invalidInput });
  }
  const rows = await loadTransactions(scope, range.data, { ...input, limit: input.limit ?? 200 });
  if (!rows.ok) return rows;
  const total = rows.data.reduce((sum, row) => sum + toCents(row.amount), 0);
  return ok({ range: range.data, transactions: rows.data.map(toSummary), total: toDollars(total) });
}

// ── pure analysis over rows ───────────────────────────────────────────────────

export type ExpenseLike = { name: string; merchant?: string | null; amount: number | string; category: string | null; date: string; type: string };

const UNCATEGORISED = 'Uncategorized';

function categoryOf(row: { category: string | null }): string {
  return row.category?.trim() || UNCATEGORISED;
}

/** Merchant label with the noise that makes the same shop look like two shops stripped. */
export function normalizeMerchant(row: { name: string; merchant?: string | null }): string {
  const raw = (row.merchant?.trim() || row.name || '').toLowerCase();
  return raw
    .replace(/#\s*\d+/g, ' ')          // store numbers: "Target #1234"
    .replace(/\b\d{2,}\b/g, ' ')       // trailing reference numbers
    .replace(/[^a-z0-9& ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type CategoryTotal = { category: string; spent: number; count: number; share: number };

/** Expense totals per category, largest first. Pure. */
export function totalsByCategory(rows: ExpenseLike[]): { total: number; categories: CategoryTotal[] } {
  const buckets = new Map<string, { cents: number; count: number }>();
  let total = 0;
  for (const row of rows) {
    if (row.type !== 'expense') continue;
    const cents = Math.abs(toCents(row.amount));
    const key = categoryOf(row);
    const bucket = buckets.get(key) ?? { cents: 0, count: 0 };
    bucket.cents += cents;
    bucket.count += 1;
    buckets.set(key, bucket);
    total += cents;
  }
  const categories = [...buckets.entries()]
    .map(([category, b]) => ({
      category,
      spent: toDollars(b.cents),
      count: b.count,
      share: total > 0 ? Math.round((b.cents / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.spent - a.spent);
  return { total: toDollars(total), categories };
}

export type CategoryComparison = {
  category: string;
  current: number;
  previous: number;
  delta: number;
  /** Percent change against the previous window; null when there was nothing to compare against. */
  deltaPct: number | null;
};

/** Side-by-side category totals for two windows, sorted by the size of the swing. Pure. */
export function compareCategoryTotals(current: ExpenseLike[], previous: ExpenseLike[]): {
  current: number; previous: number; delta: number; deltaPct: number | null; categories: CategoryComparison[];
} {
  const now = totalsByCategory(current);
  const then = totalsByCategory(previous);
  const nowMap = new Map(now.categories.map((c) => [c.category, c.spent]));
  const thenMap = new Map(then.categories.map((c) => [c.category, c.spent]));
  const keys = new Set([...nowMap.keys(), ...thenMap.keys()]);
  const categories = [...keys].map((category) => {
    const cur = nowMap.get(category) ?? 0;
    const prev = thenMap.get(category) ?? 0;
    const delta = toDollars(toCents(cur) - toCents(prev));
    return { category, current: cur, previous: prev, delta, deltaPct: prev > 0 ? Math.round((delta / prev) * 1000) / 10 : null };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const delta = toDollars(toCents(now.total) - toCents(then.total));
  return {
    current: now.total,
    previous: then.total,
    delta,
    deltaPct: then.total > 0 ? Math.round((delta / then.total) * 1000) / 10 : null,
    categories,
  };
}

export type MerchantMovementRow = {
  merchant: string;
  current: number;
  previous: number;
  delta: number;
  visits: number;
  status: 'new' | 'gone' | 'up' | 'down' | 'flat';
};

/** Which merchants a family spent more or less at, plus the ones that appeared or vanished. Pure. */
export function merchantMovementRows(current: ExpenseLike[], previous: ExpenseLike[]): MerchantMovementRow[] {
  const sum = (rows: ExpenseLike[]) => {
    const map = new Map<string, { cents: number; visits: number }>();
    for (const row of rows) {
      if (row.type !== 'expense') continue;
      const key = normalizeMerchant(row);
      if (!key) continue;
      const entry = map.get(key) ?? { cents: 0, visits: 0 };
      entry.cents += Math.abs(toCents(row.amount));
      entry.visits += 1;
      map.set(key, entry);
    }
    return map;
  };
  const now = sum(current);
  const then = sum(previous);
  const keys = new Set([...now.keys(), ...then.keys()]);
  return [...keys].map((merchant) => {
    const cur = now.get(merchant)?.cents ?? 0;
    const prev = then.get(merchant)?.cents ?? 0;
    const delta = cur - prev;
    let status: MerchantMovementRow['status'] = 'flat';
    if (prev === 0 && cur > 0) status = 'new';
    else if (cur === 0 && prev > 0) status = 'gone';
    else if (Math.abs(delta) >= Math.max(500, prev * 0.1)) status = delta > 0 ? 'up' : 'down';
    return { merchant, current: toDollars(cur), previous: toDollars(prev), delta: toDollars(delta), visits: now.get(merchant)?.visits ?? 0, status };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export type RecurringChange = {
  merchant: string;
  /** Months in which a charge appeared, e.g. ['2026-07','2026-08','2026-09']. */
  months: string[];
  latestAmount: number;
  previousAmount: number;
  delta: number;
  deltaPct: number | null;
  latestDate: string;
};

/**
 * Charges that repeat month after month (the shape of a subscription or a
 * utility) whose latest amount differs from the one before by at least $1 and
 * 5%. Pure. Recurring means "seen in at least two distinct months"; a
 * merchant visited three times in one week is a habit, not a subscription.
 */
export function recurringChangeRows(rows: ExpenseLike[]): RecurringChange[] {
  const byMerchant = new Map<string, { date: string; cents: number }[]>();
  for (const row of rows) {
    if (row.type !== 'expense') continue;
    const key = normalizeMerchant(row);
    if (!key) continue;
    const list = byMerchant.get(key) ?? [];
    list.push({ date: row.date, cents: Math.abs(toCents(row.amount)) });
    byMerchant.set(key, list);
  }
  const out: RecurringChange[] = [];
  for (const [merchant, charges] of byMerchant) {
    const months = [...new Set(charges.map((c) => c.date.slice(0, 7)))].sort();
    if (months.length < 2) continue;
    // Compare the most recent charge in each of the last two months.
    const latestMonth = months[months.length - 1];
    const previousMonth = months[months.length - 2];
    const latestIn = (month: string) => charges.filter((c) => c.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date))[0];
    const latest = latestIn(latestMonth);
    const previous = latestIn(previousMonth);
    if (!latest || !previous) continue;
    const delta = latest.cents - previous.cents;
    if (Math.abs(delta) < 100 || Math.abs(delta) < previous.cents * 0.05) continue;
    out.push({
      merchant,
      months,
      latestAmount: toDollars(latest.cents),
      previousAmount: toDollars(previous.cents),
      delta: toDollars(delta),
      deltaPct: previous.cents > 0 ? Math.round((delta / previous.cents) * 1000) / 10 : null,
      latestDate: latest.date,
    });
  }
  return out.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export type UnusualTransaction = TransactionSummary & { reason: string };

/**
 * Transactions that stand out against a baseline window. Two rules, both
 * explained in `reason` so the family can disagree with them:
 *   • the amount is more than double the category's typical (median) charge
 *     and at least $25 above it, judged against ≥ 3 baseline charges;
 *   • the merchant never appeared in the baseline and the charge is larger
 *     than the family's typical transaction.
 * Pure. Baseline rows are only ever read, never reported.
 */
export function unusualTransactionRows(window: TransactionRow[], baseline: ExpenseLike[]): UnusualTransaction[] {
  const median = (values: number[]): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  };
  const baseExpenses = baseline.filter((r) => r.type === 'expense');
  const byCategory = new Map<string, number[]>();
  const merchants = new Set<string>();
  const all: number[] = [];
  for (const row of baseExpenses) {
    const cents = Math.abs(toCents(row.amount));
    const key = categoryOf(row);
    byCategory.set(key, [...(byCategory.get(key) ?? []), cents]);
    merchants.add(normalizeMerchant(row));
    all.push(cents);
  }
  const familyTypical = median(all);

  const out: UnusualTransaction[] = [];
  for (const row of window) {
    if (row.type !== 'expense') continue;
    const cents = Math.abs(toCents(row.amount));
    const category = categoryOf(row);
    const sample = byCategory.get(category) ?? [];
    const typical = sample.length >= 3 ? median(sample) : null;
    if (typical !== null && cents > typical * 2 && cents - typical >= 2500) {
      out.push({ ...toSummary(row), reason: `${formatDollars(cents)} is more than double the usual ${formatDollars(typical)} for ${category}.` });
      continue;
    }
    const merchant = normalizeMerchant(row);
    if (merchant && !merchants.has(merchant) && familyTypical !== null && cents > familyTypical) {
      out.push({ ...toSummary(row), reason: `First charge from ${row.merchant?.trim() || row.name} in the baseline period, above the usual ${formatDollars(familyTypical)} transaction.` });
    }
  }
  return out.sort((a, b) => b.amount - a.amount);
}

// ── analyses backed by rows ───────────────────────────────────────────────────

export async function spendingByCategory(
  scope: ServiceScope,
  input: { from?: string | null; to?: string | null; memberId?: string | null } = {},
): Promise<ServiceResult<{ range: DateRange; total: number; categories: CategoryTotal[]; transactionCount: number }>> {
  const access = assertFinanceReader(scope);
  if (!access.ok) return access;
  const range = resolveRange(scope, input);
  if (!range.ok) return range;
  const rows = await loadTransactions(scope, range.data, { type: 'expense', memberId: input.memberId ?? null });
  if (!rows.ok) return rows;
  const totals = totalsByCategory(rows.data);
  return ok({ range: range.data, ...totals, transactionCount: rows.data.length });
}

export type BudgetLine = {
  budgetId: string;
  category: string;
  period: BudgetPeriod;
  limit: number;
  spent: number;
  remaining: number;
  /** Percent of the limit used; can exceed 100. */
  pct: number;
  over: boolean;
  window: DateRange;
  transactionCount: number;
};

/**
 * Every budget against what was actually spent in its window. The window is
 * judged at the last day of `month` (or today when the month is the current
 * one) so a weekly budget reports the week that matters for that month.
 */
export async function budgetVsActual(
  scope: ServiceScope,
  input: { month?: string | null } = {},
): Promise<ServiceResult<{ month: string; budgets: BudgetLine[]; totalLimit: number; totalSpent: number; overCount: number }>> {
  const access = assertFinanceReader(scope);
  if (!access.ok) return access;
  const today = dayKeyInTz(scopeNow(scope), scope.tz);
  const month = input.month ?? today.slice(0, 7);
  if (!MONTH_KEY.test(month)) return fail('The month must be given as YYYY-MM.', { code: SERVICE_CODES.invalidInput });
  const bounds = monthBounds(month);
  const refDay = month === today.slice(0, 7) ? today : bounds.to;

  const { data: budgets, error } = await scope.db
    .from('budgets')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('category', { ascending: true });
  if (error) {
    console.error('[service:finances] budgets read failed', error);
    return fail(describeDbError(error, 'Could not load your budgets.'), { code: SERVICE_CODES.db });
  }
  const rows = budgets ?? [];
  if (rows.length === 0) return ok({ month, budgets: [], totalLimit: 0, totalSpent: 0, overCount: 0 });

  // One read covering the widest window any budget needs (the year for a
  // yearly budget), then sliced per budget in memory.
  const windows = rows.map((b) => budgetWindow(b.period, refDay));
  const wide: DateRange = {
    from: windows.reduce((min, w) => (w.from < min ? w.from : min), windows[0].from),
    to: windows.reduce((max, w) => (w.to > max ? w.to : max), windows[0].to),
  };
  const txns = await loadTransactions(scope, wide, { type: 'expense' });
  if (!txns.ok) return txns;

  const lines: BudgetLine[] = rows.map((budget, i) => {
    const window = windows[i];
    const cat = budget.category.trim().toLowerCase();
    let cents = 0;
    let count = 0;
    for (const t of txns.data) {
      if (t.date < window.from || t.date > window.to) continue;
      if ((t.category ?? '').trim().toLowerCase() !== cat) continue;
      cents += Math.abs(toCents(t.amount));
      count += 1;
    }
    const limitCents = toCents(budget.amount);
    return {
      budgetId: budget.id,
      category: budget.category,
      period: budget.period,
      limit: toDollars(limitCents),
      spent: toDollars(cents),
      remaining: toDollars(limitCents - cents),
      pct: limitCents > 0 ? Math.round((cents / limitCents) * 100) : (cents > 0 ? 999 : 0),
      over: limitCents > 0 && cents > limitCents,
      window,
      transactionCount: count,
    };
  }).sort((a, b) => b.pct - a.pct);

  return ok({
    month,
    budgets: lines,
    totalLimit: toDollars(lines.reduce((s, l) => s + toCents(l.limit), 0)),
    totalSpent: toDollars(lines.reduce((s, l) => s + toCents(l.spent), 0)),
    overCount: lines.filter((l) => l.over).length,
  });
}

export async function comparePeriods(
  scope: ServiceScope,
  input: { from?: string | null; to?: string | null; compareFrom?: string | null; compareTo?: string | null } = {},
): Promise<ServiceResult<{ range: DateRange; previousRange: DateRange } & ReturnType<typeof compareCategoryTotals>>> {
  const access = assertFinanceReader(scope);
  if (!access.ok) return access;
  const range = resolveRange(scope, input);
  if (!range.ok) return range;
  const prev = input.compareFrom || input.compareTo
    ? resolveRange(scope, { from: input.compareFrom ?? null, to: input.compareTo ?? null })
    : ok(previousRange(range.data));
  if (!prev.ok) return prev;

  const [current, previous] = await Promise.all([
    loadTransactions(scope, range.data, { type: 'expense' }),
    loadTransactions(scope, prev.data, { type: 'expense' }),
  ]);
  if (!current.ok) return current;
  if (!previous.ok) return previous;
  return ok({ range: range.data, previousRange: prev.data, ...compareCategoryTotals(current.data, previous.data) });
}

export async function merchantMovement(
  scope: ServiceScope,
  input: { from?: string | null; to?: string | null; limit?: number } = {},
): Promise<ServiceResult<{ range: DateRange; previousRange: DateRange; merchants: MerchantMovementRow[] }>> {
  const access = assertFinanceReader(scope);
  if (!access.ok) return access;
  const range = resolveRange(scope, input);
  if (!range.ok) return range;
  const prev = previousRange(range.data);
  const [current, previous] = await Promise.all([
    loadTransactions(scope, range.data, { type: 'expense' }),
    loadTransactions(scope, prev, { type: 'expense' }),
  ]);
  if (!current.ok) return current;
  if (!previous.ok) return previous;
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 200);
  return ok({ range: range.data, previousRange: prev, merchants: merchantMovementRows(current.data, previous.data).slice(0, limit) });
}

export async function recurringChanges(
  scope: ServiceScope,
  input: { months?: number } = {},
): Promise<ServiceResult<{ range: DateRange; changes: RecurringChange[] }>> {
  const access = assertFinanceReader(scope);
  if (!access.ok) return access;
  const months = Math.min(Math.max(Math.round(input.months ?? 3), 2), 12);
  const today = dayKeyInTz(scopeNow(scope), scope.tz);
  const range: DateRange = { from: addDaysKey(today, -(months * 31)), to: today };
  const rows = await loadTransactions(scope, range, { type: 'expense' });
  if (!rows.ok) return rows;
  return ok({ range, changes: recurringChangeRows(rows.data) });
}

export async function unusualTransactions(
  scope: ServiceScope,
  input: { from?: string | null; to?: string | null; baselineDays?: number } = {},
): Promise<ServiceResult<{ range: DateRange; baseline: DateRange; unusual: UnusualTransaction[] }>> {
  const access = assertFinanceReader(scope);
  if (!access.ok) return access;
  const range = resolveRange(scope, input);
  if (!range.ok) return range;
  const baselineDays = Math.min(Math.max(Math.round(input.baselineDays ?? 90), 14), 365);
  const baselineTo = addDaysKey(range.data.from, -1);
  const baseline: DateRange = { from: addDaysKey(baselineTo, -(baselineDays - 1)), to: baselineTo };
  const [window, base] = await Promise.all([
    loadTransactions(scope, range.data, { type: 'expense' }),
    loadTransactions(scope, baseline, { type: 'expense' }),
  ]);
  if (!window.ok) return window;
  if (!base.ok) return base;
  return ok({ range: range.data, baseline, unusual: unusualTransactionRows(window.data, base.data) });
}

// ── writes ────────────────────────────────────────────────────────────────────

export type UpdateBudgetInput = { category: string; amount: number; period?: BudgetPeriod | null };

/**
 * Set a category's budget, creating the row when the family has none for it.
 * Category matching is case-insensitive so "groceries" and "Groceries" do not
 * become two budgets that each report the other's spend as unbudgeted.
 */
export async function updateBudget(
  scope: ServiceScope,
  input: UpdateBudgetInput,
): Promise<ServiceResult<{ budget: BudgetRow; created: boolean; previousAmount: number | null }>> {
  const allowed = assertFinanceWriter(scope);
  if (!allowed.ok) return allowed;
  const category = input.category?.trim() ?? '';
  if (!category) return fail('A budget needs a category.', { code: SERVICE_CODES.invalidInput });
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    return fail('A budget amount must be zero or more.', { code: SERVICE_CODES.invalidInput });
  }
  if (input.period && !PERIODS.includes(input.period)) {
    return fail('A budget period is weekly, monthly or yearly.', { code: SERVICE_CODES.invalidInput });
  }
  const amount = toDollars(toCents(input.amount));

  const { data: existing, error: readError } = await scope.db
    .from('budgets')
    .select('*')
    .eq('family_id', scope.familyId)
    .ilike('category', category.replace(/[%_]/g, (m) => `\\${m}`))
    .limit(1)
    .maybeSingle();
  if (readError) {
    console.error('[service:finances] budget lookup failed', readError);
    return fail(describeDbError(readError, 'Could not check the existing budget.'), { code: SERVICE_CODES.db });
  }

  if (existing) {
    const { data, error } = await scope.db
      .from('budgets')
      .update({ amount, ...(input.period ? { period: input.period } : {}) })
      .eq('id', existing.id)
      .eq('family_id', scope.familyId)
      .select('*')
      .maybeSingle();
    if (error || !data) {
      console.error('[service:finances] budget update failed', error);
      return fail(describeDbError(error, 'Could not update that budget.'), { code: SERVICE_CODES.db });
    }
    await recordActivitySafely(scope, {
      agent: 'finances',
      action: 'update',
      title: `Set the ${data.category} budget to ${formatDollars(toCents(data.amount))} ${data.period}`,
      detail: `Was ${formatDollars(toCents(existing.amount))}`,
      href: '/dashboard/finances',
    });
    return ok({ budget: data, created: false, previousAmount: toDollars(toCents(existing.amount)) });
  }

  const { data, error } = await scope.db
    .from('budgets')
    .insert({ family_id: scope.familyId, category, amount, period: input.period ?? 'monthly', created_by: scope.userId })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:finances] budget insert failed', error);
    return fail(describeDbError(error, 'Could not create that budget.'), { code: SERVICE_CODES.db });
  }
  await recordActivitySafely(scope, {
    agent: 'finances',
    action: 'create',
    title: `Created a ${formatDollars(toCents(data.amount))} ${data.period} budget for ${data.category}`,
    href: '/dashboard/finances',
  });
  return ok({ budget: data, created: true, previousAmount: null });
}

export type CreateTransactionInput = {
  /** What the family would call it: "Groceries", "Swim class fees". */
  name: string;
  /** Dollars, unsigned. Direction lives in `type`, not in the sign. */
  amount: number;
  type?: TransactionType;
  merchant?: string | null;
  category?: string | null;
  /** YYYY-MM-DD. Defaults to today in the family's zone. */
  date?: string | null;
  notes?: string | null;
  /** All three are verified to belong to THIS family before they are written. */
  accountId?: string | null;
  memberId?: string | null;
  receiptDocumentId?: string | null;
  /** 0256's CHECK: manual | receipt | import | ai. */
  source?: string | null;
};

/**
 * Record a purchase on the household books.
 *
 * This is the first writer `transactions` has ever had outside the wallet's own
 * UI action. Until it existed the assistant could analyse a family's spending
 * six different ways and could not record a single charge, which is why §26 —
 * hand Bubaly a receipt and have the purchase land — had nowhere to start.
 *
 * DEDUPLICATION IS DELIBERATELY ABSENT, and that is the safe choice rather than
 * the lazy one. `0256` migrated `fingerprint` and a partial unique index on
 * (family_id, fingerprint), and the obvious fingerprint — family + merchant +
 * amount + date, as that migration's own header suggests — is a money-losing
 * bug: two coffees at one shop on one day for one price hash identically, so
 * the second insert collides and a "treat it as a duplicate" handler discards a
 * real charge and tells the family everything is fine. Deriving it from the
 * receipt instead only moves the loss: one photo of a Costco receipt split into
 * Groceries and Household is two charges with one document.
 *
 * A duplicate guard needs the identity of a CHARGE, and nothing in the product
 * can produce one yet — that arrives with the intake that reads a receipt into
 * line items. So `fingerprint` stays null, the index (partial, `where
 * fingerprint is not null`) does not apply, and two identical purchases are two
 * rows. Re-recording the same charge is a visible, correctable mistake; losing
 * one is neither.
 *
 * `idempotency_key` is likewise not written. `lib/database.types.ts` types the
 * column on this table and NO migration adds it — `0256` gave it only to its
 * six keyed tables — so writing it would be a PGRST204 against real schema.
 * Repeat-call protection on the plan path comes from `executeTool`'s own
 * `ai_tool_calls` reservation, which the run executor keys per step.
 *
 * SIGN. Amount is stored unsigned with direction in `type`, matching the wallet
 * action (`app/(app)/wallet/hub-actions.ts`) and `listTransactions`, which sums
 * unsigned. `components/modules/billing-module.tsx` stores expenses negative,
 * which disagrees with both; that divergence predates this and is not resolved
 * here, but a third writer picking the majority convention is the safer default.
 */
export async function createTransaction(
  scope: ServiceScope,
  input: CreateTransactionInput,
): Promise<ServiceResult<TransactionRow>> {
  const allowed = assertFinanceWriter(scope, 'record a purchase on the household books');
  if (!allowed.ok) return allowed;

  const name = input.name?.trim() ?? '';
  if (!name) return fail('A transaction needs a name.', { code: SERVICE_CODES.invalidInput });
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return fail('A transaction needs an amount above zero. Use the type to say whether money came in or went out.', { code: SERVICE_CODES.invalidInput });
  }
  const amount = toDollars(toCents(input.amount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return fail('A transaction needs a valid amount of at least one cent after rounding.', { code: SERVICE_CODES.invalidInput });
  }
  const date = input.date?.trim() || dayKeyInTz(scopeNow(scope), scope.tz);
  if (!DAY_KEY.test(date)) return fail('The date must be YYYY-MM-DD.', { code: SERVICE_CODES.invalidInput });
  const source = input.source?.trim() || (scope.actorKind === 'ai' ? 'ai' : 'manual');
  if (!TRANSACTION_SOURCES.includes(source)) {
    return fail(`A transaction's source must be one of: ${TRANSACTION_SOURCES.join(', ')}.`, { code: SERVICE_CODES.invalidInput });
  }

  // Every one of these three is a foreign key WITHOUT a family predicate
  // (`0006` for the account, `0110` for the member, `0256` for the document),
  // and every one can arrive from model output. A service-role write would
  // otherwise staple another household's account, member or receipt onto this
  // household's books — the RLS that guards the row does not guard what the row
  // points at.
  for (const [table, id, noun] of [
    ['financial_accounts', input.accountId, 'account'],
    ['family_members', input.memberId, 'member'],
    ['documents', input.receiptDocumentId, 'receipt'],
  ] as const) {
    if (!id) continue;
    const { data, error } = await scope.db
      .from(table)
      .select('id')
      .eq('family_id', scope.familyId)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      console.error(`[service:finances] ${table} check failed`, error);
      return fail(describeDbError(error, `Could not check that ${noun}.`), { code: SERVICE_CODES.db });
    }
    if (!data) return fail(`That ${noun} does not belong to this family.`, { code: SERVICE_CODES.notFound });
  }

  const { data, error } = await scope.db
    .from('transactions')
    .insert({
      family_id: scope.familyId,
      name,
      amount,
      type: input.type ?? 'expense',
      merchant: input.merchant?.trim() || null,
      category: input.category?.trim() || null,
      date,
      notes: input.notes?.trim() || null,
      account_id: input.accountId ?? null,
      member_id: input.memberId ?? null,
      receipt_document_id: input.receiptDocumentId ?? null,
      source,
      created_by: scope.userId,
    })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[service:finances] transaction insert failed', error);
    return fail(describeDbError(error, 'Could not record that transaction.'), { code: SERVICE_CODES.db });
  }

  await recordActivitySafely(scope, {
    agent: 'finances',
    action: 'create',
    title: `Recorded ${formatDollars(toCents(data.amount))}${data.merchant ? ` at ${data.merchant}` : ''}`,
    href: '/dashboard/finances',
  });
  return ok(data);
}

export type CreateSavingsGoalInput = {
  name: string;
  targetAmount: number;
  currentAmount?: number | null;
  targetDate?: string | null;
  emoji?: string | null;
};

export async function createSavingsGoal(scope: ServiceScope, input: CreateSavingsGoalInput): Promise<ServiceResult<SavingsGoalRow>> {
  const allowed = assertFinanceWriter(scope);
  if (!allowed.ok) return allowed;
  const name = input.name?.trim() ?? '';
  if (!name) return fail('A savings goal needs a name.', { code: SERVICE_CODES.invalidInput });
  if (!Number.isFinite(input.targetAmount) || input.targetAmount <= 0) {
    return fail('A savings goal needs a target above zero.', { code: SERVICE_CODES.invalidInput });
  }
  if (input.targetDate && !DAY_KEY.test(input.targetDate)) {
    return fail('The target date must be YYYY-MM-DD.', { code: SERVICE_CODES.invalidInput });
  }
  const target = toDollars(toCents(input.targetAmount));
  const current = toDollars(Math.max(0, toCents(input.currentAmount ?? 0)));

  return withIdempotency<SavingsGoalRow>(
    scope,
    {
      operation: 'finances.createSavingsGoal',
      input: { name, target },
      // A retried run must not create "Summer trip" twice; the natural key is
      // the name, which is also what a family would call a duplicate.
      find: async () => {
        const { data, error } = await scope.db
          .from('savings_goals')
          .select('*')
          .eq('family_id', scope.familyId)
          .ilike('name', name.replace(/[%_]/g, (m) => `\\${m}`))
          .limit(1)
          .maybeSingle();
        if (error) {
          console.error('[service:finances] savings goal probe failed', error);
          return fail(describeDbError(error, 'Could not check for an existing goal.'), { code: SERVICE_CODES.db });
        }
        return ok(data ?? null);
      },
    },
    async () => {
      const { data, error } = await scope.db
        .from('savings_goals')
        .insert({
          family_id: scope.familyId,
          name,
          target_amount: target,
          current_amount: current,
          target_date: input.targetDate ?? null,
          ...(input.emoji ? { emoji: input.emoji } : {}),
          created_by: scope.userId,
        })
        .select('*')
        .single();
      if (error || !data) {
        console.error('[service:finances] savings goal insert failed', error);
        return fail(describeDbError(error, 'Could not create that savings goal.'), { code: SERVICE_CODES.db });
      }
      await recordActivitySafely(scope, {
        agent: 'finances',
        action: 'create',
        title: `Started a savings goal: ${data.name} (${formatDollars(toCents(data.target_amount))})`,
        href: '/dashboard/finances',
      });
      return ok(data);
    },
  );
}

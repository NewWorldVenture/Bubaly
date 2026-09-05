// Budgets against what was actually spent, the savings goals still open, and
// the bills due in the next two weeks. Manager-only by policy (§4): the slice
// is never even loaded for a child or teen, and `finances.budgetVsActual`
// re-checks the role itself. Amounts by category only — no account numbers,
// no card details (those tables are on the deny-list).
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { budgetVsActual } from '@/lib/services/finances';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import type { SliceDefinition } from '../policy';
import { dayKeyLabel, money, shiftDayKey } from '../render';

const MAX_GOALS = 10;
const MAX_BILLS = 15;
const BILL_HORIZON_DAYS = 14;

export type MoneySliceData = {
  currency: string;
  month: string;
  budgets: { category: string; period: string; limit: number; spent: number; remaining: number; pct: number; over: boolean }[];
  totals: { limit: number; spent: number; overCount: number };
  goals: { id: string; name: string; target: number; current: number; targetDate: string | null }[];
  bills: { id: string; name: string; amount: number; dueDate: string; status: string; autopay: boolean }[];
};

/** The app's only currency until `families` carries one; kept here so the prompt and the snapshot agree. */
export const DEFAULT_CURRENCY = 'USD';

export const moneySlice: SliceDefinition = {
  name: 'money',
  title: 'Money',
  async load(scope, env) {
    const horizon = shiftDayKey(env.todayKey, BILL_HORIZON_DAYS, env.tz);
    const [budgets, goals, bills] = await Promise.all([
      budgetVsActual(scope, {}),
      scope.db
        .from('savings_goals')
        .select('id, name, target_amount, current_amount, target_date')
        .eq('family_id', scope.familyId)
        .order('target_date', { ascending: true, nullsFirst: false })
        .limit(MAX_GOALS),
      scope.db
        .from('bills')
        .select('id, name, amount, due_date, status, autopay')
        .eq('family_id', scope.familyId)
        .neq('status', 'paid')
        .lte('due_date', horizon)
        .order('due_date', { ascending: true })
        .limit(MAX_BILLS),
    ]);
    if (!budgets.ok) return budgets;
    if (goals.error) {
      console.error('[ai-context:money] savings goals read failed', goals.error);
      return fail(describeDbError(goals.error, 'Could not load the savings goals.'), { code: SERVICE_CODES.db });
    }
    if (bills.error) {
      console.error('[ai-context:money] bills read failed', bills.error);
      return fail(describeDbError(bills.error, 'Could not load the bills.'), { code: SERVICE_CODES.db });
    }

    const data: MoneySliceData = {
      currency: DEFAULT_CURRENCY,
      month: budgets.data.month,
      budgets: budgets.data.budgets.map((b) => ({
        category: b.category, period: b.period, limit: b.limit, spent: b.spent, remaining: b.remaining, pct: b.pct, over: b.over,
      })),
      totals: { limit: budgets.data.totalLimit, spent: budgets.data.totalSpent, overCount: budgets.data.overCount },
      goals: (goals.data ?? [])
        .filter((g) => Number(g.current_amount) < Number(g.target_amount))
        .map((g) => ({ id: g.id, name: g.name, target: Number(g.target_amount), current: Number(g.current_amount), targetDate: g.target_date })),
      bills: (bills.data ?? []).map((b) => ({ id: b.id, name: b.name, amount: Number(b.amount), dueDate: b.due_date, status: b.status, autopay: b.autopay })),
    };

    const cur = data.currency;
    const lines: string[] = [];
    if (data.budgets.length) {
      lines.push(`- Budgets this month: ${money(data.totals.spent, cur)} of ${money(data.totals.limit, cur)} spent${data.totals.overCount ? `, ${data.totals.overCount} over` : ''}`);
      for (const b of data.budgets) {
        lines.push(`- ${sanitizeUntrusted(b.category, 30)} (${b.period}): ${money(b.spent, cur)} of ${money(b.limit, cur)}, ${b.pct}%${b.over ? ' OVER' : ''}`);
      }
    } else {
      lines.push('- No budgets set up yet.');
    }
    for (const g of data.goals) {
      lines.push(`- Goal ${fenceUntrusted('goal', g.name)}: ${money(g.current, cur)} of ${money(g.target, cur)}${g.targetDate ? ` by ${dayKeyLabel(g.targetDate)}` : ''}`);
    }
    for (const b of data.bills) {
      const overdue = b.status === 'overdue' || b.dueDate < env.todayKey;
      lines.push(`- Bill ${fenceUntrusted('bill', b.name)}: ${money(b.amount, cur)} ${overdue ? 'OVERDUE since' : 'due'} ${dayKeyLabel(b.dueDate)}${b.autopay ? ' (autopay)' : ''}`);
    }

    return ok({ data, count: data.budgets.length + data.goals.length + data.bills.length, lines });
  },
};

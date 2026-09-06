// Money tools. Every read here is `finances`, a HIGH_STAKES_AI_DOMAIN, so
// the executor evaluates it as `view` and the view-sensitivity rule in
// `riskToDecision` denies a child, teen, caregiver or guest actor before a
// single row is read. The service underneath repeats the check for callers
// that bypass the gate.
//
// Nothing in these outputs is estimated: `lib/services/finances` sums rows
// and reports the window it summed, and the tool passes both through so the
// model can cite "$412 of $500 for Sept 1–30" rather than "about $400".
//
// Two writes. Changing a budget is HIGH risk — it silently changes what
// every later "are we over budget" answer says — so it always asks a person.
// Starting a savings goal is medium: reversible, but it is a financial
// commitment the family will see on the Finances page.
import 'server-only';
import { z } from 'zod';
import {
  budgetVsActual, comparePeriods, createSavingsGoal, createTransaction, formatDollars, listTransactions, merchantMovement,
  recurringChanges, spendingByCategory, toCents, unusualTransactions, updateBudget,
} from '@/lib/services/finances';
import { ok } from '@/lib/services/types';
import { defineTool, plural, type ToolDefinition } from './types';

const range = z.object({ from: z.string(), to: z.string() });

const PERIOD_NOUN: Record<'weekly' | 'monthly' | 'yearly', string> = { weekly: 'week', monthly: 'month', yearly: 'year' };

const transaction = z.object({
  id: z.string(),
  name: z.string(),
  merchant: z.string().nullable(),
  amount: z.number().describe('Dollars'),
  category: z.string().nullable(),
  date: z.string(),
  type: z.string(),
  member_id: z.string().nullable(),
});

const windowInput = z.object({
  from: z.string().nullish().describe('YYYY-MM-DD; defaults to 30 days before `to`'),
  to: z.string().nullish().describe('YYYY-MM-DD; defaults to today'),
});

export const financeTools: ToolDefinition[] = [
  defineTool({
    name: 'finances.listTransactions',
    aliases: ['list_transactions', 'get_transactions'],
    description: 'List transactions in a date window, newest first. Amounts are dollars.',
    domain: 'finances',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: windowInput.extend({
      type: z.enum(['income', 'expense', 'transfer']).nullish(),
      category: z.string().nullish(),
      member_id: z.string().nullish(),
      limit: z.number().int().nullish(),
    }),
    output: z.object({ range, total: z.number(), transactions: z.array(transaction) }),
    summarize: (_input, output) => (output.transactions.length === 0
      ? `No transactions between ${output.range.from} and ${output.range.to}`
      : `${plural(output.transactions.length, 'transaction')} totalling ${formatDollars(toCents(output.total))} (${output.range.from} to ${output.range.to})`),
    execute: async (scope, input) => {
      const res = await listTransactions(scope, {
        from: input.from ?? null, to: input.to ?? null, type: input.type ?? null,
        category: input.category ?? null, memberId: input.member_id ?? null, limit: input.limit ?? undefined,
      });
      if (!res.ok) return res;
      return ok({
        range: res.data.range,
        total: res.data.total,
        transactions: res.data.transactions.map((t) => ({
          id: t.id, name: t.name, merchant: t.merchant, amount: t.amount, category: t.category, date: t.date, type: t.type, member_id: t.memberId,
        })),
      });
    },
  }),

  defineTool({
    name: 'finances.spendingByCategory',
    aliases: ['spending_by_category', 'get_spending_summary'],
    description: 'Total expense spending per category in a window, largest first, with each category\'s share of the total.',
    domain: 'finances',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: windowInput.extend({ member_id: z.string().nullish() }),
    output: z.object({
      range,
      total: z.number(),
      transaction_count: z.number().int(),
      categories: z.array(z.object({ category: z.string(), spent: z.number(), count: z.number().int(), share: z.number().describe('Percent of total') })),
    }),
    summarize: (_input, output) => (output.categories.length === 0
      ? `No spending recorded between ${output.range.from} and ${output.range.to}`
      : `Spent ${formatDollars(toCents(output.total))} across ${plural(output.categories.length, 'category', 'categories')}; biggest was ${output.categories[0].category} at ${formatDollars(toCents(output.categories[0].spent))}`),
    execute: async (scope, input) => {
      const res = await spendingByCategory(scope, { from: input.from ?? null, to: input.to ?? null, memberId: input.member_id ?? null });
      if (!res.ok) return res;
      return ok({ range: res.data.range, total: res.data.total, transaction_count: res.data.transactionCount, categories: res.data.categories });
    },
  }),

  defineTool({
    name: 'finances.budgetVsActual',
    aliases: ['budget_vs_actual', 'check_budgets'],
    description: 'Every budget against what was actually spent in its period, most-used first. Includes the exact days each figure covers.',
    domain: 'finances',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ month: z.string().nullish().describe('YYYY-MM; defaults to the current month') }),
    output: z.object({
      month: z.string(),
      total_limit: z.number(),
      total_spent: z.number(),
      over_count: z.number().int(),
      budgets: z.array(z.object({
        budget_id: z.string(), category: z.string(), period: z.string(), limit: z.number(), spent: z.number(),
        remaining: z.number(), pct: z.number(), over: z.boolean(), window: range, transaction_count: z.number().int(),
      })),
    }),
    summarize: (_input, output) => (output.budgets.length === 0
      ? 'No budgets are set up yet'
      : output.over_count === 0
        ? `All ${plural(output.budgets.length, 'budget')} on track for ${output.month} (${formatDollars(toCents(output.total_spent))} of ${formatDollars(toCents(output.total_limit))})`
        : `${plural(output.over_count, 'budget')} over for ${output.month}: ${output.budgets.filter((b) => b.over).map((b) => `${b.category} ${formatDollars(toCents(b.spent))}/${formatDollars(toCents(b.limit))}`).join(', ')}`),
    execute: async (scope, input) => {
      const res = await budgetVsActual(scope, { month: input.month ?? null });
      if (!res.ok) return res;
      return ok({
        month: res.data.month,
        total_limit: res.data.totalLimit,
        total_spent: res.data.totalSpent,
        over_count: res.data.overCount,
        budgets: res.data.budgets.map((b) => ({
          budget_id: b.budgetId, category: b.category, period: b.period, limit: b.limit, spent: b.spent,
          remaining: b.remaining, pct: b.pct, over: b.over, window: b.window, transaction_count: b.transactionCount,
        })),
      });
    },
  }),

  defineTool({
    name: 'finances.comparePeriods',
    aliases: ['compare_spending_periods'],
    description: 'Compare expense spending in a window with the previous window of the same length (or a window you give), per category, biggest swings first.',
    domain: 'finances',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: windowInput.extend({
      compare_from: z.string().nullish().describe('YYYY-MM-DD start of the comparison window'),
      compare_to: z.string().nullish().describe('YYYY-MM-DD end of the comparison window'),
    }),
    output: z.object({
      range,
      previous_range: range,
      current: z.number(),
      previous: z.number(),
      delta: z.number(),
      delta_pct: z.number().nullable(),
      categories: z.array(z.object({ category: z.string(), current: z.number(), previous: z.number(), delta: z.number(), delta_pct: z.number().nullable() })),
    }),
    summarize: (_input, output) => {
      const direction = output.delta > 0 ? 'up' : output.delta < 0 ? 'down' : 'unchanged';
      const head = `Spending ${direction}${output.delta !== 0 ? ` ${formatDollars(Math.abs(toCents(output.delta)))}` : ''}: ${formatDollars(toCents(output.current))} vs ${formatDollars(toCents(output.previous))} before`;
      const driver = output.categories.find((c) => c.delta !== 0);
      return driver ? `${head}; biggest change ${driver.category} (${driver.delta > 0 ? '+' : '−'}${formatDollars(Math.abs(toCents(driver.delta)))})` : head;
    },
    execute: async (scope, input) => {
      const res = await comparePeriods(scope, { from: input.from ?? null, to: input.to ?? null, compareFrom: input.compare_from ?? null, compareTo: input.compare_to ?? null });
      if (!res.ok) return res;
      return ok({
        range: res.data.range, previous_range: res.data.previousRange,
        current: res.data.current, previous: res.data.previous, delta: res.data.delta, delta_pct: res.data.deltaPct,
        categories: res.data.categories.map((c) => ({ category: c.category, current: c.current, previous: c.previous, delta: c.delta, delta_pct: c.deltaPct })),
      });
    },
  }),

  defineTool({
    name: 'finances.merchantMovement',
    aliases: ['merchant_movement', 'spending_by_merchant'],
    description: 'Which merchants the family spent more or less at than in the previous window, plus merchants that appeared or vanished.',
    domain: 'finances',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: windowInput.extend({ limit: z.number().int().nullish() }),
    output: z.object({
      range,
      previous_range: range,
      merchants: z.array(z.object({ merchant: z.string(), current: z.number(), previous: z.number(), delta: z.number(), visits: z.number().int(), status: z.enum(['new', 'gone', 'up', 'down', 'flat']) })),
    }),
    summarize: (_input, output) => (output.merchants.length === 0
      ? 'No merchant activity in either window'
      : `${plural(output.merchants.length, 'merchant')} compared; largest move ${output.merchants[0].merchant} (${output.merchants[0].status}, ${formatDollars(toCents(output.merchants[0].delta))})`),
    execute: async (scope, input) => {
      const res = await merchantMovement(scope, { from: input.from ?? null, to: input.to ?? null, limit: input.limit ?? undefined });
      if (!res.ok) return res;
      return ok({ range: res.data.range, previous_range: res.data.previousRange, merchants: res.data.merchants });
    },
  }),

  defineTool({
    name: 'finances.recurringChanges',
    aliases: ['recurring_charge_changes', 'subscription_changes'],
    description: 'Recurring charges (seen in two or more months) whose latest amount changed from the previous one.',
    domain: 'finances',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ months: z.number().int().nullish().describe('How many months back to look; defaults to 3') }),
    output: z.object({
      range,
      changes: z.array(z.object({ merchant: z.string(), months: z.array(z.string()), latest_amount: z.number(), previous_amount: z.number(), delta: z.number(), delta_pct: z.number().nullable(), latest_date: z.string() })),
    }),
    summarize: (_input, output) => (output.changes.length === 0
      ? 'No recurring charges changed amount'
      : `${plural(output.changes.length, 'recurring charge')} changed; ${output.changes[0].merchant} went ${output.changes[0].delta > 0 ? 'up' : 'down'} to ${formatDollars(toCents(output.changes[0].latest_amount))}`),
    execute: async (scope, input) => {
      const res = await recurringChanges(scope, { months: input.months ?? undefined });
      if (!res.ok) return res;
      return ok({
        range: res.data.range,
        changes: res.data.changes.map((c) => ({ merchant: c.merchant, months: c.months, latest_amount: c.latestAmount, previous_amount: c.previousAmount, delta: c.delta, delta_pct: c.deltaPct, latest_date: c.latestDate })),
      });
    },
  }),

  defineTool({
    name: 'finances.unusualTransactions',
    aliases: ['unusual_transactions', 'flag_unusual_spending'],
    description: 'Expenses in a window that stand out against the preceding baseline period, each with the reason it was flagged.',
    domain: 'finances',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: windowInput.extend({ baseline_days: z.number().int().nullish().describe('Length of the baseline before the window; defaults to 90') }),
    output: z.object({ range, baseline: range, unusual: z.array(transaction.extend({ reason: z.string() })) }),
    summarize: (_input, output) => (output.unusual.length === 0
      ? `Nothing unusual between ${output.range.from} and ${output.range.to}`
      : `${plural(output.unusual.length, 'unusual transaction')}; largest ${output.unusual[0].name} ${formatDollars(toCents(output.unusual[0].amount))}`),
    execute: async (scope, input) => {
      const res = await unusualTransactions(scope, { from: input.from ?? null, to: input.to ?? null, baselineDays: input.baseline_days ?? undefined });
      if (!res.ok) return res;
      return ok({
        range: res.data.range,
        baseline: res.data.baseline,
        unusual: res.data.unusual.map((t) => ({
          id: t.id, name: t.name, merchant: t.merchant, amount: t.amount, category: t.category, date: t.date, type: t.type, member_id: t.memberId, reason: t.reason,
        })),
      });
    },
  }),

  defineTool({
    name: 'finances.updateBudget',
    aliases: ['update_budget', 'set_budget'],
    description: 'Set the budget for a spending category, creating it if the family has none. Amount is dollars.',
    domain: 'finances',
    capability: 'edit',
    risk: 'high',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      category: z.string(),
      amount: z.number().describe('Dollars per period'),
      period: z.enum(['weekly', 'monthly', 'yearly']).nullish().describe('Defaults to the existing period, or monthly for a new budget'),
    }),
    output: z.object({
      budget_id: z.string(), category: z.string(), period: z.string(), amount: z.number(), created: z.boolean(), previous_amount: z.number().nullable(),
    }),
    summarize: (_input, output) => (output.created
      ? `Created a ${formatDollars(toCents(output.amount))} ${output.period} budget for ${output.category}`
      : `Set the ${output.category} budget to ${formatDollars(toCents(output.amount))} ${output.period}${output.previous_amount != null ? ` (was ${formatDollars(toCents(output.previous_amount))})` : ''}`),
    // Two plan steps that both set the Groceries budget must collapse to one
    // change; the natural key is the category, because the second step's amount
    // is the one a person would have approved last.
    idempotencyFrom: (input) => `finances.updateBudget:${input.category.trim().toLowerCase()}`,
    consequences: (input) => [
      `Sets the ${input.category ?? 'chosen'} budget to ${Number.isFinite(input.amount) ? formatDollars(toCents(input.amount)) : 'a new amount'}${input.period ? ` per ${PERIOD_NOUN[input.period]}` : ''}.`,
      'Every later over-budget alert and spending review will measure against the new figure.',
    ],
    resource: (output) => ({ table: 'budgets', id: output.budget_id }),
    execute: async (scope, input) => {
      const res = await updateBudget(scope, { category: input.category, amount: input.amount, period: input.period ?? null });
      if (!res.ok) return res;
      const b = res.data.budget;
      return ok({ budget_id: b.id, category: b.category, period: b.period, amount: Number(b.amount), created: res.data.created, previous_amount: res.data.previousAmount });
    },
  }),

  defineTool({
    name: 'finances.createTransaction',
    aliases: ['create_transaction', 'record_purchase', 'record_transaction'],
    description: 'Record a purchase or a payment on the household books. Amount is dollars and always positive — say which way the money went with `type`.',
    domain: 'finances',
    capability: 'create',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      name: z.string().describe('What the family would call it: "Groceries", "Swim class fees"'),
      amount: z.number().describe('Dollars, always positive'),
      type: z.enum(['income', 'expense', 'transfer']).nullish().describe('Defaults to expense'),
      merchant: z.string().nullish(),
      category: z.string().nullish(),
      date: z.string().nullish().describe('YYYY-MM-DD; defaults to today in the family time zone'),
      notes: z.string().nullish(),
      account_id: z.string().nullish().describe('A financial_accounts id belonging to this family'),
      member_id: z.string().nullish().describe('Who spent it — a family_members id'),
      receipt_document_id: z.string().nullish().describe('The documents id of the receipt this came from, if there is one'),
    }),
    output: z.object({
      id: z.string(), name: z.string(), amount: z.number(),
      type: z.enum(['income', 'expense', 'transfer']), date: z.string(), merchant: z.string().nullable(),
    }),
    // NO natural key, deliberately. `resolveIdempotencyKey` only consults this
    // when the caller supplies none, and the run executor always supplies a
    // per-step key — so this is the chat path's protection, and there is no
    // honest natural key for a charge. Two identical purchases are two real
    // rows; see `createTransaction`'s header on why a merchant+amount+date key
    // would silently delete the second one.
    idempotencyFrom: () => null,
    summarize: (_input, output) => `Recorded ${formatDollars(toCents(output.amount))}${output.merchant ? ` at ${output.merchant}` : ''} on ${output.date}`,
    consequences: (input) => [
      `Adds ${Number.isFinite(input.amount) ? formatDollars(toCents(input.amount)) : 'a charge'}${input.merchant ? ` at ${input.merchant}` : ''} to the household books, where it counts against the budget.`,
    ],
    resource: (output) => ({ table: 'transactions', id: output.id }),
    execute: async (scope, input) => {
      const res = await createTransaction(scope, {
        name: input.name,
        amount: input.amount,
        type: input.type ?? undefined,
        merchant: input.merchant ?? null,
        category: input.category ?? null,
        date: input.date ?? null,
        notes: input.notes ?? null,
        accountId: input.account_id ?? null,
        memberId: input.member_id ?? null,
        receiptDocumentId: input.receipt_document_id ?? null,
      });
      if (!res.ok) return res;
      const t = res.data;
      return ok({ id: t.id, name: t.name, amount: Number(t.amount), type: t.type, date: t.date, merchant: t.merchant });
    },
  }),
  defineTool({
    name: 'finances.createSavingsGoal',
    aliases: ['create_savings_goal', 'add_savings_goal'],
    description: 'Start a savings goal with a target amount in dollars and an optional target date.',
    domain: 'finances',
    capability: 'create',
    risk: 'medium',
    readOnly: false,
    activityFrom: 'service',
    input: z.object({
      name: z.string(),
      target_amount: z.number().describe('Dollars'),
      current_amount: z.number().nullish().describe('Dollars already saved'),
      target_date: z.string().nullish().describe('YYYY-MM-DD'),
      emoji: z.string().nullish(),
    }),
    output: z.object({ id: z.string(), name: z.string(), target_amount: z.number(), current_amount: z.number(), target_date: z.string().nullable() }),
    idempotencyFrom: (input) => `finances.createSavingsGoal:${input.name.trim().toLowerCase()}`,
    summarize: (_input, output) => `Started saving for ${output.name}: ${formatDollars(toCents(output.target_amount))}${output.target_date ? ` by ${output.target_date}` : ''}`,
    consequences: (input) => [`Adds a ${Number.isFinite(input.target_amount) ? formatDollars(toCents(input.target_amount)) : ''} savings goal called "${input.name ?? ''}" to the Finances page.`],
    resource: (output) => ({ table: 'savings_goals', id: output.id }),
    execute: async (scope, input) => {
      const res = await createSavingsGoal(scope, {
        name: input.name, targetAmount: input.target_amount, currentAmount: input.current_amount ?? null, targetDate: input.target_date ?? null, emoji: input.emoji ?? null,
      });
      if (!res.ok) return res;
      const g = res.data;
      return ok({ id: g.id, name: g.name, target_amount: Number(g.target_amount), current_amount: Number(g.current_amount), target_date: g.target_date });
    },
  }),
];

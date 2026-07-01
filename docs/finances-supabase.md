# Finances — data model & wiring

The `/dashboard/billing` route (the "Finances" nav item) renders
`components/modules/billing-module.tsx`. The **Overview** tab is a family-finance
dashboard; **every value is read from Supabase** (no mock data). The same module
also hosts the Bubaly (Stripe) subscription manager below the fold.

## Tables

| Table | Role |
| --- | --- |
| `financial_accounts` | Accounts rail: `name`, `type` (checking/savings/credit/investment/retirement), `last_four`, `balance`, `currency`. |
| `transactions` | Ledger: `account_id`, **`member_id`** (who spent it → Spending by Person), `name`, `amount` (negative = expense), `category`, `date`, `type` (income/expense/transfer). |
| `budgets` | Per-category monthly limits: `category`, `amount`, `period`. |
| `bills` | Bills & Reminders: `name`, `amount`, `due_date`, `status` (upcoming/paid/overdue), `category`, `is_recurring`. |
| `savings_goals` | Savings rail: `name`, `target_amount`, `current_amount`, `emoji`, `target_date`. |

All five carry a family-scoped `"Members can manage <table>"` FOR ALL RLS policy
(migration `0006`), so members only read/write their own family's rows.

### Migration `0108_transactions_member.sql`
Adds a nullable `transactions.member_id` FK → `family_members(id)` plus an
`(family_id, member_id)` index. Additive and backward-compatible — existing
transactions stay valid (unattributed). This powers **Spending by Person**.

## Where each Overview element comes from

- **Overview stat cards** (Total Balance / Income / Expenses / Savings) —
  `computeTotals`: balance = Σ account balances; income/expenses = this month's
  transactions; the ↗ deltas compare against last calendar month.
- **Budget & Spending donut + list** — `categorySpend` groups this month's
  expenses by category (with emoji + color), collapsing the tail into "Other".
- **Budget Progress bar** — `budgetTotals`: Σ spent vs Σ budgeted.
- **Recent Transactions** — latest `transactions` rows.
- **Bills & Reminders** — the mini calendar marks `bills.due_date` days by status;
  the list shows upcoming bills.
- **Spending by Person** — `spendingByPerson` attributes expenses via
  `transactions.member_id`, ranked with per-member percentages.
- **Accounts rail** — `financial_accounts`; the monthly ↗ change per account is
  `accountMonthlyChange` (net of this month's transactions on that account).
- **Savings Goals rail** — `savings_goals` with `current/target` progress.
- **Money Tip** — `moneyTip` compares dining-out spend month-over-month.

## Interactions (all persisted)

Add Transaction (with account + **person** attribution), Link Account, More ▾
(add budget/bill/goal, full report, jump to subscription), delete
transaction/budget/bill/goal/account, and the full detail tabs (Transactions,
Budgets, Bills, Savings Goals, Reports). Loading skeletons, empty/error states,
toasts, and amount validation are in place.

## Pure logic + tests

Aggregations live in `lib/finances/overview.ts` (totals, category spend, budget
totals, spending-by-person, account monthly change, money tip) and are unit-tested
in `tests/finances-overview.test.ts` (12 tests). The component wires these pure
transforms to already-fetched rows.

## Seeding demo data

`supabase/seed_finances_one_family.sql` seeds **500 transactions** + 6 accounts +
8 budgets + 5 savings goals + ~18 bills for the target family, covering every
category/type, this-month + trailing-months dates, and member attribution. It is
idempotent (seeded transactions tagged `notes = '[seed:finances]'`; accounts/
budgets/goals/bills matched by name/category) and repairs RLS + ensures
`member_id` first.

```bash
npm run db:seed:finances      # uses $SUPABASE_DB_URL or local default
# or paste supabase/seed_finances_one_family.sql into the Supabase SQL editor

# Apply the migration first (adds transactions.member_id):
supabase db push              # or run supabase/migrations/0108_transactions_member.sql
```

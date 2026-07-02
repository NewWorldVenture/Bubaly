# Finances hub — expandable nav + sub-pages

The sidebar's **Finances** entry is now an expandable group (same mechanism as
Family/Meals). It links to ten destinations; four reuse existing routes and six
are new (reusing existing finance tables, so no domain duplication).

| Child | Route | Component / table |
| --- | --- | --- |
| Budget Planner | `/dashboard/budgets` | `budgets-view` → `budgets` (+ `transactions` for spend) |
| My Wallet | `/wallet` | existing |
| Allowances | `/wallet/allowance` | existing |
| Expense Tracker | `/dashboard/expenses` | existing |
| Savings Goals | `/dashboard/savings` | `savings-view` → `savings_goals` |
| Bill Manager | `/dashboard/bills` | `bills-view` (mode=all) → `bills` |
| Subscriptions | `/dashboard/subscriptions` | existing |
| Payment History | `/dashboard/payments` | `payments-view` → `transactions` (read-only) |
| Auto Pay | `/dashboard/autopay` | `bills-view` (mode=autopay) → `bills` |
| Due Reminders | `/dashboard/due` | `bills-view` (mode=due) → `bills` |

Pure tested helpers: `lib/finance/hub.ts` (`billDueStatus`, `budgetSpent`,
`periodStart`, `pct`, formatting) — `tests/finance-hub.test.ts`.

## What's wired

- **Budget Planner** — set category budgets; spend is computed live from
  `transactions` for the current period, with over-budget states.
- **Bill Manager / Auto Pay / Due Reminders** — one `bills-view` with a `mode`
  prop: add bills, mark paid/unpaid, toggle Auto Pay, delete; Due Reminders
  groups by overdue / due-soon / upcoming.
- **Savings Goals** — goals with progress + "Add funds" (updates
  `current_amount`).
- **Payment History** — searchable, type-filtered, month-grouped transaction
  history.

All realtime, with loading skeletons, empty states, toasts, and confirms on
destructive actions.

## Supabase (migration 0116_bills_autopay.sql)

Additive: `bills.autopay boolean` + due/autopay indexes. `bills` already has
family-scoped RLS. The other tables (`budgets`, `savings_goals`, `transactions`)
are reused as-is.

## Migration & seed

```bash
npm run db:push          # apply migration 0116
npm run db:seed:finance  # 20 bills (mixed due/status/autopay), 8 budgets, 6 goals
# Payment History uses transactions — seed via: npm run db:seed:wallet
```

Validated on a throwaway PG16. No new environment variables.

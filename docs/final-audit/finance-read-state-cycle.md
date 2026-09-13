# Finance read-state repair

Permanent audit ID: DATA-003. Status: IN PROGRESS; local presentation repairs are verified, while complete financial workflows remain open.

## Reproduced behavior

Five queries across Budget Planner, Bill Manager / Auto Pay / Due Reminders, Savings Goals and Payment History omitted the shared hook's read error. Budget calculations also omitted the transaction loading state. Payment summaries rendered before the first read completed.

Ten actual React/Chromium cases failed against the original views: failed reads displayed successful empty states, unavailable transactions produced zero budget spending and a full remaining allowance, and pending/failed payment reads still displayed summary amounts. Four additional cases reproduced saved cache rows appearing as current balances while revalidation was still pending. These are read/presentation failures, separate from subscription pricing.

## Repair

All four views consume the shared hook's error, loading and stale signals. They use the existing translated ErrorState and retry control for failures; pending or unvalidated saved data uses the existing loading components. Computed financial summaries and successful empty states wait for successful required reads. Budget retry refreshes both budgets and transactions. Payment search/filter state survives retry.

No new copy, schema, navigation, transaction mutation, billing provider or dependency change was needed. Cache data remains stored; the views wait for revalidation before presenting it as a current financial balance.

## Verification

- Fourteen actual React/Chromium cases passed after the repairs, in 2.1 seconds. All fourteen had first demonstrated the relevant original failures (ten read/error/retry cases, then four saved-cache cases).
- The browser harness executes the actual views, finance calculations, shared error/loading states and buttons. It controls the query-result boundary and records retry calls; it does not stand in for database/provider verification. The shared hook's transport/lifecycle behavior is separately exercised by the auth/cache browser suites.
- Five related finance suites / 115 tests passed: finance helpers, read boundaries, savings contribution concurrency and finance services.
- Scoped lint passed for all four views and the browser spec.

Evidence: `tests/e2e/finance-read-states.spec.ts`; temporary host logs `bubaly-finance-read-red-20260912.log`, `bubaly-finance-stale-red-20260912.log`, `bubaly-finance-read-green-20260912.log`, `bubaly-finance-read-units-20260912.log`, and `bubaly-finance-read-lint-20260912.log`.

## Remaining obligations

This cycle does not verify full financial CRUD, role/tenant authorization, persisted mutation readback, provider synchronization or complete transaction history. The existing 500-row Payment History limit and unpaginated budget transaction query can still require separate totals/pagination review. The other shared-hook consumers that omit read errors remain in DATA-002's caller audit. No production financial action was performed.

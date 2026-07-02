# My Wallet hub — Supabase wiring & seed

The `/wallet` page ("My Wallet") — one place for the family's money, cards,
passes/memberships and rewards. Rebuilt from the kids-wallet landing to match
the product mock, fully Supabase-wired (no mock data).

## Page & components

| Concern | File |
| --- | --- |
| Route | `app/(app)/wallet/page.tsx` |
| UI (client) | `components/wallet/wallet-hub.tsx` |
| Server actions (create/delete) | `app/(app)/wallet/hub-actions.ts` |
| Pure helpers (tested) | `lib/wallet/hub.ts` |
| Unit tests | `tests/wallet-hub.test.ts` |

## Supabase tables

Reused from the finance domain (no duplicate tables):
- **`financial_accounts`** — Cash & Bank Accounts (name, type, institution,
  last_four, balance).
- **`transactions`** — Recent / All Transactions. Migration 0113 adds
  `status` (posted/pending/cleared/failed/scheduled) and `merchant`.

New (migration 0113, family-scoped RLS via `is_family_member`):
- **`wallet_cards`** — name, brand, kind, last_four, available_cents,
  limit_cents, color, member_id.
- **`wallet_passes`** — memberships/loyalty/tickets: name, kind, status,
  detail, member_no, points, expires_on.
- **`wallet_rewards`** — points/miles/cashback: name, kind, balance, unit,
  value_cents, program.

All three have `set_updated_at` triggers, sort/family indexes, and RLS
policies for SELECT/INSERT/UPDATE/DELETE scoped to `is_family_member(family_id)`.

## What's wired (no mock data)

- Overview cards (Total Balance, Cash & Accounts, Cards, Rewards Value) computed
  by `walletOverview()` from live rows.
- Tabs: Accounts / Cards / Passes / Rewards / Transactions / Documents.
- Realtime reads for all five tables (`useRealtimeQuery`).
- Create: Add Account / Card / Pass / Reward / Transaction (server actions,
  validated + family-scoped).
- Delete each row (confirm dialog, RLS-scoped).
- Transactions search; pending/scheduled statuses surfaced.
- Send Money → `/wallet/send`; Security/Settings → `/wallet/settings`;
  Documents → the Files vault.
- Loading skeleton, empty states, toasts.

## Migration

`supabase/migrations/0113_wallet_hub.sql` (additive, idempotent). Apply with
`npm run db:push` (or `supabase migration up`), or paste into the Supabase SQL
editor. Apply **before** running the seed.

## Seed (500 rows)

`supabase/seed_wallet_one_family.sql` seeds **500 transactions** plus 4
accounts, 4 cards, 3 passes and 3 reward programs for one family (default: the
active family of `newworldventurellc@gmail.com`). Coverage: every type
(expense/income/transfer) and status (posted/pending/cleared/failed/scheduled),
varied categories/merchants, member-attributed rows (e.g. allowance),
~180 days of history + future scheduled, and null-field edge cases. Idempotent
(seeded transactions tagged `notes='[seed:wallet]'`; accounts/cards/passes/
rewards reused if present).

### Run it

```bash
npm run db:seed:wallet
# or:
psql "$SUPABASE_DB_URL" -f supabase/seed_wallet_one_family.sql
```

### Verify

Open `/wallet` and hard-refresh: overview totals populate, the Accounts tab
shows accounts + recent transactions, the right rail shows cards/passes/rewards,
and the Transactions tab lists all 500 with working search.

## Environment

No new environment variables.

## Known limitations

- Balances are entered/tracked manually (no bank aggregator integration).
- The Documents tab links to the existing Files vault rather than a dedicated
  wallet-documents store.

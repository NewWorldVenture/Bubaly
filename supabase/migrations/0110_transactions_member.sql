-- Bubaly :: 0110 transactions.member_id
-- ----------------------------------------------------------------------------
-- Adds a nullable per-member attribution to transactions so the Finances
-- dashboard's "Spending by Person" card can group real spend by family member.
-- Additive + idempotent; RLS unchanged (still family-scoped via 0109).

alter table public.transactions
  add column if not exists member_id uuid references public.family_members(id) on delete set null;

create index if not exists idx_transactions_family_member on public.transactions(family_id, member_id);

-- Bubaly :: 0116 bills.autopay
-- ----------------------------------------------------------------------------
-- Adds an autopay flag to bills so the new Finances "Auto Pay" page can list and
-- toggle which bills are set to pay automatically. Additive + idempotent; the
-- bills table already has family-scoped RLS.

alter table public.bills
  add column if not exists autopay boolean not null default false;

create index if not exists idx_bills_family_due on public.bills(family_id, due_date);
create index if not exists idx_bills_family_autopay on public.bills(family_id, autopay) where autopay;

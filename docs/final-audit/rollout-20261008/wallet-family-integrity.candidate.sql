-- REVIEW CANDIDATE ONLY: unallocated, excluded from every migration/apply workflow.
-- This is not an approved production release. Reconcile target metadata, existing
-- data ownership and lock impact before composing an authorized release bundle.
-- NOT VALID preserves historical rows; it is not evidence that those rows are safe.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- id is already unique; this index supports the two-column reference check.
alter table public.child_wallets
  add constraint child_wallets_family_id_id_key unique (family_id, id);

-- Support both the existing wallet-id FK and the new two-column checks.
create index allowance_rules_child_wallet_family_idx
  on public.allowance_rules (child_wallet_id, family_id);
create index invest_orders_child_wallet_family_idx
  on public.invest_orders (child_wallet_id, family_id);

alter table public.allowance_rules
  add constraint allowance_rules_wallet_family_fkey
  foreign key (family_id, child_wallet_id)
  references public.child_wallets (family_id, id)
  on delete cascade not valid;

alter table public.invest_orders
  add constraint invest_orders_wallet_family_fkey
  foreign key (family_id, child_wallet_id)
  references public.child_wallets (family_id, id)
  on delete cascade not valid;

-- Do not VALIDATE these constraints until separately reviewed reconciliation
-- proves that every preserved historical reference belongs to the same family.
commit;

-- Migration 0093: Family Wallet (per-member buckets with auto-split allocation)
-- Each family member gets wallet buckets (Save, Spend, Give, Invest) with
-- configurable percentage splits. Incoming money is automatically divided.

-- wallet_buckets: per-member named buckets with running balance
create table if not exists public.wallet_buckets (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid not null references public.family_members(id) on delete cascade,
  bucket      text not null,  -- 'save', 'spend', 'give', 'invest', or custom
  balance_cents bigint not null default 0,
  target_cents  bigint,       -- optional goal for this bucket
  emoji       text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(family_id, member_id, bucket)
);

-- wallet_rules: per-member allocation percentages
create table if not exists public.wallet_rules (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid not null references public.family_members(id) on delete cascade,
  bucket      text not null,
  pct         int not null check (pct >= 0 and pct <= 100),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique(family_id, member_id, bucket)
);

-- wallet_transactions: full ledger of every wallet credit/debit
create table if not exists public.wallet_transactions (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  member_id     uuid not null references public.family_members(id) on delete cascade,
  bucket        text not null,
  amount_cents  bigint not null, -- positive = credit, negative = debit
  kind          text not null,   -- 'deposit', 'withdrawal', 'transfer', 'chore', 'gift', 'adjustment'
  description   text,
  reference_id  uuid,            -- optional FK to chore_assignment, gift, etc.
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

-- Indexes
create index if not exists idx_wallet_buckets_family on public.wallet_buckets(family_id);
create index if not exists idx_wallet_buckets_member on public.wallet_buckets(member_id);
create index if not exists idx_wallet_rules_family on public.wallet_rules(family_id);
create index if not exists idx_wallet_rules_member on public.wallet_rules(member_id);
create index if not exists idx_wallet_txns_family on public.wallet_transactions(family_id);
create index if not exists idx_wallet_txns_member on public.wallet_transactions(member_id);
create index if not exists idx_wallet_txns_bucket on public.wallet_transactions(family_id, member_id, bucket);
create index if not exists idx_wallet_txns_created on public.wallet_transactions(created_at desc);

-- RLS
alter table public.wallet_buckets enable row level security;
alter table public.wallet_rules enable row level security;
alter table public.wallet_transactions enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'wallet_buckets' and policyname = 'wallet_buckets_all') then
    create policy wallet_buckets_all on public.wallet_buckets for all to authenticated
      using (public.is_family_member(family_id))
      with check (public.is_family_member(family_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'wallet_rules' and policyname = 'wallet_rules_all') then
    create policy wallet_rules_all on public.wallet_rules for all to authenticated
      using (public.is_family_member(family_id))
      with check (public.is_family_member(family_id));
  end if;
  if not exists (select 1 from pg_policies where tablename = 'wallet_transactions' and policyname = 'wallet_txns_all') then
    create policy wallet_txns_all on public.wallet_transactions for all to authenticated
      using (public.is_family_member(family_id))
      with check (public.is_family_member(family_id));
  end if;
end $$;

-- Updated-at triggers
create trigger set_wallet_buckets_updated_at before update on public.wallet_buckets
  for each row execute function public.set_updated_at();
create trigger set_wallet_rules_updated_at before update on public.wallet_rules
  for each row execute function public.set_updated_at();

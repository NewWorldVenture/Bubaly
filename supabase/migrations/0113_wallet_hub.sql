-- FamilyOS :: 0113 Wallet Hub ("My Wallet")
-- ----------------------------------------------------------------------------
-- Powers the /wallet "My Wallet" hub: one place for the family's money, cards,
-- passes/memberships and rewards. Reuses the existing finance domain for
-- accounts (financial_accounts) and transactions, and adds three new
-- family-scoped tables for cards, passes and reward programs.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

-- ── transactions: posted/pending status + merchant label ────────────────────
alter table public.transactions
  add column if not exists status text not null default 'posted';
alter table public.transactions
  add column if not exists merchant text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_status_check'
  ) then
    alter table public.transactions
      add constraint transactions_status_check
      check (status in ('posted', 'pending', 'cleared', 'failed', 'scheduled'));
  end if;
end $$;

create index if not exists idx_transactions_family_date on public.transactions(family_id, date desc);
create index if not exists idx_transactions_family_status on public.transactions(family_id, status);

-- ── wallet_cards ────────────────────────────────────────────────────────────
create table if not exists public.wallet_cards (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  member_id       uuid references public.family_members(id) on delete set null,
  name            text not null,
  brand           text not null default 'other' check (brand in ('visa','mastercard','amex','discover','other')),
  kind            text not null default 'credit' check (kind in ('credit','debit','gas','store','prepaid','other')),
  last_four       text,
  available_cents bigint not null default 0,
  limit_cents     bigint,
  color           text,
  is_active       boolean not null default true,
  sort_order      int not null default 0,
  metadata        jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_wallet_cards_family on public.wallet_cards(family_id, is_active, sort_order);

-- ── wallet_passes (memberships / loyalty / tickets) ─────────────────────────
create table if not exists public.wallet_passes (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  name        text not null,
  kind        text not null default 'membership' check (kind in ('membership','loyalty','ticket','insurance','transit','other')),
  status      text,                 -- e.g. 'Member', 'Premium Plan'
  detail      text,                 -- e.g. 'Expires Dec 31, 2025', '5,240 points'
  member_no   text,
  points      integer,
  expires_on  date,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  metadata    jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_wallet_passes_family on public.wallet_passes(family_id, is_active, sort_order);

-- ── wallet_rewards (points / miles / cashback programs) ─────────────────────
create table if not exists public.wallet_rewards (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  member_id    uuid references public.family_members(id) on delete set null,
  name         text not null,
  kind         text not null default 'points' check (kind in ('points','miles','cashback')),
  balance      numeric(14,2) not null default 0,
  unit         text not null default 'points',      -- 'points' | 'miles' | '$'
  value_cents  bigint not null default 0,           -- estimated cash value
  program      text,
  is_active    boolean not null default true,
  sort_order   int not null default 0,
  metadata     jsonb not null default '{}'::jsonb,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_wallet_rewards_family on public.wallet_rewards(family_id, is_active, sort_order);

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['wallet_cards','wallet_passes','wallet_rewards'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS: family-scoped for all four operations ──────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['wallet_cards','wallet_passes','wallet_rewards'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

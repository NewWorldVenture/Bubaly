-- FamilyOS :: 0150 Marketplace matches — supply↔demand match intelligence
-- ----------------------------------------------------------------------------
-- The next level for the family marketplace (0120): connect open "wanted"
-- requests to the supply already on the board (sell / free / rent / borrow) so
-- the board becomes proactive — "Dad wants a drill; Mom listed one to borrow."
-- Matches are computed by the pure engine (lib/marketplace/matches.ts) and
-- persisted here so a family can dismiss a match (it stays quiet) and the strip
-- has a durable record. One row per (family, wanted, supply).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.marketplace_matches (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  wanted_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  supply_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  score        integer not null default 0,
  reason       text,
  status       text not null default 'active'
                 check (status in ('active', 'dismissed', 'actioned')),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (family_id, wanted_id, supply_id)
);
create index if not exists idx_marketplace_matches_family
  on public.marketplace_matches(family_id, status, score desc);

drop trigger if exists set_marketplace_matches_updated on public.marketplace_matches;
create trigger set_marketplace_matches_updated before update on public.marketplace_matches
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.marketplace_matches enable row level security;

drop policy if exists marketplace_matches_select on public.marketplace_matches;
create policy marketplace_matches_select on public.marketplace_matches
  for select using (public.is_family_member(family_id));

drop policy if exists marketplace_matches_insert on public.marketplace_matches;
create policy marketplace_matches_insert on public.marketplace_matches
  for insert with check (public.is_family_member(family_id));

drop policy if exists marketplace_matches_update on public.marketplace_matches;
create policy marketplace_matches_update on public.marketplace_matches
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

drop policy if exists marketplace_matches_delete on public.marketplace_matches;
create policy marketplace_matches_delete on public.marketplace_matches
  for delete using (public.is_family_member(family_id));

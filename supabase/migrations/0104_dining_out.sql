-- FamilyOS :: 0104 — Dining Out
-- Backs the "Dining Out" surface of the Food & Nutrition hub: saved restaurants
-- the family wants to try / loves, plus a log of recent dining-out visits.
-- Follows the food-OS conventions (0102): is_family_member RLS + set_updated_at.

create table if not exists public.dining_out (
  id           uuid        primary key default gen_random_uuid(),
  family_id    uuid        not null references public.families(id) on delete cascade,
  name         text        not null,
  kind         text        not null default 'restaurant' check (kind in ('restaurant','visit')),
  cuisine      text,
  category     text,                                   -- e.g. Healthy, Sushi, American
  price_level  int         check (price_level between 1 and 4),
  rating       numeric(2,1) check (rating >= 0 and rating <= 5),
  address      text,
  distance_km  numeric(5,1),
  amount_cents int         check (amount_cents >= 0), -- spend on a logged visit
  item_count   int         check (item_count >= 0),   -- items ordered on a visit
  notes        text,
  is_favorite  boolean     not null default false,
  visited_at   timestamptz,                            -- set for kind='visit'
  metadata     jsonb       not null default '{}',
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_dining_out_family          on public.dining_out(family_id);
create index if not exists idx_dining_out_family_kind      on public.dining_out(family_id, kind);
create index if not exists idx_dining_out_family_visited   on public.dining_out(family_id, visited_at desc);
create index if not exists idx_dining_out_family_favorite  on public.dining_out(family_id, is_favorite);

drop trigger if exists trg_set_updated_at on public.dining_out;
create trigger trg_set_updated_at before update on public.dining_out
  for each row execute function public.set_updated_at();

alter table public.dining_out enable row level security;

drop policy if exists "Members can manage dining_out" on public.dining_out;
create policy "Members can manage dining_out" on public.dining_out
  for all to authenticated
  using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

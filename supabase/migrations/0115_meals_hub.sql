-- FamilyOS :: 0115 Meals hub extras (Family Favorites + Nutrition Tracker)
-- ----------------------------------------------------------------------------
-- Backs two new pages under the expandable "Meals" nav group:
--   • family_favorites — the family's favorite recipes / restaurants / meals
--   • nutrition_logs    — per-member daily food logging (calories + macros)
-- Family-scoped RLS via public.is_family_member. Idempotent.

-- ── family_favorites ────────────────────────────────────────────────────────
create table if not exists public.family_favorites (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  kind        text not null default 'recipe' check (kind in ('recipe','restaurant','meal','snack','drink','other')),
  name        text not null,
  notes       text,
  rating      int check (rating between 1 and 5),
  ref_url     text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_family_favorites_family on public.family_favorites(family_id, kind);

-- ── nutrition_logs ──────────────────────────────────────────────────────────
create table if not exists public.nutrition_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  logged_on   date not null default (now()::date),
  meal        text not null default 'breakfast' check (meal in ('breakfast','lunch','dinner','snack')),
  item        text not null,
  calories    int not null default 0,
  protein_g   numeric(6,1) not null default 0,
  carbs_g     numeric(6,1) not null default 0,
  fat_g       numeric(6,1) not null default 0,
  water_ml    int not null default 0,
  notes       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_nutrition_logs_family_date on public.nutrition_logs(family_id, logged_on desc);
create index if not exists idx_nutrition_logs_member on public.nutrition_logs(family_id, member_id, logged_on desc);

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_favorites','nutrition_logs'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_favorites','nutrition_logs'] loop
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

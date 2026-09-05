-- Bubaly :: 0114 Family safety & play dates
-- ----------------------------------------------------------------------------
-- Backs the new expandable "Family" nav group:
--   • safety_check_ins — lightweight "I'm safe / on my way / need help" posts
--   • driving_trips     — per-driver trip log with a safety score
--   • play_dates        — kids' play-date scheduling
-- (Find Phone reuses the existing member_locations + family_places tables.)
--
-- Family-scoped RLS via public.is_family_member. Idempotent.

-- ── safety_check_ins ────────────────────────────────────────────────────────
create table if not exists public.safety_check_ins (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  status      text not null default 'safe' check (status in ('safe','on_my_way','arrived','need_help')),
  place_id    uuid references public.family_places(id) on delete set null,
  place_label text,
  note        text,
  latitude    double precision,
  longitude   double precision,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_safety_check_ins_family on public.safety_check_ins(family_id, created_at desc);

-- ── driving_trips ───────────────────────────────────────────────────────────
create table if not exists public.driving_trips (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  member_id     uuid references public.family_members(id) on delete set null,
  label         text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  distance_miles numeric(8,1) not null default 0,
  max_mph       int not null default 0,
  hard_brakes   int not null default 0,
  rapid_accels  int not null default 0,
  phone_use_seconds int not null default 0,
  score         int not null default 100 check (score between 0 and 100),
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_driving_trips_family on public.driving_trips(family_id, started_at desc);
create index if not exists idx_driving_trips_member on public.driving_trips(family_id, member_id);

-- ── play_dates ──────────────────────────────────────────────────────────────
create table if not exists public.play_dates (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  member_id     uuid references public.family_members(id) on delete set null,
  title         text not null,
  with_kids     text,
  location      text,
  place_id      uuid references public.family_places(id) on delete set null,
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  status        text not null default 'planned' check (status in ('planned','confirmed','completed','cancelled')),
  contact_name  text,
  contact_phone text,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_play_dates_family on public.play_dates(family_id, starts_at desc);

-- ── updated_at triggers (tables that have updated_at) ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['driving_trips','play_dates'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['safety_check_ins','driving_trips','play_dates'] loop
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

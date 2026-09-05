-- Bubaly :: 0147 Twin simulations — saved "what-if" activity projections (R8)
-- ----------------------------------------------------------------------------
-- R8 (Digital Twin depth): the full "if Emma joins travel soccer, what has to
-- move?" projection reasons across schedule · travel · cost · family time ·
-- homework · meals · vacation. The projection itself is a pure, no-write what-if;
-- this table is where a family SAVES a scenario they want to keep or compare
-- (verdict + weekly-hours + the per-dimension breakdown), so the decision — and
-- its reasoning — is remembered. Additive + idempotent. Family-scoped RLS.

create table if not exists public.twin_simulations (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  member_id    uuid references public.family_members(id) on delete set null,
  activity_name text not null,
  verdict      text not null default 'clear' check (verdict in ('clear', 'tight', 'conflict')),
  weekly_hours numeric(5,1) not null default 0,
  input        jsonb not null default '{}'::jsonb,   -- the ActivityDecision
  dimensions   jsonb not null default '[]'::jsonb,   -- the per-dimension projection
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_twin_simulations_family on public.twin_simulations(family_id, created_at desc);

drop trigger if exists set_twin_simulations_updated on public.twin_simulations;
create trigger set_twin_simulations_updated before update on public.twin_simulations
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.twin_simulations enable row level security;

drop policy if exists twin_simulations_select on public.twin_simulations;
create policy twin_simulations_select on public.twin_simulations
  for select using (public.is_family_member(family_id));

drop policy if exists twin_simulations_insert on public.twin_simulations;
create policy twin_simulations_insert on public.twin_simulations
  for insert with check (public.is_family_member(family_id));

drop policy if exists twin_simulations_delete on public.twin_simulations;
create policy twin_simulations_delete on public.twin_simulations
  for delete using (public.is_family_member(family_id));

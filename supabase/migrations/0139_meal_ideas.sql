-- FamilyOS :: 0139 Meal ideas — curated dinner catalog for the first-run briefing
-- ----------------------------------------------------------------------------
-- T2 (first-run instant briefing): a brand-new family has no recipes of its own,
-- so the "3 dinner ideas" in the onboarding brief can't come from the meal planner
-- (which reads the family's meals/recipes). This is a small, family-AGNOSTIC
-- reference catalog the briefing draws from — effort-tagged so we can suggest
-- quick meals on busy nights and more involved ones on the weekend.
--
-- Reference data, not family data: readable by anyone signed in; written only by
-- the seed / service role. Additive + idempotent.

create table if not exists public.meal_ideas (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  cuisine      text not null default 'Comfort',
  effort       text not null default 'standard' check (effort in ('quick', 'standard', 'involved')),
  prep_minutes integer not null default 30 check (prep_minutes >= 0),
  tags         text[] not null default '{}',
  description  text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create index if not exists idx_meal_ideas_active on public.meal_ideas(is_active, effort);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Non-sensitive catalog: any authenticated session may read it. No client writes
-- (the seed / service role populates it).
alter table public.meal_ideas enable row level security;

drop policy if exists meal_ideas_select on public.meal_ideas;
create policy meal_ideas_select on public.meal_ideas
  for select using (true);

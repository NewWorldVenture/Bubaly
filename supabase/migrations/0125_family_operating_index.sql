-- FamilyOS :: 0125 Family Operating Index (the measurable core of the Operating Layer)
-- ----------------------------------------------------------------------------
-- The Operating Layer's north-star metric is "how well is this household
-- functioning" measured over time. This table stores one append-only SNAPSHOT
-- per family per day: a weighted composite (0-100), the per-dimension scores
-- that produced it, and the ranked practical suggestions the engine surfaced.
--
-- Persisting daily lets us (a) show a trend / "what changed since yesterday",
-- (b) feed "schedule stability" from real variance over time, and (c) power the
-- Command Center's evening "what changed" summary. The score is always RECOMPUTED
-- from live data; this table is the durable ledger of those computations, never
-- the source of truth for the underlying facts.
--
-- Family-scoped RLS. Additive + idempotent (safe to re-run).

create table if not exists public.family_operating_index (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  as_of_date    date not null default current_date,      -- the local day this snapshot represents
  composite     int  not null check (composite between 0 and 100),
  band          text not null default 'steady'
                  check (band in ('thriving','steady','stretched','overloaded')),
  -- Per-dimension scores (0-100) as {key: score}; keys are the engine's dimension ids.
  dimensions    jsonb not null default '{}'::jsonb,
  -- Ranked practical suggestions [{id,title,detail,href,dimension,impact}] captured at snapshot time.
  suggestions   jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One row per family per day; the server upserts on this to stay idempotent.
  unique (family_id, as_of_date)
);
create index if not exists idx_family_operating_index_family
  on public.family_operating_index(family_id, as_of_date desc);

-- Keep updated_at honest on re-computation within the same day.
create or replace function public.touch_family_operating_index() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_family_operating_index_touch on public.family_operating_index;
create trigger trg_family_operating_index_touch
  before update on public.family_operating_index
  for each row execute function public.touch_family_operating_index();

-- ── RLS: family-scoped ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_operating_index'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

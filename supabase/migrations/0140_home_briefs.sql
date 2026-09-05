-- Bubaly :: 0140 Home briefs — "outcome, never empty" daily home snapshot
-- ----------------------------------------------------------------------------
-- T3 (TIME-TO-FIRST-VALUE): a brand-new or quiet family should land on an OUTCOME,
-- not empty widgets. The AI home now computes a first-run outcome brief — how ready
-- the week is, the next best getting-started steps, and 3 dinner ideas — and this
-- table is the durable daily snapshot of it (one row per family per day). It makes
-- the home render instantly from the last snapshot, gives a readiness trend, and is
-- the home-side signal for the TTFV metric (T10): did the family reach an outcome.
--
-- Mirrors the family_operating_index daily-snapshot pattern (0125). Additive +
-- idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.home_briefs (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  as_of_date         date not null default current_date,
  is_sparse          boolean not null default false,
  readiness_pct      integer not null default 0 check (readiness_pct between 0 and 100),
  week_count         integer not null default 0 check (week_count >= 0),
  conflict_count     integer not null default 0 check (conflict_count >= 0),
  dinner_count       integer not null default 0 check (dinner_count >= 0),
  time_saved_minutes integer not null default 0 check (time_saved_minutes >= 0),
  headline           text,
  brief              jsonb not null default '{}'::jsonb,   -- the computed HomeBrief summary
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (family_id, as_of_date)
);

create index if not exists idx_home_briefs_family on public.home_briefs(family_id, as_of_date desc);

drop trigger if exists set_home_briefs_updated on public.home_briefs;
create trigger set_home_briefs_updated before update on public.home_briefs
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.home_briefs enable row level security;

drop policy if exists home_briefs_select on public.home_briefs;
create policy home_briefs_select on public.home_briefs
  for select using (public.is_family_member(family_id));

drop policy if exists home_briefs_insert on public.home_briefs;
create policy home_briefs_insert on public.home_briefs
  for insert with check (public.is_family_member(family_id));

drop policy if exists home_briefs_update on public.home_briefs;
create policy home_briefs_update on public.home_briefs
  for update using (public.is_family_member(family_id));

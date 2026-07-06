-- FamilyOS :: 0135 Intelligence Network — aggregation storage
-- ----------------------------------------------------------------------------
-- The cross-family aggregation the design doc (§4) specifies, built on the
-- consent + k-anonymity foundation from 0132. TWO tables:
--
--   network_contributions  — FAMILY-OWNED. The only egress surface: one coarse,
--     banded feature row per consenting family (age BANDS, size BAND, habit
--     BANDS — never raw values). A family can read/delete only its own row.
--
--   network_aggregates     — SERVICE-WRITTEN. Already k-anonymized: the cron only
--     ever inserts rows whose cohort has >= K distinct families, with DP-noised
--     counts. Readable by any family that has consent.enabled + the scope opted in.
--
-- Cohort = kids age-bands × household-size band ONLY (no geography — owner sign-off).
-- Additive + idempotent. Family-scoped RLS via public.is_family_member / network_consent.

create table if not exists public.network_contributions (
  family_id  uuid primary key references public.families(id) on delete cascade,
  cohort_key text not null,
  features   jsonb not null default '{}'::jsonb,   -- banded features only
  metrics    jsonb not null default '{}'::jsonb,   -- metric → banded value
  scopes     jsonb not null default '{}'::jsonb,   -- consent snapshot at write time
  updated_at timestamptz not null default now()
);
create index if not exists idx_network_contributions_cohort on public.network_contributions(cohort_key);

create table if not exists public.network_aggregates (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null check (scope in ('timing','benchmarks','recommendations')),
  cohort_key  text not null,
  metric      text not null,
  value       text not null,
  count       integer not null,                    -- DP-noised
  cohort_size integer not null,                    -- always >= K when written
  computed_at timestamptz not null default now(),
  unique (scope, cohort_key, metric, value)
);
create index if not exists idx_network_aggregates_lookup on public.network_aggregates(scope, cohort_key);

drop trigger if exists set_network_contributions_updated on public.network_contributions;
create trigger set_network_contributions_updated before update on public.network_contributions
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.network_contributions enable row level security;
-- A family may see/delete only its own contribution row (transparency + right to be
-- forgotten). Writes happen via the service-role cron only (no client write policy).
drop policy if exists network_contributions_select on public.network_contributions;
create policy network_contributions_select on public.network_contributions
  for select using (public.is_family_member(family_id));
drop policy if exists network_contributions_delete on public.network_contributions;
create policy network_contributions_delete on public.network_contributions
  for delete using (public.is_family_member(family_id));

alter table public.network_aggregates enable row level security;
-- Published aggregates are readable by any family that has opted into the Network
-- and the matching scope. (They're already >= K + noised, so this is safe.)
drop policy if exists network_aggregates_select on public.network_aggregates;
create policy network_aggregates_select on public.network_aggregates
  for select using (
    exists (
      select 1 from public.network_consent nc
      where nc.family_id in (select family_id from public.family_members where user_id = auth.uid())
        and nc.enabled = true
        and coalesce((nc.scopes ->> network_aggregates.scope)::boolean, false) = true
    )
  );

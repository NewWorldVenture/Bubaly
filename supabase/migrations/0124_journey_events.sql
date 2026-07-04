-- FamilyOS :: 0124 Journey events (Experience Scorecard instrumentation)
-- ----------------------------------------------------------------------------
-- Lightweight product telemetry so the Experience Scorecard uses REAL medians
-- instead of design-time estimates. Each row is one phase of a user journey
-- (started / step / completed / abandoned), grouped by a client session_id so a
-- single run can be reconstructed and its duration + step count measured.
--
-- Family-scoped RLS (a family only sees its own events). Additive + idempotent.

create table if not exists public.journey_events (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  journey     text not null,                -- e.g. 'capture', 'add_memory'
  phase       text not null default 'started'
                check (phase in ('started','step','completed','abandoned')),
  step        int  not null default 0,
  session_id  text not null,               -- groups one run of a journey
  duration_ms int,                         -- set on 'completed'
  created_at  timestamptz not null default now()
);
create index if not exists idx_journey_events_family on public.journey_events(family_id, journey, created_at desc);
create index if not exists idx_journey_events_session on public.journey_events(session_id);

-- ── RLS: family-scoped ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['journey_events'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    -- events are immutable: no update/delete policies (telemetry is append-only).
  end loop;
end $$;

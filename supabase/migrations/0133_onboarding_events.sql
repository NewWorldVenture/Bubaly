-- Bubaly :: 0133 Onboarding telemetry (pre-family funnel)
-- ----------------------------------------------------------------------------
-- journey_events is family-scoped, but onboarding happens BEFORE a family exists
-- (no family_id yet), so it can't be tracked there. This is the anonymous/pre-
-- family funnel: one row per onboarding step reached, grouped by an anonymous
-- client session_id (+ the user_id once known). It powers a super-admin funnel
-- view (reach per step, completion rate, drop-off, median time). Insert is open
-- (telemetry, pre-auth), but a row can only be READ by its own user; cross-user
-- aggregation is service-role only.
--
-- Additive + idempotent.

create table if not exists public.onboarding_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,  -- null before signup
  session_id  text not null,                                       -- anonymous run id
  step        text not null,                                       -- 'profile' | 'pin' | 'done' | …
  phase       text not null default 'step'
                check (phase in ('started','step','completed','abandoned')),
  duration_ms integer,                                             -- ms since the run started
  meta        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_onboarding_events_session on public.onboarding_events(session_id, created_at);
create index if not exists idx_onboarding_events_step on public.onboarding_events(step, phase);
create index if not exists idx_onboarding_events_created on public.onboarding_events(created_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.onboarding_events enable row level security;

-- Anyone (anon or authenticated) may record their own funnel step. Rows with a
-- user_id must match the caller; anonymous (null) rows are allowed pre-signup.
drop policy if exists onboarding_events_insert on public.onboarding_events;
create policy onboarding_events_insert on public.onboarding_events
  for insert with check (user_id is null or user_id = auth.uid());

-- A user can read only their own rows. Admin analytics uses the service role.
drop policy if exists onboarding_events_select on public.onboarding_events;
create policy onboarding_events_select on public.onboarding_events
  for select using (user_id is not null and user_id = auth.uid());

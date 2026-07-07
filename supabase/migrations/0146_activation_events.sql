-- FamilyOS :: 0146 Activation telemetry — TTFV / time-to-first-value (T10)
-- ----------------------------------------------------------------------------
-- The onboarding funnel (0133) measures getting THROUGH sign-up. This measures
-- getting to VALUE: one row per activation milestone a new family reaches
-- (signup → calendar_imported → first_brief_viewed → first_outcome_viewed →
-- first_capture), keyed by a cohort session_id (one per new family). It powers
-- the TTFV panel on the super-admin onboarding-funnel dashboard: median/p90 time
-- to first outcome, activation rate, and session-1 calendar/brief rates.
--
-- Insert is open (telemetry; a row can name its own user or be anonymous); a row
-- is READable only by its own user — cross-family aggregation is service-role
-- only, exactly like onboarding_events. Additive + idempotent. PG16-validated.

create table if not exists public.activation_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid references auth.users(id) on delete set null,   -- null pre-signup
  family_id       uuid references public.families(id) on delete set null, -- once known
  session_id      text not null,                                        -- cohort (one new family)
  milestone       text not null
                    check (milestone in ('signup','calendar_imported','first_brief_viewed','first_outcome_viewed','first_capture')),
  session_index   integer not null default 1,                           -- 1 = first session
  ms_since_signup integer,                                              -- TTFV clock (ms)
  meta            jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists idx_activation_events_session on public.activation_events(session_id, created_at);
create index if not exists idx_activation_events_milestone on public.activation_events(milestone, session_index);
create index if not exists idx_activation_events_created on public.activation_events(created_at desc);

-- ── RLS (mirrors onboarding_events) ──────────────────────────────────────────
alter table public.activation_events enable row level security;

-- Anyone may record their own activation milestone; a row that names a user must
-- match the caller (anonymous rows allowed).
drop policy if exists activation_events_insert on public.activation_events;
create policy activation_events_insert on public.activation_events
  for insert with check (user_id is null or user_id = auth.uid());

-- A user can read only their own rows; admin analytics uses the service role.
drop policy if exists activation_events_select on public.activation_events;
create policy activation_events_select on public.activation_events
  for select using (user_id is not null and user_id = auth.uid());

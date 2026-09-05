-- Bubaly :: 0159 Onboarding progress — durable per-account lifecycle + marketing signal
-- ----------------------------------------------------------------------------
-- Onboarding data was, until now, scattered and partly ephemeral:
--   • onboarding_events   — anonymous, session-keyed telemetry (funnel only)
--   • onboarding_imports  — the value-step TTFV moment (family-scoped)
--   • family_onboarding   — the questionnaire (goals/household/referral), but ONLY
--                            written by the full wizard — never for the huge cohort
--                            auto-provisioned by ensureActiveFamily
--   • crm_contacts.notes  — marketing attrs stuffed into a JSON string (unsegmentable)
--
-- There was no single, queryable, per-account record of onboarding lifecycle, so:
--   1. the `onboardingComplete` flag written to user_preferences was read NOWHERE,
--   2. accounts that skipped the wizard (auto-provisioned) were invisible — no way
--      to detect "needs setup / needs reset" and nudge them to finish,
--   3. the strongest activation signal (did they import a calendar? how much time
--      did we save them?) never reached the marketing service as a segment.
--
-- This table is that record: ONE row per account (user), carrying the onboarding
-- lifecycle status, its source, which steps completed, the value-step engagement,
-- and the marketing profile (goals / referral / household / opt-in). It feeds both
-- the completeness engine (re-onboard / reset detection) and marketing segments.
--
-- Additive + idempotent. Self-scoped RLS (mirrors activation_events / a per-user
-- record): a user reads & writes only their own row; cross-account marketing
-- aggregation is service-role only. PG16-validated.

create table if not exists public.onboarding_progress (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id) on delete cascade,
  family_id           uuid references public.families(id) on delete set null,
  -- lifecycle: in_progress (started, not finished) → completed; reset re-opens it.
  status              text not null default 'in_progress'
                        check (status in ('in_progress','completed','reset')),
  -- how the family space came to be: the guided wizard, or silent auto-provision
  -- (ensureActiveFamily) — the auto_provision cohort is exactly "needs setup".
  source              text not null default 'wizard'
                        check (source in ('wizard','auto_provision','import','admin')),
  steps_completed     text[] not null default '{}',
  -- value step (T1): did they bring in a calendar, and what payoff did we show?
  value_engaged       boolean not null default false,
  import_source       text,
  events_imported     integer not null default 0,
  time_saved_minutes  integer not null default 0,
  -- marketing profile — first-class columns so segments/automations can target
  -- without parsing JSON. Mirrors family_onboarding but survives the wizard-skip.
  goals               text[] not null default '{}',
  referral_source     text,
  household_adults    integer,
  household_children  integer,
  members_added       integer not null default 0,
  members_invited     integer not null default 0,
  has_pin             boolean not null default false,
  marketing_opt_in    boolean not null default true,
  -- 0..100 completeness score at last write (computed by lib/onboarding/completeness).
  completeness        integer not null default 0,
  completed_at        timestamptz,
  reset_at            timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id)
);

create index if not exists idx_onboarding_progress_status on public.onboarding_progress(status);
create index if not exists idx_onboarding_progress_source on public.onboarding_progress(source);
create index if not exists idx_onboarding_progress_family on public.onboarding_progress(family_id);
create index if not exists idx_onboarding_progress_completed on public.onboarding_progress(completed_at desc);

-- keep updated_at fresh (same trigger fn every table uses).
drop trigger if exists set_onboarding_progress_updated_at on public.onboarding_progress;
create trigger set_onboarding_progress_updated_at
  before update on public.onboarding_progress
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.onboarding_progress enable row level security;

-- A user manages only their own onboarding record. Marketing aggregation across
-- accounts is service-role only (mirrors onboarding_events / activation_events).
drop policy if exists onboarding_progress_select on public.onboarding_progress;
create policy onboarding_progress_select on public.onboarding_progress
  for select using (user_id = auth.uid());

drop policy if exists onboarding_progress_insert on public.onboarding_progress;
create policy onboarding_progress_insert on public.onboarding_progress
  for insert with check (user_id = auth.uid());

drop policy if exists onboarding_progress_update on public.onboarding_progress;
create policy onboarding_progress_update on public.onboarding_progress
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

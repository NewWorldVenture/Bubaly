-- Bubaly :: 0173 — AI Concierge Calls (outbound: "Bubaly calls for you")
--
-- The competitive gap no family app fills: the AI places phone calls ON BEHALF
-- of the family — booking a dentist, rescheduling a haircut, confirming a
-- reservation, chasing a refund — instead of only reminding the family to do it.
-- (The AI Front Desk / Call Guardian handle INBOUND; this is the OUTBOUND half.)
--
-- One row per requested call: the task, who to call, the goal + constraints, an
-- AI-generated call brief (opening, talking points, questions, success criteria,
-- fallback), a lifecycle status, and — once placed — the outcome + transcript
-- summary. The actual telephony is provider-gated (Twilio, etc.); until a key is
-- configured a request simply parks in 'queued' and the brief is still generated,
-- so the whole experience is usable and testable without a phone provider.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.concierge_calls (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  requested_by       uuid references public.family_members(id) on delete set null,
  -- what the AI should accomplish on the call.
  task_kind          text not null default 'inquire'
                       check (task_kind in ('book','reschedule','cancel','confirm','inquire','follow_up','other')),
  callee_name        text not null,
  callee_phone       text,
  callee_category    text not null default 'other'
                       check (callee_category in ('medical','dental','school','restaurant','service','utility','retail','government','other')),
  goal               text not null,
  -- structured constraints the AI must honor (preferred dates/times, names,
  -- reference numbers, budget, do-not-agree-to, etc.).
  details            jsonb not null default '{}'::jsonb,
  -- AI-generated call plan (opening / key_points / questions / success / fallback).
  brief              jsonb not null default '{}'::jsonb,
  status             text not null default 'draft'
                       check (status in ('draft','queued','calling','completed','failed','action_needed','cancelled')),
  priority           text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  scheduled_for      timestamptz,
  -- filled once the call runs.
  outcome            text,
  transcript_summary text,
  duration_seconds   integer,
  attempts           integer not null default 0,
  provider_ref       text,               -- external call/session id (Twilio etc.)
  completed_at       timestamptz,
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_concierge_calls_family on public.concierge_calls(family_id, created_at desc);
create index if not exists idx_concierge_calls_status on public.concierge_calls(status);
create index if not exists idx_concierge_calls_scheduled on public.concierge_calls(scheduled_for)
  where scheduled_for is not null;

drop trigger if exists set_concierge_calls_updated_at on public.concierge_calls;
create trigger set_concierge_calls_updated_at
  before update on public.concierge_calls
  for each row execute function public.set_updated_at();

alter table public.concierge_calls enable row level security;

drop policy if exists concierge_calls_select on public.concierge_calls;
create policy concierge_calls_select on public.concierge_calls
  for select using (public.is_family_member(family_id));

drop policy if exists concierge_calls_insert on public.concierge_calls;
create policy concierge_calls_insert on public.concierge_calls
  for insert with check (public.is_family_member(family_id));

drop policy if exists concierge_calls_update on public.concierge_calls;
create policy concierge_calls_update on public.concierge_calls
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

drop policy if exists concierge_calls_delete on public.concierge_calls;
create policy concierge_calls_delete on public.concierge_calls
  for delete using (public.is_family_member(family_id));

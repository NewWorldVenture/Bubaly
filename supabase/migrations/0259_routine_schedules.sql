-- ============================================================================
-- 0259_routine_schedules.sql — "every Sunday, plan our meals" becomes a row a
-- worker can fire, exactly once per occurrence (§19, §58).
-- ----------------------------------------------------------------------------
-- `family_automation_rules` (0022) knows a trigger TYPE and a jsonb config,
-- which was enough when a rule fired from an event. A routine is different:
-- it fires from a CLOCK, and a clock needs three things this table lacks.
--
--   schedule_kind   'cron' — a wall-clock repeat ("every Sunday at 5pm"), or
--                   'relative' — anchored to rows that MOVE ("two days before
--                   every trip"). The second is the reason this is not just a
--                   cron column: when the trip is rescheduled the fire moves
--                   with it, which is the whole difference between a routine
--                   and a calendar entry.
--   schedule_expr / anchor_key / offset_days / at_hour
--                   the parsed schedule (`lib/services/routines/schedule.ts`).
--                   `anchor_key` is a KEY into a code-side allow-list, never a
--                   table name from a family's sentence.
--   next_run_at     when the worker should look at it next. Indexed, because
--                   "which routines are due?" is the only query the cron makes.
--   said            what the family typed, so the UI shows their words back.
--
-- `routine_runs` is the fire guard. A worker that claims a rule, dies, and is
-- retried must not run the same occurrence twice, so the occurrence itself —
-- (rule, the instant it was due) — is the unique key. Reserving a row IS the
-- claim; there is no lease to expire and no "did I already do this?" to guess.
--
-- A routine files an ai_request and nothing more: `request_id` records which.
-- Execution stays behind the same trust gate and the same family_ai_settings
-- as anything a person asks for — a schedule is permission to ASK on a
-- cadence, never permission to act unreviewed.
--
-- ADDITIVE + IDEMPOTENT. Existing rules keep firing from their triggers:
-- `schedule_kind` is null for them and the worker only looks at rows that have
-- one. Safe to re-run.
-- ============================================================================

alter table public.family_automation_rules add column if not exists schedule_kind text;
alter table public.family_automation_rules add column if not exists schedule_expr text;
alter table public.family_automation_rules add column if not exists anchor_key text;
alter table public.family_automation_rules add column if not exists offset_days integer;
alter table public.family_automation_rules add column if not exists at_hour smallint;
alter table public.family_automation_rules add column if not exists next_run_at timestamptz;
alter table public.family_automation_rules add column if not exists said text;
alter table public.family_automation_rules add column if not exists source_request_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'family_automation_rules_schedule_kind_check' and conrelid = 'public.family_automation_rules'::regclass) then
    alter table public.family_automation_rules
      add constraint family_automation_rules_schedule_kind_check
      check (schedule_kind is null or schedule_kind in ('cron', 'relative'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'family_automation_rules_at_hour_check' and conrelid = 'public.family_automation_rules'::regclass) then
    alter table public.family_automation_rules
      add constraint family_automation_rules_at_hour_check
      check (at_hour is null or at_hour between 0 and 23);
  end if;
  -- A schedule must be complete enough to fire: a cron needs an expression, a
  -- relative rule needs an anchor and an offset. A half-written schedule that
  -- silently never fires is worse than a rejected one.
  if not exists (select 1 from pg_constraint where conname = 'family_automation_rules_schedule_shape_check' and conrelid = 'public.family_automation_rules'::regclass) then
    alter table public.family_automation_rules
      add constraint family_automation_rules_schedule_shape_check
      check (
        schedule_kind is null
        or (schedule_kind = 'cron' and schedule_expr is not null)
        or (schedule_kind = 'relative' and anchor_key is not null and offset_days is not null)
      );
  end if;
end $$;

-- The only query the worker makes.
create index if not exists idx_family_automation_rules_due
  on public.family_automation_rules (next_run_at)
  where schedule_kind is not null and is_enabled and next_run_at is not null;

-- ─── The fire guard ─────────────────────────────────────────────────────────
create table if not exists public.routine_runs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  rule_id     uuid not null references public.family_automation_rules(id) on delete cascade,
  /** The instant this occurrence was DUE — not when the worker got to it. */
  due_at      timestamptz not null,
  request_id  uuid references public.ai_requests(id) on delete set null,
  status      text not null default 'filed' check (status in ('filed', 'skipped', 'failed')),
  detail      text,
  created_at  timestamptz not null default now()
);

-- Reserving this row IS the claim: two workers racing on the same occurrence,
-- and the loser's insert is refused rather than filing a second request.
create unique index if not exists uq_routine_runs_occurrence
  on public.routine_runs (rule_id, due_at);
create index if not exists idx_routine_runs_family on public.routine_runs (family_id, created_at desc);

alter table public.routine_runs enable row level security;

drop policy if exists routine_runs_select on public.routine_runs;
create policy routine_runs_select on public.routine_runs
  for select to authenticated using (public.is_family_member(family_id));
-- No client INSERT/UPDATE/DELETE policy at all: only the worker (service role)
-- writes here, and a member who could forge a row could silence a routine by
-- claiming its occurrence first.

-- Production verification:
--   select count(*) from public.family_automation_rules where schedule_kind is not null;
--   select indexname from pg_indexes where indexname in ('uq_routine_runs_occurrence','idx_family_automation_rules_due');
--   select polname, cmd from pg_policies where tablename = 'routine_runs';

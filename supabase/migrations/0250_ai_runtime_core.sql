-- ════════════════════════════════════════════════════════════════════════════
-- 0250 — AI runtime core (backlog P1-01, spec §3/§10/§30/§33/§40/§41/§42/§55).
--
-- This is the persistence spine for the Family OS concierge: a member's request
-- becomes a plan, the plan becomes ordered steps, a run executes them across
-- several serverless invocations, and every transition and tool invocation is
-- recorded so the UI can show "what Bubaly is doing" and an auditor can see who
-- did what.
--
--   ai_requests         — one row per thing a person (or a routine/trigger)
--                         asked for; doubles as the per-family AI usage meter.
--   ai_request_context  — the raw context slice for a request, split out so a
--                         child's client can never read a parent's finance or
--                         document context (§2 privacy rule).
--   ai_plans            — an LLM execution plan (versioned) for one request.
--   ai_plan_steps       — the dependency graph the executor walks.
--   ai_run_events       — append-only timeline (§17 run detail, §33 telemetry).
--   ai_tool_calls       — per-invocation audit AND the §30 duplicate guard.
--   family_automation_runs (0022) — EXTENDED into the run/continuation queue
--                         rather than adding a second "runs" table.
--
-- WRITE-SIDE RULE (docs/agents/DECISIONS.md; precedents 0217/0218/0220/0237):
-- the executor-written ledgers get SELECT for members and **no authenticated
-- INSERT/UPDATE/DELETE policy at all**. Every write goes through
-- createServiceClient() in server code that filters by family_id. That closes
-- two real attacks: step injection (a teen inserting a `finances.updateBudget`
-- step into a parent's run so the executor performs it with the run's
-- authority) and audit forgery (fabricated `run_completed` / tool-call rows
-- feeding the "Completed by Bubaly" surface and the time-saved metric).
-- ai_requests is the one exception: a member must be able to file a request, so
-- it keeps an INSERT policy pinned to their own family and their own auth uid —
-- but not UPDATE, because every status/token/latency field on it is executor
-- bookkeeping.
--
-- Additive + idempotent. No column is dropped, no existing policy on an
-- existing table is removed here (the trust/approval lockdowns are 0251).
-- ════════════════════════════════════════════════════════════════════════════

-- ─── ai_requests ────────────────────────────────────────────────────────────
-- `status` carries the §10 lifecycle for the REQUEST (the run has its own).
-- prompt/completion tokens + latency are recorded per request so §33 usage and
-- §34 allowance reporting read one table instead of scraping provider logs.
create table if not exists public.ai_requests (
  id                     uuid primary key default gen_random_uuid(),
  family_id              uuid not null references public.families(id) on delete cascade,
  conversation_id        uuid references public.ai_conversations(id) on delete set null,
  requested_by           uuid references auth.users(id) on delete set null,
  requested_by_member_id uuid references public.family_members(id) on delete set null,
  kind                   text not null default 'concierge'
                           check (kind in ('concierge','feature','routine','trigger','handle_it')),
  feature                text,                                  -- e.g. 'insights:meals' for kind='feature'
  request_text           text not null default '',
  interpreted_intent     text,
  intent_confidence      numeric(4,3) check (intent_confidence is null or (intent_confidence >= 0 and intent_confidence <= 1)),
  status                 text not null default 'queued'
                           check (status in ('queued','planning','awaiting_context','awaiting_approval','ready',
                                             'executing','verifying','scheduled_followup','completed',
                                             'partially_completed','blocked','failed','cancelled')),
  priority               smallint not null default 0,
  context_stats          jsonb not null default '{}'::jsonb,    -- counts/chars only — never the context text
  clarifications         jsonb not null default '[]'::jsonb,    -- [{question, answer, at}]
  model                  text,
  prompt_tokens          integer,
  completion_tokens      integer,
  latency_ms             integer,
  error                  text,
  source_rule_id         uuid references public.family_automation_rules(id) on delete set null,
  started_at             timestamptz,
  completed_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists idx_ai_requests_family_created on public.ai_requests (family_id, created_at desc);
create index if not exists idx_ai_requests_family_status on public.ai_requests (family_id, status);
create index if not exists idx_ai_requests_conversation on public.ai_requests (conversation_id, created_at desc);
-- Monthly allowance / usage rollups group by kind within a family window.
create index if not exists idx_ai_requests_family_kind_created on public.ai_requests (family_id, kind, created_at desc);

-- ─── ai_request_context ─────────────────────────────────────────────────────
-- One row per request holding the assembled context slice. Kept out of
-- ai_requests because the snapshot can contain finance rows, document text and
-- other members' medical detail: readable only by the requester themselves or a
-- family manager, while ai_requests stays readable by the whole family so the
-- activity timeline works.
create table if not exists public.ai_request_context (
  request_id        uuid primary key references public.ai_requests(id) on delete cascade,
  family_id         uuid not null references public.families(id) on delete cascade,
  snapshot          jsonb not null default '{}'::jsonb,
  sensitive_omitted text[] not null default '{}',               -- slice names withheld by policy
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_ai_request_context_family on public.ai_request_context (family_id, created_at desc);

-- ─── ai_plans ───────────────────────────────────────────────────────────────
-- Versioned: editing a step (§13 "Edit" on an approval) supersedes version N
-- and writes N+1 rather than mutating history the family already reviewed.
create table if not exists public.ai_plans (
  id                    uuid primary key default gen_random_uuid(),
  family_id             uuid not null references public.families(id) on delete cascade,
  request_id            uuid references public.ai_requests(id) on delete cascade,
  version               integer not null default 1,
  objective             text,
  reasoning_summary     text,                                   -- the short "why", never raw chain-of-thought
  status                text not null default 'draft'
                          check (status in ('draft','approved','executing','completed','partially_completed','failed','cancelled','superseded')),
  risk_level            text not null default 'low' check (risk_level in ('low','medium','high')),
  estimated_actions     integer not null default 0,
  requires_approval     boolean not null default false,
  planner_model         text,
  planner_prompt_version text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists uq_ai_plans_request_version on public.ai_plans (request_id, version) where request_id is not null;
create index if not exists idx_ai_plans_family_status on public.ai_plans (family_id, status);
create index if not exists idx_ai_plans_family_created on public.ai_plans (family_id, created_at desc);

-- ─── ai_plan_steps ──────────────────────────────────────────────────────────
-- `dependency_ids` holds sibling step ids; the executor runs a step when all of
-- its dependencies are completed or skipped. `condition` is evaluated at
-- scheduling time (e.g. {"path":"$.dep.<key>.international","eq":true}) and a
-- false result marks the step 'skipped' instead of failing the run.
-- `result_json` is deliberately REDACTED — {summary, resource_table,
-- resource_ids, card} — so a family-readable table never mirrors raw rows the
-- reader would not otherwise be allowed to see.
create table if not exists public.ai_plan_steps (
  id               uuid primary key default gen_random_uuid(),
  family_id        uuid not null references public.families(id) on delete cascade,
  plan_id          uuid not null references public.ai_plans(id) on delete cascade,
  parent_step_id   uuid references public.ai_plan_steps(id) on delete set null,
  sequence         integer not null default 0,
  step_type        text not null default 'act'
                     check (step_type in ('retrieve','act','verify','notify','approval','followup','replan')),
  tool_name        text,
  description      text,
  input_json       jsonb not null default '{}'::jsonb,
  dependency_ids   uuid[] not null default '{}',
  condition        jsonb,
  status           text not null default 'queued'
                     check (status in ('queued','planning','awaiting_context','awaiting_approval','ready','executing',
                                       'verifying','scheduled_followup','completed','partially_completed','blocked',
                                       'failed','cancelled','skipped')),
  approval_required boolean not null default false,
  approval_id      uuid references public.approval_requests(id) on delete set null,
  risk_level       text not null default 'low' check (risk_level in ('low','medium','high')),
  retry_count      integer not null default 0,
  max_retries      integer not null default 2,
  result_json      jsonb,
  error            text,
  started_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index if not exists uq_ai_plan_steps_plan_sequence on public.ai_plan_steps (plan_id, sequence);
create index if not exists idx_ai_plan_steps_plan_status on public.ai_plan_steps (plan_id, status);
create index if not exists idx_ai_plan_steps_family_status on public.ai_plan_steps (family_id, status);
create index if not exists idx_ai_plan_steps_approval on public.ai_plan_steps (approval_id) where approval_id is not null;

-- ─── family_automation_runs → the run + continuation queue ──────────────────
-- 0022 shipped this table with a free-text `status` ('pending' | 'approved' |
-- 'executed' | 'skipped' | 'failed') and three live readers:
--   app/(app)/dashboard/concierge/actions.ts        (writes 'pending'/'executed'/'dismissed')
--   app/(app)/dashboard/autonomous-family-management + /family-automation pages
--   components/concierge/autopilot-panel.tsx       (filters status='pending'/'executed')
-- Rewriting `status` in place would break all of them mid-flight, so the §10
-- lifecycle lands in a NEW constrained column `state` and `status` keeps its
-- legacy vocabulary untouched (and unconstrained — no CHECK is added to it).
-- Display mapping for the legacy values, implemented in lib/ai/runs/states.ts:
--   pending   → awaiting_approval
--   approved  → ready
--   executed  → completed
--   skipped   → cancelled
--   dismissed → cancelled
--   failed    → failed
-- Rows written by the old paths simply keep state='queued' (the default) and
-- are never claimed by the executor, because claim_ai_runs only looks at
-- 'ready' / 'scheduled_followup' / stale 'executing'.
--
-- Lease columns follow the sync_jobs / marketing_generation_jobs shape but add
-- an owner token: a claim stamps lease_owner + lease_expires_at, and the worker
-- extends its own lease with an UPDATE guarded by that token, so a slow
-- invocation that comes back to life after recovery cannot clobber the run the
-- next worker already owns.
do $$
begin
  alter table public.family_automation_runs
    add column if not exists request_id uuid references public.ai_requests(id) on delete set null,
    add column if not exists plan_id uuid references public.ai_plans(id) on delete set null,
    add column if not exists requested_by_member_id uuid references public.family_members(id) on delete set null,
    add column if not exists run_type text not null default 'concierge_plan',
    add column if not exists state text not null default 'queued',
    add column if not exists current_step_id uuid,
    add column if not exists progress jsonb not null default '{}'::jsonb,
    add column if not exists started_at timestamptz,
    add column if not exists completed_at timestamptz,
    add column if not exists error text,
    add column if not exists cancel_requested_at timestamptz,
    add column if not exists paused_at timestamptz,
    add column if not exists run_after timestamptz not null default now(),
    add column if not exists lease_owner uuid,
    add column if not exists lease_expires_at timestamptz,
    add column if not exists attempt integer not null default 0,
    add column if not exists max_attempts integer not null default 5,
    add column if not exists idempotency_key text;
end $$;

-- current_step_id points at ai_plan_steps, which is created above; adding the FK
-- separately keeps the ALTER above a pure add-column list.
do $$
begin
  alter table public.family_automation_runs
    add constraint family_automation_runs_current_step_fk
    foreign key (current_step_id) references public.ai_plan_steps(id) on delete set null;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.family_automation_runs
    add constraint family_automation_runs_run_type_check
    check (run_type in ('concierge','routine','trigger','handle_it','concierge_plan'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.family_automation_runs
    add constraint family_automation_runs_state_check
    check (state in ('queued','planning','awaiting_context','awaiting_approval','ready','executing','verifying',
                     'scheduled_followup','completed','partially_completed','blocked','failed','cancelled','paused'));
exception when duplicate_object then null;
end $$;

-- §30 run-level dedupe: a routine firing twice for the same day, or a retried
-- POST, upserts on this key instead of starting a second run.
create unique index if not exists uq_family_automation_runs_idempotency
  on public.family_automation_runs (family_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_family_automation_runs_family_state
  on public.family_automation_runs (family_id, state, created_at desc);
-- The claim predicate: the partial index keeps the queue scan proportional to
-- the number of runnable runs, not to the whole run history.
create index if not exists idx_family_automation_runs_claim
  on public.family_automation_runs (run_after, created_at)
  where state in ('ready','executing','scheduled_followup');
create index if not exists idx_family_automation_runs_request on public.family_automation_runs (request_id) where request_id is not null;
create index if not exists idx_family_automation_runs_plan on public.family_automation_runs (plan_id) where plan_id is not null;

-- ─── ai_run_events ──────────────────────────────────────────────────────────
-- Append-only timeline. `model_call` payloads are limited to
-- {task, model, prompt_version, prompt_tokens, completion_tokens, latency_ms}:
-- prompt and context text must never land in a family-readable table.
create table if not exists public.ai_run_events (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  run_id          uuid not null references public.family_automation_runs(id) on delete cascade,
  request_id      uuid references public.ai_requests(id) on delete set null,
  step_id         uuid references public.ai_plan_steps(id) on delete set null,
  event_type      text not null
                    check (event_type in ('run_started','planned','step_started','step_completed','step_failed',
                                          'step_retried','step_skipped','approval_requested','approval_decided',
                                          'clarification_asked','clarification_answered','verified','verification_failed',
                                          'model_call','notified','paused','resumed','blocked','cancelled',
                                          'run_completed','run_failed','followup_scheduled')),
  tool_name       text,
  message         text not null default '',
  payload         jsonb not null default '{}'::jsonb,
  actor_kind      text not null default 'ai' check (actor_kind in ('ai','member','system')),
  actor_member_id uuid references public.family_members(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_ai_run_events_run on public.ai_run_events (run_id, created_at);
create index if not exists idx_ai_run_events_family_created on public.ai_run_events (family_id, created_at desc);
create index if not exists idx_ai_run_events_step on public.ai_run_events (step_id) where step_id is not null;

-- ─── ai_tool_calls ──────────────────────────────────────────────────────────
-- Both the per-invocation audit (§6/§33) and the §30 duplicate guard.
-- Key composition (lib/ai/tools/execute.ts):
--   executor calls   sha256(family, run, step, tool, normalizedArgs)
--   chat-origin calls sha256(family, conversation, message_id, tool, normalizedArgs)
-- so "add milk" typed again on a later turn is a new key and executes again,
-- while a retried step or a double-submitted request is not.
-- Conflict semantics on the unique key: 'succeeded' ⇒ return the prior
-- resource_id; 'failed' ⇒ take the row over (attempt+1, state='reserved') and
-- re-execute; 'reserved' with locked_at older than 2 minutes ⇒ take over;
-- otherwise report in-progress.
create table if not exists public.ai_tool_calls (
  id                     uuid primary key default gen_random_uuid(),
  family_id              uuid not null references public.families(id) on delete cascade,
  run_id                 uuid references public.family_automation_runs(id) on delete set null,
  plan_step_id           uuid references public.ai_plan_steps(id) on delete set null,
  request_id             uuid references public.ai_requests(id) on delete set null,
  conversation_id        uuid references public.ai_conversations(id) on delete set null,
  message_id             uuid references public.ai_messages(id) on delete set null,
  tool_name              text not null,
  requested_by           uuid references auth.users(id) on delete set null,
  requested_by_member_id uuid references public.family_members(id) on delete set null,
  actor_kind             text not null default 'ai' check (actor_kind in ('ai','member','system')),
  inputs                 jsonb not null default '{}'::jsonb,
  outputs                jsonb,
  state                  text not null default 'reserved' check (state in ('reserved','succeeded','failed')),
  attempt                integer not null default 1,
  locked_at              timestamptz,
  duration_ms            integer,
  error                  text,
  idempotency_key        text not null,
  resource_table         text,
  resource_id            uuid,
  finished_at            timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
-- The duplicate guard itself. Written as a partial index (the predicate is
-- always true today because the column is NOT NULL) so the guard's intent —
-- "a key, when present, is unique within the family" — survives any future
-- relaxation of the column.
create unique index if not exists uq_ai_tool_calls_idempotency
  on public.ai_tool_calls (family_id, idempotency_key) where idempotency_key is not null;
create index if not exists idx_ai_tool_calls_run on public.ai_tool_calls (run_id) where run_id is not null;
create index if not exists idx_ai_tool_calls_family_tool on public.ai_tool_calls (family_id, tool_name, created_at desc);
create index if not exists idx_ai_tool_calls_step on public.ai_tool_calls (plan_step_id) where plan_step_id is not null;

-- ─── ai_conversations / ai_messages extensions ──────────────────────────────
-- 0002 defaulted `provider` to 'anthropic', but every live path is OpenAI via
-- lib/ai/provider.ts; the default is corrected and existing GPT rows are
-- relabelled so the concierge can group a family's conversations by provider.
alter table public.ai_conversations
  add column if not exists state text not null default 'open',
  add column if not exists prompt_version text;

do $$
begin
  alter table public.ai_conversations
    add constraint ai_conversations_state_check check (state in ('open','archived'));
exception when duplicate_object then null;
end $$;

alter table public.ai_conversations alter column provider set default 'openai';
update public.ai_conversations set provider = 'openai' where provider <> 'openai' and model like 'gpt%';
create index if not exists idx_ai_conversations_family_user_updated
  on public.ai_conversations (family_id, user_id, updated_at desc);

alter table public.ai_messages
  add column if not exists structured_content jsonb,   -- result cards (§16) rendered from the message
  add column if not exists model text,
  add column if not exists usage jsonb,                -- {inputTokens, outputTokens, totalTokens}
  add column if not exists request_id uuid references public.ai_requests(id) on delete set null,
  add column if not exists sender_member_id uuid references public.family_members(id) on delete set null;
create index if not exists idx_ai_messages_request on public.ai_messages (request_id) where request_id is not null;

-- ─── updated_at triggers ────────────────────────────────────────────────────
do $$
declare t text;
declare tbls text[] := array['ai_requests','ai_request_context','ai_plans','ai_plan_steps','ai_run_events','ai_tool_calls'];
begin
  foreach t in array tbls loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$I', t);
    execute format('create trigger trg_%1$s_updated_at before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- Members read their family's AI activity; nobody signed in as `authenticated`
-- can write the executor ledgers (see the header). ai_requests keeps a narrow
-- INSERT so filing a request works from the browser and the mobile app.
alter table public.ai_requests enable row level security;
drop policy if exists ai_requests_select on public.ai_requests;
drop policy if exists ai_requests_insert on public.ai_requests;
create policy ai_requests_select on public.ai_requests
  for select to authenticated using (public.is_family_member(family_id));
create policy ai_requests_insert on public.ai_requests
  for insert to authenticated
  with check (public.is_family_member(family_id) and requested_by = auth.uid());

-- Context snapshots: the requester or a manager only. A child must never be
-- able to read the finance/document slice assembled for a parent's request.
alter table public.ai_request_context enable row level security;
drop policy if exists ai_request_context_select on public.ai_request_context;
create policy ai_request_context_select on public.ai_request_context
  for select to authenticated using (
    public.can_manage_family(family_id)
    or exists (
      select 1 from public.ai_requests r
      where r.id = ai_request_context.request_id and r.requested_by = auth.uid()
    )
  );

alter table public.ai_plans enable row level security;
drop policy if exists ai_plans_select on public.ai_plans;
create policy ai_plans_select on public.ai_plans
  for select to authenticated using (public.is_family_member(family_id));

alter table public.ai_plan_steps enable row level security;
drop policy if exists ai_plan_steps_select on public.ai_plan_steps;
create policy ai_plan_steps_select on public.ai_plan_steps
  for select to authenticated using (public.is_family_member(family_id));

alter table public.ai_run_events enable row level security;
drop policy if exists ai_run_events_select on public.ai_run_events;
create policy ai_run_events_select on public.ai_run_events
  for select to authenticated using (public.is_family_member(family_id));

-- inputs/outputs can hold finance rows, document text or another member's
-- medical detail, so this ledger is narrower than the rest: the caller who made
-- the call, or a manager.
alter table public.ai_tool_calls enable row level security;
drop policy if exists ai_tool_calls_select on public.ai_tool_calls;
create policy ai_tool_calls_select on public.ai_tool_calls
  for select to authenticated using (
    requested_by = auth.uid() or public.can_manage_family(family_id)
  );

-- ─── claim_ai_runs — the executor's lease ───────────────────────────────────
-- Several cron invocations (Vercel + the GitHub Actions dispatcher) can overlap,
-- and a single invocation can time out mid-run. `for update skip locked` makes
-- the claim atomic: two concurrent callers can never receive the same run id.
--
-- Pass 1 recovers runs whose worker died — state 'executing' with an expired
-- lease — back to 'ready', or to 'failed' once attempt >= max_attempts (the
-- dead-letter equivalent). 'awaiting_approval', 'paused' and 'blocked' are
-- never recovered: they are waiting on a human, not on a worker.
-- Pass 2 leases the due runs and returns their ids; the caller then loads each
-- run with the service client and executes it.
create or replace function public.claim_ai_runs(p_limit integer default 10, p_lease_seconds integer default 120)
returns setof uuid
language plpgsql security definer set search_path = public as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_lease integer := greatest(30, least(coalesce(p_lease_seconds, 120), 900));
begin
  update public.family_automation_runs
  set state = case when attempt >= max_attempts then 'failed' else 'ready' end,
      error = case when attempt >= max_attempts
                   then coalesce(error, 'Run abandoned after the maximum number of attempts.')
                   else error end,
      completed_at = case when attempt >= max_attempts then now() else completed_at end,
      lease_owner = null,
      lease_expires_at = null,
      run_after = now(),
      updated_at = now()
  where state = 'executing'
    and lease_expires_at is not null
    and lease_expires_at < now();

  return query
  with candidates as (
    select id
    from public.family_automation_runs
    where state in ('ready','scheduled_followup')
      and run_after <= now()
      and (lease_expires_at is null or lease_expires_at < now())
      and cancel_requested_at is null
    order by run_after, created_at
    for update skip locked
    limit v_limit
  )
  update public.family_automation_runs r
  set state = 'executing',
      attempt = r.attempt + 1,
      lease_owner = gen_random_uuid(),
      lease_expires_at = now() + make_interval(secs => v_lease),
      started_at = coalesce(r.started_at, now()),
      updated_at = now()
  from candidates c
  where r.id = c.id
  returning r.id;
end;
$$;
revoke all on function public.claim_ai_runs(integer, integer) from public;
grant execute on function public.claim_ai_runs(integer, integer) to service_role;

-- ─── Realtime ───────────────────────────────────────────────────────────────
-- The run detail timeline subscribes to ai_run_events, the "Working on"
-- card to ai_plan_steps, and the run header to family_automation_runs.
do $$
declare t text;
declare tbls text[] := array['ai_run_events','ai_plan_steps','family_automation_runs'];
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach t in array tbls loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Production verification (run after `supabase db push`):
--   select to_regclass('public.ai_requests'), to_regclass('public.ai_plans'),
--          to_regclass('public.ai_plan_steps'), to_regclass('public.ai_run_events'),
--          to_regclass('public.ai_tool_calls'), to_regclass('public.ai_request_context');
--   select polname, cmd from pg_policies where tablename in
--     ('ai_requests','ai_plans','ai_plan_steps','ai_run_events','ai_tool_calls','ai_request_context');
--   select has_function_privilege('service_role', 'public.claim_ai_runs(integer,integer)', 'EXECUTE');

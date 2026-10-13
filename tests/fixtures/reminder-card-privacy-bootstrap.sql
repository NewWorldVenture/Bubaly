\set ON_ERROR_STOP on
do $$ begin if current_database()<>'privacy_runtime' or current_setting('server_version_num')::integer not between 170000 and 179999 or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public'and c.relkind='r') then raise exception 'Refuse nonempty/unowned privacy database';end if;end $$;
-- Current raw block docs/audit/pg-bootstrap.sh SHA256 4aa56049832d367afd3bd0505837385d3c2524c9ffaa9bcfb9caf9692c7594af
create schema if not exists auth;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 28124fdf35a043044f5641f6e3092ae8c54f31a70776e401a90a904cd8852340
create schema if not exists storage;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 c60b5a44809e05efea1164c61d08f4fcc092391a1b1135f566944401dbf2f2dc
create schema if not exists extensions;
-- Match the current repository and Supabase pgcrypto namespace; no public alias.
create extension if not exists "pgcrypto" with schema extensions;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 99670396ed142501fba3eac92c905a603f7a4c7d6a7afe749f0fc4b31adf79da
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 54513dcde8db78da29ba3ccf4f6f39e120f56115de573b737d8fb829885f493e
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 e68e3f77880a9ffe96a49bc2a38e3a553302d4805a9c8a3ed112bcd3fde2b11e
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 67de7029210b8914ee776153ee7d8e8d9b4e7c49335eed4dfe990c8600e775ee
do $$ begin create role authenticator noinherit login password 'x'; exception when duplicate_object then null; end $$;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 523d7c0b9712ef0c83d4c7e0279d829ae516d3d26da1097e501381077fbf6669
grant anon, authenticated, service_role to authenticator;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 4aa87011c9e70897718466f38f995dd9067bef3207cf975a5b0e020e2556b958
grant usage on schema auth, storage, extensions, public to anon, authenticated, service_role;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 48df8351d4da3ae0fdda7a73b7f1fe4dae8bffc32ae1c9ece8baf6c5b90e4f4e
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 5a29aebb6ac145c4f36f0624477284f6c91c9cf99e57dce60fee8fba3d4146c8
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 534e02f5c28c939ab312ab3c6ac97110bff10a790a60c17f9ed609ec347181cb
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, phone text,
  raw_user_meta_data jsonb default '{}', raw_app_meta_data jsonb default '{}', created_at timestamptz default now());

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 73beb9db202b06de572825b74748d1591e414a0396a38db2bb5b2d3cd2f5d815
create or replace function auth.uid() returns uuid language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $f$;

-- Current raw block docs/audit/pg-bootstrap.sh SHA256 9128cd9f4c4e0abce959aed72341dbdfa5fd75c51da2ca7b6095644030d4c68b
create or replace function auth.role() returns text language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text $f$;

-- Current raw block supabase/migrations/0001_extensions_enums.sql SHA256 03334b822887b61edba67a79529df9379234f73da262eaad051cb2592f98617d
do $$ begin
  create type public.member_role as enum
    ('parent','adult','teen','child','caregiver','guest');
exception when duplicate_object then null; end $$;

-- Current raw block supabase/migrations/0002_tables.sql SHA256 6c7f9c542149870e3a2004c315531c985a1d55223ee4b0fe1e96cee344c5e1a9
create table if not exists public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  avatar_url  text,
  timezone    text not null default 'UTC',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Current raw block supabase/migrations/0002_tables.sql SHA256 5250e1e35ddfdd06e6c1f750802ee93a0683aa6d9fedb9b6c347d5f86f67eb89
create table if not exists public.family_members (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete cascade, -- null = managed child profile w/o login
  role         public.member_role not null default 'adult',
  display_name text not null,
  color        text default '#6366f1',
  birthday     date,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (family_id, user_id)
);

-- Current raw block supabase/migrations/0003_functions_triggers.sql SHA256 addd0cfe2dd7f5c54bbeda898d3c67b6933ce562f6166a567a39bb9e8b3019f1
create or replace function public.is_family_member(p_family_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid() and is_active
  );
$$;

-- Current raw block supabase/migrations/0003_functions_triggers.sql SHA256 cf800845723fb18b6b5185e4bd3939ac2d3ade8485dd48af79cfa149919d4757
create or replace function public.family_role(p_family_id uuid)
returns public.member_role language sql security definer stable set search_path = public as $$
  select role from public.family_members
  where family_id = p_family_id and user_id = auth.uid()
  order by case role when 'parent' then 0 when 'adult' then 1 else 2 end
  limit 1;
$$;

-- Current raw block supabase/migrations/0003_functions_triggers.sql SHA256 a06ed1fd68981cfe1a962a232b3854236d65f08fed849acfebdd749f1df4238b
create or replace function public.can_manage_family(p_family_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid()
      and role in ('parent','adult') and is_active
  );
$$;

-- Current raw block supabase/migrations/0003_functions_triggers.sql SHA256 d69b0c631bbb322576ea4194d2bd9233ed0977649a74fcb81268dcef73e62715
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

-- Current raw block supabase/migrations/0118_rls_drift_repair.sql SHA256 2654999067dd88bb1a7cd532596c858f7b0e65364cce3f9bd279e46bf1bd963f
drop policy if exists families_select on public.families;
create policy families_select on public.families for select
  using (public.is_family_member(id));


-- Current raw block supabase/migrations/0118_rls_drift_repair.sql SHA256 1b48c53bd559eae617b439675f4241354b763d6be6539dfb0ef75ec9c073b170
drop policy if exists fm_select on public.family_members;
create policy fm_select on public.family_members for select
  using (public.is_family_member(family_id));


-- Current raw block supabase/migrations/0085_autopilot.sql SHA256 9fd5883a9f48e2a6bb5c69a60157a164986a83b073f0f39cdae9bc482e04ea2e
-- ============================================================================
-- Migration 0085: Family Autopilot — the confidence-scored suggestion engine
-- ----------------------------------------------------------------------------
-- The keystone of "Bubaly Gen 2": a prediction layer that scans the family's
-- real data (groceries, documents, appointments, chores, birthdays, reminders)
-- and emits confidence-scored suggestions. Each suggestion carries a confidence
-- (0-100) that drives the autopilot tier:
--   >= 90  → auto-executed (status 'auto_executed')
--   70-89  → needs approval (status 'open', awaiting the family)
--   < 70   → ask / inform   (status 'open', lower urgency)
--
-- One family-scoped table with a stable dedupe_key so re-scans update an
-- existing suggestion instead of piling up duplicates.
-- ============================================================================

DO $$ BEGIN CREATE TYPE autopilot_status AS ENUM ('open','approved','executed','auto_executed','dismissed','snoozed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.autopilot_suggestions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES public.family_members(id) ON DELETE SET NULL, -- who it concerns
  kind          text NOT NULL,                 -- groceries | document | appointment | chore | birthday | reminder | wellbeing | finance
  title         text NOT NULL,
  detail        text,
  confidence    integer NOT NULL DEFAULT 50 CHECK (confidence BETWEEN 0 AND 100),
  urgency       integer NOT NULL DEFAULT 1 CHECK (urgency BETWEEN 1 AND 3), -- 1 low, 2 med, 3 high
  status        autopilot_status NOT NULL DEFAULT 'open',
  action_type   text,                          -- e.g. add_grocery | create_reminder | create_event | none
  action_label  text,                          -- button label, e.g. "Reorder milk"
  payload       jsonb NOT NULL DEFAULT '{}',    -- structured args for the action
  source_kind   text,                          -- table the signal came from
  source_id     uuid,                          -- row that triggered it (best-effort)
  dedupe_key    text NOT NULL,                 -- stable id so re-scans upsert
  expires_at    timestamptz,                   -- auto-irrelevant after this
  resolved_at   timestamptz,
  resolved_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_autopilot_family_status ON public.autopilot_suggestions (family_id, status, urgency DESC, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_autopilot_family_created ON public.autopilot_suggestions (family_id, created_at DESC);

-- ---- RLS + updated_at trigger (family-scoped, shared pattern) ----
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['autopilot_suggestions'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))',
      t
    );
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t
    );
  END LOOP;
END $$;

-- ============================================================================
-- Done! The Family Autopilot suggestion store.
-- ============================================================================


-- Current raw block supabase/migrations/0327_autopilot_suggestions_are_not_erasable.sql SHA256 9e2209e7cc5c49b9138c5b08fe0a287cefd645595ffc5073df8186301d09ddbe
-- Bubaly :: 0327 - the Autopilot queue: nothing erases it, and a resolution
--                  says who actually made it
--
-- `autopilot_suggestions` (0085_autopilot.sql) carries the same permissive
-- `FOR ALL TO authenticated USING (is_family_member(family_id))` as the tables
-- 0322, 0323, 0324 and 0325 narrowed, and it was recorded in the same census as
-- a table the application gates on `isManager` while RLS does not.
--
-- ── that record is wrong, and the reason is worth writing down ──────────────
--
-- The census said "no app path creates a row; only lib/autopilot/scan.ts, a
-- server pass, inserts", and concluded the table should be manager-only like
-- `guardian_suggestions`. `runAutopilotScan` is a server pass, but it is not a
-- server-ONLY pass. It has two callers:
--
--   app/api/cron/autopilot-scan/route.ts  -> createServiceClient()  (bypasses RLS)
--   app/api/autopilot/scan/route.ts       -> createServer()         (the CALLER's
--                                                                    own client)
--
-- and the second is reachable by any signed-in member of an entitled family:
-- its only gate is `resolveFeatureEntitlement(…, '/dashboard/autopilot')`,
-- which is plan-level, not role-level. `requireFeature` — the gate on the page
-- itself — is the same resolver and likewise carries no role check. The
-- Autopilot module runs that scan AUTOMATICALLY on open ("Auto-scan once when
-- the screen opens", components/modules/autopilot-module.tsx), and the scan
-- throws when an insert or a reconciliation update is refused:
--
--   throw new Error('Autopilot could not save the suggestion')          scan.ts
--   throw new Error('Autopilot could not save the policy suggestion')   policy-scan.ts
--   throw new Error('Autopilot could not archive stale suggestions')    history.ts
--
-- Resolution is the same story: `resolveAutopilotSuggestionAction`
-- (app/(app)/dashboard/autopilot/actions.ts) is gated by `requireFeature` and a
-- plan re-check, never by role, and `resolveSuggestion` updates the row on the
-- caller's client. So a manager-only INSERT or UPDATE guard here would 500 the
-- Autopilot page for every child in a Plus family, every time they opened it.
--
-- That is PROD-001's judgement applied a second time: the app and RLS agree
-- that any member may append to and resolve this queue, so there is no boundary
-- being walked around, and inventing one mid-audit would be a product decision
-- taken by the wrong person. What IS closed here is everything the application
-- never does.
--
-- ── 1. nothing in the product deletes a suggestion ─────────────────────────
--
-- Withdrawal is a status change, on purpose: `archiveStaleSuggestions` is
-- commented "Withdraw without erasing the evidence", and moves the row to
-- `status='snoozed'` with an `archived:` dedupe key so the offer can be made
-- again. Resolution stamps `executed` or `dismissed`. Acceptance stamps
-- `executed`. There is no `.delete()` on this table anywhere in app/ or lib/ —
-- only the seed files, which run as the migration role.
--
-- A child could nevertheless `delete from autopilot_suggestions` and erase the
-- record of what Bubaly proposed and what the household decided about it,
-- including the `status='dismissed'` rows that are the evidence a parent said
-- no. Measured as a child on a replayed database: DELETE 1. Closing DELETE
-- costs no flow at all, and it is the same instinct 0224 had about
-- `wallet_audit_logs`: a record whose subject can remove it records nothing.
--
-- ── 2. a resolution is signed by whoever made it ───────────────────────────
--
-- `resolved_by` had no binding, exactly as `audit_logs.actor_id` had none
-- before 0320 and `wallet_audit_logs.actor_user_id` has none before 0328. Every
-- writer in the codebase already passes its own id or nothing:
--
--   scan.ts / policy-scan.ts inserts        resolved_by: null
--   policy refresh, archive                 does not touch resolved_by
--   stamp() in lib/services/autopilot       resolved_by: scope.userId
--   acceptPolicySuggestionAction            resolved_by: ctx.user.id
--
-- so pinning it costs the honest callers nothing, and it stops a child
-- recording that a PARENT dismissed the suggestion the child dismissed —
-- /dashboard/autopilot and lib/home/completed.ts both render resolved rows back
-- to the family as the household's own decision history.
--
-- ── what is NOT closed, and must be read as a finding, not an omission ─────
--
-- A child may still INSERT a suggestion and UPDATE an existing one, because the
-- product lets them do both through /api/autopilot/scan and the resolve action.
-- That leaves AUTHZ-006's mechanism live at the application layer:
-- `acceptPolicySuggestionAction` (app/(app)/dashboard/trust/actions.ts) IS
-- manager-gated, and it reads the suggestion's own `payload` to decide which
-- `trust_policies` row to write — a table a child cannot write directly. A
-- hand-crafted `kind='policy'` row therefore chooses which tool the household's
-- AI is granted a standing allow for, and a parent clicking Accept applies it.
--
-- RLS cannot tell that row from the one `runPolicyScan` writes: both are
-- authored by the same member on the same client with the same columns. The fix
-- belongs where the trust is placed — either gate /api/autopilot/scan and the
-- resolve action on `isManager`, or have `acceptPolicySuggestionAction`
-- re-derive the proposal from `approval_requests` instead of believing the
-- stored payload. Both are product decisions and neither is this migration's to
-- take. It is recorded here so the next pass finds it stated rather than
-- inferred from the absence of a guard.
--
-- ── what does NOT change ────────────────────────────────────────────────────
-- Reads. /dashboard/autopilot, the AI proactive slice, the operating index and
-- the metric surfaces all read this table on the RLS-bound client as whoever is
-- signed in. SELECT is untouched.
--
-- `anon`'s writes go for 0290's reason: these guards are `TO authenticated` and
-- are simply absent for an anonymous request.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent.

do $$
begin
  if to_regclass('public.autopilot_suggestions') is null then
    return;
  end if;

  -- Nothing in app/ or lib/ deletes a suggestion; withdrawal is a status change.
  drop policy if exists autopilot_suggestions_no_client_delete_guard on public.autopilot_suggestions;
  create policy autopilot_suggestions_no_client_delete_guard on public.autopilot_suggestions
    as restrictive for delete to authenticated
    using (false);

  -- A resolution carries the id of whoever made it, or none at all (the scan's
  -- own inserts). This guard is about what a writer may LEAVE BEHIND, not about
  -- which rows they may reach — appending to and resolving this queue is open
  -- to every member by the product's own design, and narrowing the USING half
  -- would be the manager guard this migration explains it must not add. So the
  -- USING half restates the household check 0085's permissive policy already
  -- makes, which subtracts nothing; it is written out rather than left as
  -- `true` because docs/audit/blanket-policy-check.sql reads every policy's
  -- expression from the catalogue and cannot tell a harmless restrictive
  -- `true` from a permissive one that opens a table.
  drop policy if exists autopilot_suggestions_resolver_guard on public.autopilot_suggestions;
  create policy autopilot_suggestions_resolver_guard on public.autopilot_suggestions
    as restrictive for insert to authenticated
    with check (resolved_by is null or resolved_by = auth.uid());

  drop policy if exists autopilot_suggestions_resolver_update_guard on public.autopilot_suggestions;
  create policy autopilot_suggestions_resolver_update_guard on public.autopilot_suggestions
    as restrictive for update to authenticated
    using (public.is_family_member(family_id))
    with check (resolved_by is null or resolved_by = auth.uid());
end
$$;

revoke insert, update, delete, truncate on public.autopilot_suggestions from anon;

do $$
begin
  if to_regclass('public.autopilot_suggestions') is null then
    return;
  end if;

  if has_table_privilege('anon', 'public.autopilot_suggestions', 'INSERT') then
    raise exception '0327: anon still holds INSERT on autopilot_suggestions';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'autopilot_suggestions'
      and policyname = 'autopilot_suggestions_no_client_delete_guard'
      and permissive = 'RESTRICTIVE'
  ) then
    raise exception '0327: the delete guard on autopilot_suggestions was not created';
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'autopilot_suggestions'
      and policyname = 'autopilot_suggestions_resolver_update_guard'
      and permissive = 'RESTRICTIVE'
  ) then
    raise exception '0327: the resolver pin on autopilot_suggestions was not created';
  end if;

  raise notice '0327 OK: Autopilot suggestions cannot be erased by a client and a resolution names its own author; append and resolve stay open, as the product intends.';
end
$$;


-- Current raw block supabase/migrations/0014_core_platform.sql SHA256 239ebdeff1d89b4a47b5fb22e8ab5f7d36ed9b75c21574c3a6be10f8075a2931
create table if not exists public.family_reminders (
  id              uuid        primary key default gen_random_uuid(),
  family_id       uuid        references public.families(id) on delete cascade not null,
  created_by      uuid        references auth.users(id) on delete set null,
  assigned_to_id  uuid        references auth.users(id) on delete set null,
  member_id       uuid        references public.family_members(id) on delete set null,
  title           text        not null,
  notes           text,
  kind            text        not null default 'time' check (kind in ('time','location','recurring','medication','bill','school','chore')),
  remind_at       timestamptz,
  location_name   text,
  recurrence      text        not null default 'none' check (recurrence in ('none','daily','weekdays','weekly','biweekly','monthly','yearly')),
  recurrence_time time,
  recurrence_days int[]       default '{}',
  priority        text        not null default 'medium' check (priority in ('low','medium','high','urgent')),
  status          text        not null default 'active' check (status in ('active','snoozed','completed','dismissed')),
  completed_at    timestamptz,
  snoozed_until   timestamptz,
  ai_suggested    boolean     not null default false,
  tags            text[]      not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_family_reminders_family on public.family_reminders(family_id, status, remind_at);

alter table public.family_reminders enable row level security;
drop policy if exists "family members can manage reminders" on public.family_reminders;
create policy "family members can manage reminders"
  on public.family_reminders for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- Current raw block supabase/migrations/0256_idempotency_keys.sql SHA256 8908788609e5ea7bc692771b4f4a6391b45467abf978ed367c04b5795edbe162
alter table public.family_reminders  add column if not exists idempotency_key text;

-- Current raw block supabase/migrations/0256_idempotency_keys.sql SHA256 1bbad784349a89564572443b12e0c7c9f453d10e703ef7739adc58ec8dfa1e8b
create unique index if not exists uq_family_reminders_idempotency
  on public.family_reminders (family_id, idempotency_key) where idempotency_key is not null;

-- Current raw block supabase/migrations/0272_rsvp_is_first_person.sql SHA256 9d2826058792c99a0bd8353e287179b77135ef69f744ae5d0722ac9c094f2683
create or replace function public.is_self_member(p_member_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.family_members
    where id = p_member_id and user_id = auth.uid() and is_active
  );
$$;

-- Current raw block supabase/migrations/0479_a_reminder_or_a_to_do_is_deleted_by_a_manager_or_its_author.sql SHA256 9349f25a5f391023794ed382ae514ead78fecf0f767416078eb4b83a76cd7c1c
-- Bubaly :: 0479 - a reminder or a to-do is deleted by a manager or its author
-- ----------------------------------------------------------------------------
-- From the 2026-10-10 reminder/to-do audit (proposed-reminder-todo-delete-rls.sql,
-- the SQL half of audit/reminder-todo-deletes-fix). Numbered 0479 by owner
-- decision of 2026-10-10; the SQL is the proposal's, unchanged.
--
-- Companion to the app-side gate in deleteReminderAction / deleteTodoAction
-- (canDeleteReminder / canDeleteTodo). Today both tables carry one blanket
-- permissive policy, `for all using (is_family_member(family_id))` (0014 /
-- 0015, restated by 0426), and todo_items additionally carries 0106's four
-- per-command policies, all `is_family_member(family_id)`. So any active member
-- -- guest and caregiver included -- can DELETE any family reminder or task
-- straight against PostgREST, whatever the server action says.
--
-- This replaces them with per-command policies:
--   * SELECT / INSERT / UPDATE: unchanged semantics, is_family_member(family_id).
--     (Not tightened here. Note UPDATE still lets any member rewrite
--     assigned_to_id / member_id, which is exactly why DELETE must not trust them.)
--   * DELETE: a manager (can_manage_family: active parent/adult), or an active
--     member who is not a guest or caregiver AND authored the row.
--
-- Authorship, verified against the migrations:
--   * family_reminders.created_by  uuid references auth.users(id)          (0014)
--       -> compared with auth.uid() directly.
--   * todo_items.created_by        uuid references public.family_members(id) (0015)
--       -> NOT an auth uid. Compared with the caller's own ACTIVE membership
--          row in the row's family. The subquery states its own is_active, so
--          it does not lean on fm_select (see 0426) and passes 0426's sweep.
--   * assigned_to_id / member_id are deliberately ignored: any member can set
--     them (see above), so they are not ownership.
--
-- Idempotent: every policy is dropped if it exists and re-created; each table
-- is skipped with a notice if it is absent (to_regclass guard, as in 0378).

-- ── family_reminders ────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.family_reminders') is null then
    raise notice '0479: public.family_reminders is not there -- skipped';
    return;
  end if;

  execute 'alter table public.family_reminders enable row level security';

  -- The blanket policy (0014, rewritten by 0426) and any earlier run of this file.
  execute 'drop policy if exists "family members can manage reminders" on public.family_reminders';
  execute 'drop policy if exists family_reminders_select on public.family_reminders';
  execute 'drop policy if exists family_reminders_insert on public.family_reminders';
  execute 'drop policy if exists family_reminders_update on public.family_reminders';
  execute 'drop policy if exists family_reminders_delete on public.family_reminders';

  execute 'create policy family_reminders_select on public.family_reminders '
          'for select to public using (public.is_family_member(family_id))';
  execute 'create policy family_reminders_insert on public.family_reminders '
          'for insert to public with check (public.is_family_member(family_id))';
  execute 'create policy family_reminders_update on public.family_reminders '
          'for update to public '
          'using (public.is_family_member(family_id)) '
          'with check (public.is_family_member(family_id))';
  execute 'create policy family_reminders_delete on public.family_reminders '
          'for delete to public using ('
          '  public.can_manage_family(family_id)'
          '  or ('
          '    public.is_family_member(family_id)'
          '    and created_by = auth.uid()'
          '    and coalesce(public.family_role(family_id)::text, ''guest'') not in (''guest'', ''caregiver'')'
          '  )'
          ')';
end
$$;

-- ── todo_items ──────────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.todo_items') is null then
    raise notice '0479: public.todo_items is not there -- skipped';
    return;
  end if;

  execute 'alter table public.todo_items enable row level security';

  -- The blanket policy (0015, rewritten by 0426), 0106's per-command policies
  -- (same names as below; todo_items_delete is the permissive one that would
  -- otherwise OR the narrowing away), and any earlier run of this file.
  execute 'drop policy if exists "family member access" on public.todo_items';
  execute 'drop policy if exists todo_items_select on public.todo_items';
  execute 'drop policy if exists todo_items_insert on public.todo_items';
  execute 'drop policy if exists todo_items_update on public.todo_items';
  execute 'drop policy if exists todo_items_delete on public.todo_items';

  execute 'create policy todo_items_select on public.todo_items '
          'for select to public using (public.is_family_member(family_id))';
  execute 'create policy todo_items_insert on public.todo_items '
          'for insert to public with check (public.is_family_member(family_id))';
  execute 'create policy todo_items_update on public.todo_items '
          'for update to public '
          'using (public.is_family_member(family_id)) '
          'with check (public.is_family_member(family_id))';
  -- created_by is a family_members id (0015), so "created_by = auth.uid()" would
  -- never match; the author test is "created_by is MY active member row here".
  execute 'create policy todo_items_delete on public.todo_items '
          'for delete to public using ('
          '  public.can_manage_family(family_id)'
          '  or ('
          '    public.is_family_member(family_id)'
          '    and created_by in ('
          '      select fm.id from public.family_members fm'
          '      where fm.family_id = todo_items.family_id'
          '        and fm.user_id = auth.uid()'
          '        and fm.is_active'
          '    )'
          '    and coalesce(public.family_role(family_id)::text, ''guest'') not in (''guest'', ''caregiver'')'
          '  )'
          ')';
end
$$;

-- ── Check: no other permissive DELETE path is left on either table ──────────
-- A permissive policy ORs; one stray `for all` or `for delete` would undo the
-- narrowing above. Fails the migration rather than leaving it silently open.
do $$
declare
  stray text;
begin
  select string_agg(format('%s.%s', c.relname, p.polname), ', ' order by c.relname, p.polname)
    into stray
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relname in ('family_reminders', 'todo_items')
    and p.polpermissive
    and p.polcmd in ('*', 'd')
    and p.polname not in ('family_reminders_delete', 'todo_items_delete');

  if stray is not null then
    raise exception '0479: a permissive policy still grants DELETE beside the narrowed one: %', stray;
  end if;

  raise notice '0479 OK: family_reminders / todo_items DELETE is manager-or-author';
end
$$;


-- Current raw block supabase/migrations/0001_extensions_enums.sql SHA256 36eb05857bdd72fb5e3e0dbfa0fbd2939dd609e2c2f0accd1c80bacc6ef21094
create extension if not exists "pgcrypto";

-- Current raw block supabase/migrations/0001_extensions_enums.sql SHA256 13c1b3e5d98e5cd3c7d246670232713baaff942f57f1ba8e8c54de2e96b0a7d9
do $$ begin
  create type public.recurrence_freq as enum
    ('none','daily','weekly','monthly','yearly');
exception when duplicate_object then null; end $$;

-- Current raw block supabase/migrations/0002_tables.sql SHA256 3cae718f4087e3528ac2b05b42568aad6a1df3f2f0c5f1ca87a7a1c6f5c52443
create table if not exists public.reminders (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  title        text not null,
  notes        text,
  remind_at    timestamptz not null,
  recurrence   public.recurrence_freq not null default 'none',
  is_done      boolean not null default false,
  member_id    uuid references public.family_members(id) on delete set null,
  related_type text,                      -- 'chore','medication','document'...
  related_id   uuid,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_reminders_family on public.reminders(family_id, remind_at);


-- Current raw block supabase/migrations/0004_rls.sql SHA256 28be1972dc4da13f312f64ba15978e4ad4b08ade1046d23fd9a6bab76370f586
alter table public.reminders enable row level security;drop policy if exists reminders_select on public.reminders;
create policy reminders_select on public.reminders for select using (public.is_family_member(family_id));
drop policy if exists reminders_insert on public.reminders;
create policy reminders_insert on public.reminders for insert with check (public.is_family_member(family_id));
drop policy if exists reminders_update on public.reminders;
create policy reminders_update on public.reminders for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
drop policy if exists reminders_delete on public.reminders;
create policy reminders_delete on public.reminders for delete using (public.is_family_member(family_id));

-- Current raw block supabase/migrations/0100_reminder_details.sql SHA256 cb177d314a4e3d71c6f7253f5fb0e85197405ee5d297b1a59c4f8d02ba2e21f9
CREATE TABLE IF NOT EXISTS reminder_lists (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  name        TEXT        NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  color       TEXT        NOT NULL DEFAULT 'brand',
  icon        TEXT        NOT NULL DEFAULT 'list',
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE family_reminders
  ADD COLUMN IF NOT EXISTS url                    TEXT,
  ADD COLUMN IF NOT EXISTS flagged                BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS early_reminder_minutes INTEGER CHECK (early_reminder_minutes IS NULL OR early_reminder_minutes >= 0),
  ADD COLUMN IF NOT EXISTS image_url              TEXT,
  ADD COLUMN IF NOT EXISTS subtasks               JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS list_id                UUID REFERENCES reminder_lists(id) ON DELETE SET NULL;

grant select,insert,update,delete on public.reminders,public.reminder_lists to authenticated,service_role;grant select on public.reminders to anon;
-- ============================================================
-- Migration 0084: Family Insurance Hub — family_insurance_policies
-- One unified home for EVERY household policy (health, auto, home, life, …),
-- distinct from the existing per-domain tables (medical insurance_policies =
-- health cards, auto_insurance_policies = vehicle, home warranties). Powers the
-- AI insurance-awareness engine: renewals, annualized premium spend, coverage
-- gaps. Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.insurance_policy_type AS ENUM
    ('health','dental','vision','auto','home','renters','life','disability','umbrella','pet','travel','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.premium_frequency AS ENUM
    ('monthly','quarterly','semiannual','annual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.family_insurance_policies (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  policy_type       public.insurance_policy_type NOT NULL DEFAULT 'other',
  insurer           text NOT NULL,
  policy_number     text,
  member_id         uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  premium_amount    numeric(12,2),
  premium_frequency public.premium_frequency NOT NULL DEFAULT 'monthly',
  coverage_amount   numeric(14,2),
  deductible        numeric(12,2),
  effective_date    date,
  renewal_date      date,
  agent_name        text,
  agent_phone       text,
  claim_phone       text,
  document_path     text,
  notes             text,
  is_active         boolean NOT NULL DEFAULT true,
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_insurance_family ON public.family_insurance_policies (family_id, is_active);
CREATE INDEX IF NOT EXISTS idx_family_insurance_renewal ON public.family_insurance_policies (family_id, renewal_date) WHERE renewal_date IS NOT NULL;

DROP TRIGGER IF EXISTS trg_family_insurance_updated ON public.family_insurance_policies;
CREATE TRIGGER trg_family_insurance_updated BEFORE UPDATE ON public.family_insurance_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_insurance_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage family_insurance_policies" ON public.family_insurance_policies;
CREATE POLICY "Members manage family_insurance_policies" ON public.family_insurance_policies
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! One unified household insurance ledger with renewal dates + premiums.
-- ============================================================

alter table public.family_insurance_policies enable row level security;

drop policy if exists "Members manage family_insurance_policies" on public.family_insurance_policies;
drop policy if exists family_insurance_policies_select on public.family_insurance_policies;
drop policy if exists family_insurance_policies_insert on public.family_insurance_policies;
drop policy if exists family_insurance_policies_update on public.family_insurance_policies;
drop policy if exists family_insurance_policies_delete on public.family_insurance_policies;

create policy family_insurance_policies_select on public.family_insurance_policies
  for select to authenticated
  using (public.is_family_member(family_id));

create policy family_insurance_policies_insert on public.family_insurance_policies
  for insert to authenticated
  with check (public.can_manage_family(family_id));

create policy family_insurance_policies_update on public.family_insurance_policies
  for update to authenticated
  using (public.can_manage_family(family_id))
  with check (public.can_manage_family(family_id));

create policy family_insurance_policies_delete on public.family_insurance_policies
  for delete to authenticated
  using (public.can_manage_family(family_id));

-- Bubaly :: 0486 - an Autopilot card is read by its audience
-- ----------------------------------------------------------------------------
-- From the 2026-10-12 family-life audit (PR #1031), the database half of
-- lib/autopilot/audience.ts. Numbered 0486 as the next free number: under the
-- owner decision of 2026-10-10 the holders the preserved map lists for
-- 0477-0487 take the next free number when they land, and 0486 was free
-- ("Numbering from 0475 on", docs/PENDING_PROD_MIGRATIONS.md); 0487 stays
-- free. The migrations held in supabase/reserved/ are untouched.
--
-- An Autopilot card is a COPY of a source row as the scan saw it: a
-- subscription's name and amount, a renewal's title, an insurance policy's
-- type and insurer. The nightly scan runs on the service role, so the copy is
-- made past every rule that narrows the source, and `autopilot_suggestions`
-- is then read under 0085's `FOR ALL TO authenticated USING
-- (is_family_member(family_id))`; 0327 closed DELETE and pinned resolved_by
-- and left SELECT as it was. audience.ts decides who each card is for and every
-- screen filters by it, but nothing below the screens did. Reproduced natively
-- (installed SDK -> PostgREST -> Postgres): an active guest gets zero rows of
-- `subscriptions_tracked` and `renewals`, which 0481 refuses them, and reads
-- the cards copied from both, title, detail and payload ("$15.99 charge:
-- Netflix tomorrow", "Renew Passport").
--
-- The rule is audience.ts's suggestionAudience/suggestionVisibleTo, in its
-- order (the insurance test is made first, so a card that is both is the
-- narrower one's):
--
--   policy-readers  source_kind 'family_insurance_policies' or kind 'insurance'
--                   -> a manager (can_manage_family, 0003: parent or adult,
--                   active) or the member the policy names. The scan reads
--                   family_insurance_policies.member_id into the snapshot
--                   (lib/autopilot/scan.ts), the engine's insurance draft
--                   carries it as memberId (lib/autopilot/engine.ts), and the
--                   scan stores it as the card's member_id; is_self_member
--                   (0272) is whether that member row is the caller's own,
--                   active. A card naming nobody is the managers'.
--   not-guests      kind 'finance' or source_kind 'subscriptions_tracked' or
--                   'renewals' -> anyone whose role in the family is not
--                   guest: 0481's own test on those two tables,
--                   `family_role(family_id) is distinct from 'guest'`.
--   everyone        anything else -> no narrowing.
--
-- Two RESTRICTIVE policies TO authenticated over that one CASE, one FOR
-- SELECT and one FOR UPDATE, ANDed with 0085's permissive policy, so
-- membership of the card's family is still required and an inactive member,
-- another family's member and `anon` (no policy at all) still read nothing;
-- and one BEFORE UPDATE trigger (below, "An UPDATE that reads no column").
-- The policies reuse the helpers 0464, 0481 and the held 0517 use; the
-- trigger's function is the only thing defined here. The service role
-- bypasses RLS and the trigger, so the nightly scan and the notifications
-- generator are unchanged.
--
-- What it does to writes, which is why the scan changes with it. A SELECT
-- policy also applies to a write that reads its row: an UPDATE with a WHERE
-- or RETURNING sees only rows the caller may read and must still be able to
-- read the new row, and an INSERT ... RETURNING must be able to read what it
-- inserted. So a reader resolves a card exactly as before (resolveSuggestion's
-- update ... select; trust actions' policy cards are everyone's), and a
-- non-reader's resolve matches no row, which the app already answers as
-- notFound for a card it does not show them. The on-demand scan
-- (app/api/autopilot/scan, `createServer()`, the CALLER's client) inserts with
-- `.select('id')`; a card its caller may not read would be refused 42501 and
-- fail the whole scan (0327 explains why that scan stays open to every
-- member). lib/autopilot/scan.ts therefore skips a draft its caller may not
-- read; the nightly scan or a reader's own scan writes it. INSERT and DELETE
-- policies, and 0327's three guards, are not changed.
--
-- ── An UPDATE that reads no column (RV486-2) ────────────────────────────────
--
-- "A SELECT policy also applies to a write that reads its row" is the whole
-- of it: Postgres adds SELECT policies to an UPDATE only when the statement
-- needs SELECT on the table, i.e. when its WHERE, its RETURNING or a SET
-- expression names a column of it. Replayed on PG16, as the unnamed teen with
-- the SELECT policy alone:
--
--   update public.autopilot_suggestions set member_id = '<own member id>'
--     -> every card of the family, Ava's insurance card included, now names
--        the teen, and the teen reads it (`where true`, `returning 1` and a
--        SET of `(select id from family_members where user_id = auth.uid())`
--        are the same: none names a column);
--   update public.autopilot_suggestions set kind = 'other', source_kind = null
--     -> as the guest: the subscription charge is an "other" card and the
--        guest reads "$15.99 charge: Netflix tomorrow";
--   PostgREST's PATCH with no filter and return=minimal
--     -> the same: its mutation CTE sets from the JSON body and returns 1.
--
-- Forms that name a column are already held by the SELECT policy, on the old
-- row (filtered) and on the new one (refused 42501): a PATCH with any filter
-- (`?family_id=eq.…` and every other PostgREST filter names a column),
-- `returning id`, `set title = title`. Hosted Supabase may refuse an
-- unfiltered PostgREST UPDATE before it gets here (pg-safeupdate); nothing in
-- this repository can show that, and these guards do not rely on it.
--
-- Two things close it:
--
--   1. RESTRICTIVE FOR UPDATE TO authenticated, USING and WITH CHECK both the
--      same CASE. An UPDATE policy applies to every UPDATE, whatever it names:
--      USING means a caller updates only rows they may read, so a non-reader
--      cannot touch a card at all; WITH CHECK means the row it leaves must
--      still be one the CALLER may read. That stops every relabel of the
--      card's member that lands outside the caller's audience: a named child
--      moving her card to a sibling (or to nobody, the managers'), a teen or a
--      guest naming themselves on a card they could not read (they could not
--      reach it). It cannot stop a reader whose new row is still theirs to
--      read, which is (2)'s.
--      A manager reads every card, so a manager may still say whose policy a
--      card is; that is the Insurance Hub's decision and it is how the scan
--      keeps a card in step with a reassigned policy (below).
--   2. A BEFORE UPDATE trigger that pins the columns that decide who reads a
--      card, `kind`, `source_kind` and `family_id`, for every caller subject
--      to RLS. The policy sees only the NEW row, and a READER who widens a
--      card ends inside their own audience: the teen who may read the
--      subscription charge turns it into kind 'other' and passes any check on
--      the new row, and the guest reads it. Only the old row can tell that
--      from an honest resolve, which is a trigger's (0480's pattern, and its
--      bypass test: a role that bypasses RLS bypasses this). `kind` and
--      `source_kind` are what audience.ts classifies a card by. `family_id`
--      is an argument of every helper in the CASE (can_manage_family,
--      family_role) and of 0085's membership test, so it decides the audience
--      as much as the other two (RV486-2-FAMILY): replayed on PG16 with only
--      those two pinned, Ava, a child in this family and in her co-parent's,
--      moved her insurance card into the other family by id (`set family_id
--      = '<B>' … returning id`), the other family's parent read it and this
--      family's adult no longer did; Sam, a teen in both, did the same to
--      the subscription charge by PostgREST's filtered PATCH; a guest here
--      who runs her own household moved an ordinary card into it. Every check
--      passed: 0085's WITH CHECK is membership of the NEW family, which they
--      have; this policy's USING read the old row, its WITH CHECK the new one
--      (`is_self_member(member_id)` does not ask which family, and the teen's
--      role in the other family is not guest); 0327's update guard asks only
--      membership of the old family and who resolved.
--      Moving a card out of its family is also the delete 0327 refuses every
--      client. With the three pinned no client changes which audience a card
--      has, either way: `member_id` is the only column a client can still
--      write that decides who reads a card, and only on an insurance card,
--      where (1) holds it. Nothing in app/ or lib/ updates any of the three
--      (resolve, archive, the policy refresh and the trust actions write
--      status, resolved_*, dedupe_key, expires_at, detail, confidence,
--      payload; the scan's refresh writes member_id, by id AND family_id), so
--      the pin costs no flow. A manager is pinned too: no client rewrites
--      what a card is a copy of or whose family it is.
--
-- ── Insurance cards written before the scan stored their member ─────────────
--
-- The scan stores the policy's member as the card's member_id
-- (family_insurance_policies.member_id, read into the snapshot); cards written
-- before it did carry member_id NULL. Under this policy such a card is the
-- managers' alone, so the member the policy names cannot read their own
-- renewal (no leak, but a regression of audience.ts), and their own
-- on-demand scan drafts it, cannot see the prior row, inserts, meets
-- UNIQUE(family_id, dedupe_key) (23505), removes the reminder it made and
-- carries on, every time they open Autopilot. The backfill below, BEFORE the
-- policies, names that member on every card whose policy names one:
-- autopilot_suggestions.source_id and family_insurance_policies.id are both
-- uuid (0085, 0084), matched within the same family_id, and only a card with
-- no member is touched, so it is idempotent and never overrides a member the
-- scan wrote. Triggers on autopilot_suggestions, from the migrations and the
-- replayed catalog: 0085's trg_autopilot_suggestions_updated_at (BEFORE
-- UPDATE, set_updated_at(): bumps updated_at, which resolveSuggestion uses as
-- its concurrency token, so a screen open across the release answers
-- "changed" once and reloads), the foreign-key checks (member_id names a
-- family_members row: the policy's own member_id does), and this migration's
-- pin, which is created after the backfill, does not pin member_id and is
-- bypassed by the migration role. None refuses it.
--
-- A policy reassigned to another member is the scan's to follow:
-- lib/autopilot/scan.ts refreshes a prior insurance card's member_id when the
-- policy names someone other than the card does (a legacy card this backfill
-- did not reach included, and a policy that now names no one), on the nightly scan
-- and on a manager's own scan, never on a scan by a member who may not read
-- both the old card and the new one. A manager's scan also leaves a card
-- somebody else resolved alone: 0327's resolver guard keeps resolved_by the
-- resolver's, so that write would be refused. The window that leaves: from
-- the reassignment until the next nightly scan (or a manager's, for a card
-- nobody else resolved), the newly named member cannot read the card (their
-- own scan still takes the 23505 path) and the previously named member still
-- reads it. And only a card whose draft a scan still builds is refreshed: the
-- insurance draft is made for an active policy renewing within 30 days, so a
-- policy reassigned after its renewal day, or after it was deactivated,
-- leaves its card naming the old member. The write lands only while the card
-- still names the member the scan read on it, so an overlapping scan that
-- read the policy earlier cannot put an older member back. An accepted card
-- ('executed', or 'approved' on its way there) is not refreshed: its
-- family_reminders rows carry a tag minted from the card's columns, member_id
-- among them, and a repeating reminder's next occurrence carries the tag
-- alone, so the card and its reminders keep the member it was accepted under.
--
-- What stays outside it:
--
--   * The reminders a card makes. An auto-executed card writes a `reminders`
--     row (related_type 'renewal', related_id the source) and a reader's "Add
--     reminder" a `family_reminders` row (the card's idempotency key); both
--     carry the card's words, and both tables still read family-wide in RLS.
--     The app hides them per card in lib/autopilot/reminder-cards.ts by
--     READING the card. Under this policy a reader the card is not for no
--     longer finds it, so that lookup reads every create_reminder card its
--     reader may read (an everyone card's too: a refill's reminder is also
--     related_type 'renewal') and answers a reminder that looks like a card's
--     whose card it does not find as the managers' alone, the answer it gives
--     a failed read; changed with this migration, before it is applied, and
--     the same answer without it (tests/a-cards-reminder-stays-with-its-
--     readers-when-the-card-is-not-theirs-to-read.test.ts, both schemas).
--     A screen that lists these rows without that lookup, or a direct read of
--     either table, still shows them to the family: the reminder rows need a
--     read rule of their own.
--   * The insurance source. family_insurance_policies (0416) still reads
--     family-wide: the held 0517 narrows it to managers and its member. Until
--     it lands any member reads the policy row this card copies; this closes
--     the copy, not the source.
--
-- Probe: docs/audit/an-autopilot-card-is-read-by-its-audience-check.sql (the
-- read rule, the column-free UPDATE, the pin, a move into another family the
-- writer also belongs to, and this file's backfill re-applied in its
-- transaction). docs/audit/autopilot-suggestion-write-check.sql (0327) still
-- holds: its cards are everyone's.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md);
-- the owner applies it in the normal manual release.
--
-- Idempotent: the backfill touches only a card with no member, so a second run
-- writes no row; the function is created or replaced, and the policies and
-- the trigger are dropped if they exist before they are created.

do $$
begin
  if to_regclass('public.autopilot_suggestions') is null then
    raise exception '0486: public.autopilot_suggestions (0085) does not exist';
  end if;
  if to_regclass('public.family_insurance_policies') is null then
    raise exception '0486: public.family_insurance_policies (0084) does not exist';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null
     or to_regprocedure('public.is_self_member(uuid)') is null
     or to_regprocedure('public.family_role(uuid)') is null then
    raise exception '0486 needs can_manage_family, is_self_member and family_role';
  end if;
end
$$;

-- ── a legacy insurance card names the member its policy names ──────────────
-- Before the policies: a card written before the scan stored the policy's
-- member is otherwise the managers' alone, and its member's own scan meets
-- 23505 on every open. Only a card with no member, so a member the scan wrote
-- is never overridden and a second run writes nothing.
do $$
declare
  v_named bigint;
begin
  update public.autopilot_suggestions s
     set member_id = p.member_id
    from public.family_insurance_policies p
   where s.source_kind = 'family_insurance_policies'
     and s.source_id = p.id
     and s.family_id = p.family_id
     and s.member_id is null
     and p.member_id is not null;
  get diagnostics v_named = row_count;
  raise notice '0486: % insurance card(s) written before the scan stored the policy''s member now name it', v_named;
end
$$;

drop policy if exists autopilot_suggestions_audience_read_guard on public.autopilot_suggestions;
create policy autopilot_suggestions_audience_read_guard on public.autopilot_suggestions
  as restrictive for select to authenticated
  using (
    case
      when source_kind = 'family_insurance_policies' or kind = 'insurance'
        then public.can_manage_family(family_id) or public.is_self_member(member_id)
      when kind = 'finance' or source_kind in ('subscriptions_tracked', 'renewals')
        then public.family_role(family_id) is distinct from 'guest'
      else true
    end
  );

comment on policy autopilot_suggestions_audience_read_guard on public.autopilot_suggestions is
  'A card is read by its audience (lib/autopilot/audience.ts, 0486): an insurance renewal by a manager or the member the policy names; a subscription charge or a renewal by anyone but a guest; anything else by the family (0085). An UPDATE that names no column skips this policy; autopilot_suggestions_audience_update_guard holds that one.';

-- The same CASE, on every UPDATE whatever it names (RV486-2): USING, a caller
-- updates only a card they may read; WITH CHECK, the card they leave is still
-- one they may read.
drop policy if exists autopilot_suggestions_audience_update_guard on public.autopilot_suggestions;
create policy autopilot_suggestions_audience_update_guard on public.autopilot_suggestions
  as restrictive for update to authenticated
  using (
    case
      when source_kind = 'family_insurance_policies' or kind = 'insurance'
        then public.can_manage_family(family_id) or public.is_self_member(member_id)
      when kind = 'finance' or source_kind in ('subscriptions_tracked', 'renewals')
        then public.family_role(family_id) is distinct from 'guest'
      else true
    end
  )
  with check (
    case
      when source_kind = 'family_insurance_policies' or kind = 'insurance'
        then public.can_manage_family(family_id) or public.is_self_member(member_id)
      when kind = 'finance' or source_kind in ('subscriptions_tracked', 'renewals')
        then public.family_role(family_id) is distinct from 'guest'
      else true
    end
  );

comment on policy autopilot_suggestions_audience_update_guard on public.autopilot_suggestions is
  'A card is updated only by its audience, and only into a card its writer may still read (0486, RV486-2): the read rule of autopilot_suggestions_audience_read_guard on the old row (USING) and the new row (WITH CHECK), for every UPDATE, including one that names no column and so skips the SELECT policy. With autopilot_suggestion_keeps_its_audience, which pins kind, source_kind and family_id (a reader''s widening, or a move into another family the writer also belongs to, passes a check on either row alone), a non-reader cannot touch a card and a reader cannot relabel one for someone outside its audience.';

-- ── what a card is a copy of, and whose family it is, is the scan's ─────────
-- (RV486-2, RV486-2-FAMILY)
create or replace function public.autopilot_suggestion_keeps_its_audience()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_bypass boolean;
begin
  -- The server bypasses row-level security, and so does this (0480).
  select r.rolsuper or r.rolbypassrls into v_bypass
  from pg_catalog.pg_roles r
  where r.rolname = current_user;
  if coalesce(v_bypass, false) then
    return new;
  end if;

  if new.kind is distinct from old.kind
     or new.source_kind is distinct from old.source_kind
     or new.family_id is distinct from old.family_id then
    raise exception 'what an Autopilot card is a copy of and whose family it is (kind, source_kind, family_id) decide who reads it and cannot be rewritten (0486)'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function public.autopilot_suggestion_keeps_its_audience() is
  'BEFORE UPDATE on autopilot_suggestions, for callers subject to RLS: kind, source_kind and family_id, the columns that decide who reads a card (lib/autopilot/audience.ts classifies it by the first two; every helper in the read rule, and 0085''s membership, takes the third), never change after insert. So a reader cannot widen a card (a finance card turned into an everyone card), narrow one past the update guard, which sees only the new row, or move one into another family they also belong to, where that family''s readers read it and its own family loses it (0486).';

revoke all on function public.autopilot_suggestion_keeps_its_audience() from public, anon, authenticated;

drop trigger if exists autopilot_suggestions_keep_their_audience on public.autopilot_suggestions;
create trigger autopilot_suggestions_keep_their_audience
  before update on public.autopilot_suggestions
  for each row execute function public.autopilot_suggestion_keeps_its_audience();

-- ── self-check ───────────────────────────────────────────────────────────────
do $$
declare
  v_read text;
  v_update_using text;
  v_update_check text;
  v_legacy bigint;
begin
  select qual into v_read from pg_policies
   where schemaname = 'public' and tablename = 'autopilot_suggestions'
     and policyname = 'autopilot_suggestions_audience_read_guard'
     and permissive = 'RESTRICTIVE' and cmd = 'SELECT' and roles = '{authenticated}'::name[];
  if v_read is null then
    raise exception '0486: the audience read guard on autopilot_suggestions is missing or is not RESTRICTIVE FOR SELECT TO authenticated';
  end if;
  select qual, with_check into v_update_using, v_update_check from pg_policies
   where schemaname = 'public' and tablename = 'autopilot_suggestions'
     and policyname = 'autopilot_suggestions_audience_update_guard'
     and permissive = 'RESTRICTIVE' and cmd = 'UPDATE' and roles = '{authenticated}'::name[];
  if v_update_using is null or v_update_check is null then
    raise exception '0486: the audience update guard on autopilot_suggestions is missing, is not RESTRICTIVE FOR UPDATE TO authenticated, or lacks USING or WITH CHECK';
  end if;
  if v_update_using is distinct from v_read or v_update_check is distinct from v_read then
    raise exception '0486: the audience update guard does not apply the read guard''s rule on both rows';
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.autopilot_suggestions'::regclass
       and t.tgname = 'autopilot_suggestions_keep_their_audience'
       and t.tgenabled = 'O'
       and t.tgfoid = 'public.autopilot_suggestion_keeps_its_audience()'::regprocedure
  ) then
    raise exception '0486: the trigger pinning a card''s kind, source_kind and family_id is missing or disabled';
  end if;
  if has_function_privilege('anon', 'public.autopilot_suggestion_keeps_its_audience()', 'execute')
     or has_function_privilege('authenticated', 'public.autopilot_suggestion_keeps_its_audience()', 'execute') then
    raise exception '0486: autopilot_suggestion_keeps_its_audience is executable by a client role';
  end if;
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'autopilot_suggestions'
       and policyname = 'Members manage autopilot_suggestions' and permissive = 'PERMISSIVE' and cmd = 'ALL'
  ) then
    raise exception '0486: 0085''s membership policy on autopilot_suggestions is gone';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'autopilot_suggestions'
         and policyname in ('autopilot_suggestions_no_client_delete_guard',
                            'autopilot_suggestions_resolver_guard',
                            'autopilot_suggestions_resolver_update_guard')) <> 3 then
    raise exception '0486: 0327''s guards on autopilot_suggestions are not all there';
  end if;
  select count(*) into v_legacy
    from public.autopilot_suggestions s
    join public.family_insurance_policies p
      on p.id = s.source_id and p.family_id = s.family_id
   where s.source_kind = 'family_insurance_policies'
     and s.member_id is null and p.member_id is not null;
  if v_legacy <> 0 then
    raise exception '0486: % insurance card(s) still name no member although their policy names one', v_legacy;
  end if;
  raise notice '0486 OK: an Autopilot card is read and updated by its audience (insurance: managers and its member; subscriptions and renewals: not guests; the rest: the family), its kind, source_kind and family are the server''s, and every insurance card names the member its policy names';
end
$$;

alter table public.families enable row level security;alter table public.family_members enable row level security;

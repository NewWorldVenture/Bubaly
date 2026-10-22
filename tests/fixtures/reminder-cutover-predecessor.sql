\set ON_ERROR_STOP on
-- DISPOSABLE REHEARSAL ONLY. A declared predecessor, never a production clone.
-- Core reminder/identity blocks below are preserved from the pinned existing native bootstrap.
-- The seven extra prerequisite tables are deliberately minimal; no application-schema fidelity is claimed.
-- No 0256/0272/0327/0486/0487 effects are preinstalled by this fixture.
do $$ begin
 if current_database()<>'cutover_runtime' or session_user<>'cutover_maint'
    or current_setting('server_version_num')::integer not between 170000 and 179999
    or exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r')
 then raise exception 'Refuse nonempty or unowned cutover predecessor'; end if;
end $$;
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


-- Minimal witnesses for all 0256/0272 effects; ordinary membership RLS remains real.
create table public.documents(id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),title text not null);
do $$ declare t text; begin
 foreach t in array array['calendar_events','todo_items','chore_assignments','meal_plans','grocery_items','transactions'] loop
  execute format('create table public.%I(id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),title text not null)',t);
 end loop;
end $$;
create table public.event_rsvps(id uuid primary key default gen_random_uuid(),family_id uuid not null references public.families(id),member_id uuid not null references public.family_members(id),event_id uuid references public.calendar_events(id),title text not null,status text not null default 'accepted');
do $$ declare t text; begin
 foreach t in array array['documents','calendar_events','todo_items','chore_assignments','meal_plans','grocery_items','transactions','event_rsvps'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('create policy %I on public.%I for all to authenticated using(public.is_family_member(family_id)) with check(public.is_family_member(family_id))','Members can manage '||t,t);
 end loop;
end $$;
alter table public.families enable row level security;
alter table public.family_members enable row level security;
-- A real second application login permits old prepared sessions independently of PostgREST's pool.
create role cutover_old_writer noinherit login nosuperuser nobypassrls;
grant authenticated,service_role to cutover_old_writer;
grant connect on database cutover_runtime to authenticator,cutover_old_writer;
grant select,insert,update,delete on all tables in schema public to authenticated,service_role;
revoke all on all tables in schema public from anon;
grant usage on schema public,auth to authenticated,anon,service_role;

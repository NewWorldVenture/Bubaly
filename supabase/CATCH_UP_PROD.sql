-- ============================================================================
-- FamilyOS · CATCH_UP_PROD.sql — idempotent full-schema catch-up (0001..0159).
-- Reconciles a prod DB behind the repo migrations. SAFE on ANY state: creates
-- what's missing, skips what exists. Run FIRST, then SEED_ALL.sql.
-- Where: Supabase → SQL Editor → paste → Run.
-- ============================================================================



-- ── PRE-RECONCILE: RLS helper-function parameter-name drift ─────────────────
-- Some prod DBs carry these SECURITY-DEFINER helpers with OLDER parameter names
-- than the current migrations use (e.g. is_family_member(fid) vs (p_family_id)).
-- CREATE OR REPLACE FUNCTION cannot rename a parameter, so drop them CASCADE up
-- front; the migrations below recreate the functions AND every RLS policy that
-- depends on them, restoring full row-level security. Safe to re-run.
drop function if exists public.is_family_member(uuid) cascade;
drop function if exists public.family_role(uuid) cascade;
drop function if exists public.can_manage_family(uuid) cascade;
drop function if exists public.is_family_admin(uuid) cascade;
-- ────────────────────────────────────────────────────────────────────────────


-- ══════════ 0001_extensions_enums.sql ══════════
-- FamilyOS :: 0001 extensions + enums
-- Supabase ships pgcrypto/uuid; gen_random_uuid() is available by default.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- Membership roles (drives RLS + app permissions)
do $$ begin
  create type public.member_role as enum
    ('parent','adult','teen','child','caregiver','guest');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.invite_status as enum
    ('pending','accepted','declined','expired','revoked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.task_status as enum
    ('todo','in_progress','submitted','approved','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.priority as enum ('low','medium','high');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.event_category as enum
    ('general','school','sports','appointment','medication','maintenance','birthday','holiday','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.recurrence_freq as enum
    ('none','daily','weekly','monthly','yearly');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.meal_type as enum ('breakfast','lunch','dinner','snack');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_type as enum
    ('chore_due','medication_due','calendar_event','school_event','sports_event',
     'maintenance_task','grocery_reminder','document_expiry','family_invite','system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.subscription_status as enum
    ('trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.theme_pref as enum ('dark','light','system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.ai_role as enum ('user','assistant','system','tool');
exception when duplicate_object then null; end $$;



-- ══════════ 0002_tables.sql ══════════
-- FamilyOS :: 0002 tables
-- Convention: every household-scoped table carries family_id (uuid) for RLS isolation,
-- created_by (uuid -> auth.users), and created_at/updated_at timestamptz.

-- ============================================================
-- IDENTITY & HOUSEHOLD
-- ============================================================

-- "users" in Supabase = auth.users (managed). public.profiles mirrors it for app data.
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text,
  full_name     text,
  display_name  text,
  avatar_url    text,
  date_of_birth date,
  phone         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.families (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  avatar_url  text,
  timezone    text not null default 'UTC',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

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
create index if not exists idx_family_members_family on public.family_members(family_id);
create index if not exists idx_family_members_user on public.family_members(user_id);

-- Reference catalog: capabilities per role (app-readable permission matrix)
create table if not exists public.roles (
  role        public.member_role primary key,
  label       text not null,
  description text
);

create table if not exists public.permissions (
  id          uuid primary key default gen_random_uuid(),
  role        public.member_role not null references public.roles(role) on delete cascade,
  resource    text not null,            -- e.g. 'calendar_events'
  can_create  boolean not null default false,
  can_read    boolean not null default true,
  can_update  boolean not null default false,
  can_delete  boolean not null default false,
  unique (role, resource)
);

create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  email       text not null,
  role        public.member_role not null default 'adult',
  token       text not null unique default encode(gen_random_bytes(24),'hex'),
  status      public.invite_status not null default 'pending',
  invited_by  uuid references auth.users(id) on delete set null,
  expires_at  timestamptz not null default (now() + interval '14 days'),
  accepted_by uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_invites_family on public.invites(family_id);
create index if not exists idx_invites_email on public.invites(lower(email));

-- ============================================================
-- CALENDAR / SCHOOL / SPORTS / APPOINTMENTS
-- ============================================================

create table if not exists public.calendar_events (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  title          text not null,
  description    text,
  location       text,
  category       public.event_category not null default 'general',
  starts_at      timestamptz not null,
  ends_at        timestamptz,
  all_day        boolean not null default false,
  recurrence     public.recurrence_freq not null default 'none',
  recurrence_until timestamptz,
  assignee_id    uuid references public.family_members(id) on delete set null,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_events_family_time on public.calendar_events(family_id, starts_at);

create table if not exists public.school_events (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  school_name text,
  title       text not null,
  event_type  text default 'general',  -- holiday, field_trip, parent_meeting, exam...
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  notes       text,
  source      text,                     -- 'flyer_ocr', 'manual', 'ai'
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_school_family on public.school_events(family_id, starts_at);

create table if not exists public.sports_events (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  sport       text,
  team        text,
  title       text not null,
  event_type  text default 'practice', -- practice, game, tournament
  location    text,
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  recurrence  public.recurrence_freq not null default 'none',
  recurrence_until timestamptz,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_sports_family on public.sports_events(family_id, starts_at);

create table if not exists public.appointments (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  title       text not null,
  provider    text,
  location    text,
  starts_at   timestamptz not null,
  ends_at     timestamptz,
  notes       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_appts_family on public.appointments(family_id, starts_at);

-- ============================================================
-- CHORES & REWARDS
-- ============================================================

create table if not exists public.chores (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  title        text not null,
  description  text,
  points       integer not null default 10,
  priority     public.priority not null default 'medium',
  recurrence   public.recurrence_freq not null default 'none',
  due_at       timestamptz,
  requires_approval boolean not null default true,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_chores_family on public.chores(family_id);

create table if not exists public.chore_assignments (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  chore_id     uuid not null references public.chores(id) on delete cascade,
  member_id    uuid not null references public.family_members(id) on delete cascade,
  status       public.task_status not null default 'todo',
  due_at       timestamptz,
  submitted_at timestamptz,
  approved_at  timestamptz,
  approved_by  uuid references public.family_members(id) on delete set null,
  points_awarded integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_chore_assign_family on public.chore_assignments(family_id);
create index if not exists idx_chore_assign_member on public.chore_assignments(member_id, status);

create table if not exists public.rewards (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  title        text not null,
  description  text,
  cost_points  integer not null default 100,
  redeemed_by  uuid references public.family_members(id) on delete set null,
  redeemed_at  timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_rewards_family on public.rewards(family_id);

-- ============================================================
-- MEALS & GROCERY
-- ============================================================

create table if not exists public.meals (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  name         text not null,
  meal_type    public.meal_type not null default 'dinner',
  recipe_url   text,
  ingredients  jsonb not null default '[]'::jsonb, -- [{name, qty, unit}]
  notes        text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_meals_family on public.meals(family_id);

create table if not exists public.meal_plans (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  meal_id      uuid references public.meals(id) on delete set null,
  plan_date    date not null,
  meal_type    public.meal_type not null default 'dinner',
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_meal_plans_family on public.meal_plans(family_id, plan_date);

create table if not exists public.grocery_lists (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  name         text not null default 'Groceries',
  is_archived  boolean not null default false,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_grocery_lists_family on public.grocery_lists(family_id);

create table if not exists public.grocery_items (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  list_id      uuid not null references public.grocery_lists(id) on delete cascade,
  name         text not null,
  quantity     text,
  category     text,
  is_checked   boolean not null default false,
  source_meal_id uuid references public.meals(id) on delete set null,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_grocery_items_list on public.grocery_items(list_id);
create index if not exists idx_grocery_items_family on public.grocery_items(family_id);

-- ============================================================
-- HEALTH / MEDICATION
-- ============================================================

create table if not exists public.medications (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  member_id    uuid references public.family_members(id) on delete set null,
  name         text not null,
  dosage       text,
  instructions text,
  is_active    boolean not null default true,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_meds_family on public.medications(family_id);

create table if not exists public.medication_schedules (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  medication_id uuid not null references public.medications(id) on delete cascade,
  time_of_day   time not null,
  days_of_week  int[] not null default '{0,1,2,3,4,5,6}', -- 0=Sun
  starts_on     date not null default current_date,
  ends_on       date,
  last_taken_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_med_sched_family on public.medication_schedules(family_id);

-- ============================================================
-- HOME / MAINTENANCE
-- ============================================================

create table if not exists public.home_assets (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  name         text not null,             -- "HVAC", "Water heater"
  category     text,
  location     text,
  brand        text,
  model        text,
  purchased_on date,
  warranty_until date,
  notes        text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_home_assets_family on public.home_assets(family_id);

create table if not exists public.maintenance_tasks (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  asset_id      uuid references public.home_assets(id) on delete set null,
  title         text not null,
  description   text,
  status        public.task_status not null default 'todo',
  priority      public.priority not null default 'medium',
  recurrence    public.recurrence_freq not null default 'none',
  interval_days integer,                  -- e.g. HVAC filter every 90 days
  due_at        timestamptz,
  completed_at  timestamptz,
  assignee_id   uuid references public.family_members(id) on delete set null,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_maint_family on public.maintenance_tasks(family_id, due_at);

-- ============================================================
-- DOCUMENTS / NOTES / GOALS
-- ============================================================

create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  title        text not null,
  category     text,                      -- insurance, medical, school, legal...
  storage_path text not null,             -- Supabase Storage object path (private bucket)
  mime_type    text,
  size_bytes   bigint,
  expires_at   date,                      -- drives document_expiry notifications
  member_id    uuid references public.family_members(id) on delete set null,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_documents_family on public.documents(family_id);

create table if not exists public.notes (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  title        text,
  body         text not null default '',
  is_pinned    boolean not null default false,
  checklist    jsonb,                     -- optional [{text, done}]
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_notes_family on public.notes(family_id);

create table if not exists public.goals (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  title        text not null,
  description  text,
  target_date  date,
  progress     integer not null default 0, -- 0..100
  is_complete  boolean not null default false,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_goals_family on public.goals(family_id);

-- ============================================================
-- REMINDERS / NOTIFICATIONS
-- ============================================================

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

create table if not exists public.notifications (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete cascade, -- recipient (null = whole family)
  type         public.notification_type not null,
  title        text not null,
  body         text,
  related_type text,
  related_id   uuid,
  is_read      boolean not null default false,
  send_at      timestamptz not null default now(),
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_notif_user on public.notifications(user_id, is_read);
create index if not exists idx_notif_family on public.notifications(family_id);

-- ============================================================
-- AI ASSISTANT
-- ============================================================

create table if not exists public.ai_conversations (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  title        text not null default 'New conversation',
  provider     text not null default 'anthropic',
  model        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_ai_conv_family on public.ai_conversations(family_id);

create table if not exists public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role            public.ai_role not null,
  content         text not null default '',
  tool_calls      jsonb,   -- structured actions the AI requested (create_event, etc.)
  tool_results    jsonb,   -- results of executed actions
  created_at      timestamptz not null default now()
);
create index if not exists idx_ai_msg_conv on public.ai_messages(conversation_id, created_at);

-- ============================================================
-- SYSTEM: AUDIT / BILLING / PREFERENCES
-- ============================================================

create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid references public.families(id) on delete cascade,
  actor_id    uuid references auth.users(id) on delete set null,
  action      text not null,            -- 'insert','update','delete','login'...
  resource    text not null,
  resource_id uuid,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists idx_audit_family on public.audit_logs(family_id, created_at);

create table if not exists public.billing_customers (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null unique references public.families(id) on delete cascade,
  provider        text not null default 'stripe',
  customer_ref    text,                 -- stripe customer id
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  family_id           uuid not null references public.families(id) on delete cascade,
  billing_customer_id uuid references public.billing_customers(id) on delete set null,
  plan                text not null default 'free',  -- free, family, family_plus
  status              public.subscription_status not null default 'trialing',
  provider_ref        text,             -- stripe subscription id
  current_period_end  timestamptz,
  seats               integer not null default 6,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_subs_family on public.subscriptions(family_id);

create table if not exists public.user_preferences (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  theme              public.theme_pref not null default 'dark',
  push_enabled       boolean not null default true,
  email_enabled      boolean not null default true,
  expo_push_token    text,
  active_family_id   uuid references public.families(id) on delete set null,
  notification_prefs jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);



-- ══════════ 0003_functions_triggers.sql ══════════
-- FamilyOS :: 0003 functions + triggers

-- ----- RLS helper functions (SECURITY DEFINER bypasses RLS to avoid recursion) -----

create or replace function public.is_family_member(p_family_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid() and is_active
  );
$$;

create or replace function public.family_role(p_family_id uuid)
returns public.member_role language sql security definer stable set search_path = public as $$
  select role from public.family_members
  where family_id = p_family_id and user_id = auth.uid()
  order by case role when 'parent' then 0 when 'adult' then 1 else 2 end
  limit 1;
$$;

-- Household managers (can manage shared data + approve chores).
create or replace function public.can_manage_family(p_family_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid()
      and role in ('parent','adult') and is_active
  );
$$;

-- Full admin (parent only) for billing/family deletion.
create or replace function public.is_family_admin(p_family_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.family_members
    where family_id = p_family_id and user_id = auth.uid()
      and role = 'parent' and is_active
  );
$$;

-- ----- updated_at maintenance -----
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end; $$;

-- ----- new auth user -> profile + preferences -----
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  insert into public.user_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----- new family -> creator becomes parent member + trial subscription -----
create or replace function public.handle_new_family()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.created_by is not null then
    insert into public.family_members (family_id, user_id, role, display_name)
    values (new.id, new.created_by, 'parent',
            coalesce((select full_name from public.profiles where id = new.created_by), 'Parent'))
    on conflict (family_id, user_id) do nothing;
  end if;
  insert into public.subscriptions (family_id, plan, status, current_period_end)
  values (new.id, 'free', 'trialing', now() + interval '14 days');
  return new;
end; $$;

drop trigger if exists on_family_created on public.families;
drop trigger if exists on_family_created on public.families;
create trigger on_family_created
  after insert on public.families
  for each row execute function public.handle_new_family();

-- ----- attach updated_at triggers to every table that has the column -----
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'updated_at'
    group by table_name
  loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;



-- ══════════ 0004_rls.sql ══════════
-- FamilyOS :: 0004 row level security
-- Hard guarantee: no row crosses a family boundary. Every household table is gated
-- by is_family_member(family_id). Reference tables are read-only to authenticated users.

-- Enable RLS everywhere.
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- ---------- Generic family-scoped tables (members get full CRUD within their family) ----------
do $$
declare t text;
declare fam_tables text[] := array[
  'calendar_events','school_events','sports_events','appointments',
  'chores','chore_assignments','rewards',
  'meals','meal_plans','grocery_lists','grocery_items',
  'medications','medication_schedules',
  'home_assets','maintenance_tasks',
  'documents','notes','goals','reminders',
  'ai_conversations','ai_messages'
];
begin
  foreach t in array fam_tables loop
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- ---------- profiles ----------
drop policy if exists profiles_select_self on public.profiles;
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select
  using (
    id = auth.uid()
    or exists (
      select 1 from public.family_members me
      join public.family_members them on them.family_id = me.family_id
      where me.user_id = auth.uid() and them.user_id = public.profiles.id
    )
  );
drop policy if exists profiles_upsert_self on public.profiles;
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert with check (id = auth.uid());
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update using (id = auth.uid());

-- ---------- families ----------
drop policy if exists families_select on public.families;
drop policy if exists families_select on public.families;
create policy families_select on public.families for select
  using (public.is_family_member(id));
drop policy if exists families_insert on public.families;
drop policy if exists families_insert on public.families;
create policy families_insert on public.families for insert
  with check (created_by = auth.uid());
drop policy if exists families_update on public.families;
drop policy if exists families_update on public.families;
create policy families_update on public.families for update
  using (public.can_manage_family(id));
drop policy if exists families_delete on public.families;
drop policy if exists families_delete on public.families;
create policy families_delete on public.families for delete
  using (public.is_family_admin(id));

-- ---------- family_members ----------
drop policy if exists fm_select on public.family_members;
drop policy if exists fm_select on public.family_members;
create policy fm_select on public.family_members for select
  using (public.is_family_member(family_id));
drop policy if exists fm_manage on public.family_members;
drop policy if exists fm_insert on public.family_members;
create policy fm_insert on public.family_members for insert
  with check (public.can_manage_family(family_id));
drop policy if exists fm_update on public.family_members;
create policy fm_update on public.family_members for update
  using (public.can_manage_family(family_id) or user_id = auth.uid());
drop policy if exists fm_delete on public.family_members;
create policy fm_delete on public.family_members for delete
  using (public.can_manage_family(family_id));

-- ---------- reference tables (read-only to all authenticated) ----------
drop policy if exists roles_read on public.roles;
drop policy if exists roles_read on public.roles;
create policy roles_read on public.roles for select using (auth.role() = 'authenticated');
drop policy if exists perms_read on public.permissions;
drop policy if exists perms_read on public.permissions;
create policy perms_read on public.permissions for select using (auth.role() = 'authenticated');

-- ---------- invites ----------
drop policy if exists invites_select on public.invites;
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select
  using (
    public.is_family_member(family_id)
    or lower(email) = lower(coalesce(auth.jwt()->>'email',''))
  );
drop policy if exists invites_manage on public.invites;
drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert
  with check (public.can_manage_family(family_id));
drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites for update
  using (public.can_manage_family(family_id)
         or lower(email) = lower(coalesce(auth.jwt()->>'email','')));
drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites for delete
  using (public.can_manage_family(family_id));

-- ---------- notifications (recipient-scoped or family broadcast) ----------
drop policy if exists notif_select on public.notifications;
drop policy if exists notif_select on public.notifications;
create policy notif_select on public.notifications for select
  using (user_id = auth.uid() or (user_id is null and public.is_family_member(family_id)));
drop policy if exists notif_insert on public.notifications;
drop policy if exists notif_insert on public.notifications;
create policy notif_insert on public.notifications for insert
  with check (public.is_family_member(family_id));
drop policy if exists notif_update on public.notifications;
drop policy if exists notif_update on public.notifications;
create policy notif_update on public.notifications for update
  using (user_id = auth.uid() or (user_id is null and public.is_family_member(family_id)));
drop policy if exists notif_delete on public.notifications;
drop policy if exists notif_delete on public.notifications;
create policy notif_delete on public.notifications for delete
  using (user_id = auth.uid() or public.can_manage_family(family_id));

-- ---------- audit_logs (members append; managers read) ----------
drop policy if exists audit_select on public.audit_logs;
drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select
  using (public.can_manage_family(family_id));
drop policy if exists audit_insert on public.audit_logs;
drop policy if exists audit_insert on public.audit_logs;
create policy audit_insert on public.audit_logs for insert
  with check (family_id is null or public.is_family_member(family_id));

-- ---------- billing + subscriptions (members read, admin manages) ----------
drop policy if exists billing_select on public.billing_customers;
drop policy if exists billing_select on public.billing_customers;
create policy billing_select on public.billing_customers for select
  using (public.is_family_member(family_id));
drop policy if exists billing_manage on public.billing_customers;
drop policy if exists billing_manage on public.billing_customers;
create policy billing_manage on public.billing_customers for all
  using (public.is_family_admin(family_id))
  with check (public.is_family_admin(family_id));

drop policy if exists subs_select on public.subscriptions;
drop policy if exists subs_select on public.subscriptions;
create policy subs_select on public.subscriptions for select
  using (public.is_family_member(family_id));
drop policy if exists subs_manage on public.subscriptions;
drop policy if exists subs_manage on public.subscriptions;
create policy subs_manage on public.subscriptions for all
  using (public.is_family_admin(family_id))
  with check (public.is_family_admin(family_id));

-- ---------- user_preferences (own only) ----------
drop policy if exists prefs_all on public.user_preferences;
drop policy if exists prefs_all on public.user_preferences;
create policy prefs_all on public.user_preferences for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());



-- ══════════ 0005_rpcs.sql ══════════
-- FamilyOS :: 0005 RPCs (callable from client via supabase.rpc)

-- Accept an invite by token: joins the caller to the family with the invited role.
-- SECURITY DEFINER because the new member is not yet a manager of the family.
create or replace function public.accept_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_invite public.invites;
  v_name   text;
begin
  select * into v_invite from public.invites
  where token = p_token and status = 'pending' and expires_at > now()
  for update;

  if not found then
    raise exception 'Invite is invalid or expired';
  end if;

  if lower(v_invite.email) <> lower(coalesce(auth.jwt()->>'email','')) then
    raise exception 'This invite was issued to a different email';
  end if;

  select coalesce(full_name, display_name, email) into v_name
  from public.profiles where id = auth.uid();

  insert into public.family_members (family_id, user_id, role, display_name)
  values (v_invite.family_id, auth.uid(), v_invite.role, coalesce(v_name,'Member'))
  on conflict (family_id, user_id) do update set is_active = true;

  update public.invites
    set status = 'accepted', accepted_by = auth.uid(), updated_at = now()
  where id = v_invite.id;

  update public.user_preferences
    set active_family_id = v_invite.family_id
  where user_id = auth.uid() and active_family_id is null;

  return v_invite.family_id;
end; $$;

-- Build/refresh a grocery list from a date range of the meal plan.
create or replace function public.grocery_from_meal_plan(
  p_family_id uuid, p_from date, p_to date, p_list_id uuid default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_list_id uuid := p_list_id;
  v_ing jsonb;
begin
  if not public.is_family_member(p_family_id) then
    raise exception 'Not a member of this family';
  end if;

  if v_list_id is null then
    insert into public.grocery_lists (family_id, name, created_by)
    values (p_family_id, 'From meal plan ' || p_from || '–' || p_to, auth.uid())
    returning id into v_list_id;
  end if;

  for v_ing in
    select jsonb_array_elements(m.ingredients) as ing
    from public.meal_plans mp
    join public.meals m on m.id = mp.meal_id
    where mp.family_id = p_family_id
      and mp.plan_date between p_from and p_to
      and m.ingredients is not null
  loop
    insert into public.grocery_items (family_id, list_id, name, quantity, created_by)
    values (p_family_id, v_list_id,
            coalesce(v_ing->>'name','item'), v_ing->>'qty', auth.uid());
  end loop;

  return v_list_id;
end; $$;

grant execute on function public.accept_invite(text) to authenticated;
grant execute on function public.grocery_from_meal_plan(uuid,date,date,uuid) to authenticated;



-- ══════════ 0006_financial_health_school_sports.sql ══════════
-- ============================================================
-- Migration 0006: Financial, Health, School & Sports tables
-- Run in Supabase SQL Editor to create all new tables
-- ============================================================

-- ── Enums ──────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE account_type AS ENUM ('checking', 'savings', 'credit', 'investment', 'retirement');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE transaction_type AS ENUM ('income', 'expense', 'transfer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE budget_period AS ENUM ('weekly', 'monthly', 'yearly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bill_status AS ENUM ('upcoming', 'paid', 'overdue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE metric_type AS ENUM ('steps', 'sleep_hours', 'heart_rate', 'calories', 'active_minutes', 'distance', 'weight', 'water_cups');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE game_result AS ENUM ('win', 'loss', 'tie');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE grade_type AS ENUM ('test', 'quiz', 'homework', 'project', 'final', 'participation', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Helper for timestamps ──────────────────────────────────
-- Reuse existing trigger function if available
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ============================================================
-- FINANCIAL TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS financial_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL,
  type account_type NOT NULL DEFAULT 'checking',
  institution text,
  last_four text,
  balance numeric(12,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_financial_accounts_family ON financial_accounts(family_id);
drop trigger if exists set_financial_accounts_updated on financial_accounts;
CREATE TRIGGER set_financial_accounts_updated BEFORE UPDATE ON financial_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  account_id uuid REFERENCES financial_accounts(id) ON DELETE SET NULL,
  name text NOT NULL,
  amount numeric(12,2) NOT NULL,
  category text,
  date date NOT NULL DEFAULT CURRENT_DATE,
  type transaction_type NOT NULL DEFAULT 'expense',
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transactions_family ON transactions(family_id);
CREATE INDEX IF NOT EXISTS idx_transactions_family_date ON transactions(family_id, date);
drop trigger if exists set_transactions_updated on transactions;
CREATE TRIGGER set_transactions_updated BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  category text NOT NULL,
  amount numeric(12,2) NOT NULL,
  period budget_period NOT NULL DEFAULT 'monthly',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_budgets_family ON budgets(family_id);
drop trigger if exists set_budgets_updated on budgets;
CREATE TRIGGER set_budgets_updated BEFORE UPDATE ON budgets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS bills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL,
  amount numeric(12,2) NOT NULL,
  due_date date NOT NULL,
  is_recurring boolean NOT NULL DEFAULT false,
  recurrence text DEFAULT 'none',
  status bill_status NOT NULL DEFAULT 'upcoming',
  category text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bills_family ON bills(family_id);
drop trigger if exists set_bills_updated on bills;
CREATE TRIGGER set_bills_updated BEFORE UPDATE ON bills FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS savings_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL,
  target_amount numeric(12,2) NOT NULL,
  current_amount numeric(12,2) NOT NULL DEFAULT 0,
  target_date date,
  emoji text DEFAULT '🎯',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_savings_goals_family ON savings_goals(family_id);
drop trigger if exists set_savings_goals_updated on savings_goals;
CREATE TRIGGER set_savings_goals_updated BEFORE UPDATE ON savings_goals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- HEALTH TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS health_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  type metric_type NOT NULL,
  value numeric(10,2) NOT NULL,
  unit text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_metrics_family ON health_metrics(family_id);
CREATE INDEX IF NOT EXISTS idx_health_metrics_member ON health_metrics(family_id, member_id);
CREATE INDEX IF NOT EXISTS idx_health_metrics_date ON health_metrics(family_id, recorded_at);

CREATE TABLE IF NOT EXISTS workout_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  activity text NOT NULL,
  duration_minutes int,
  calories int,
  distance numeric(8,2),
  notes text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workout_logs_family ON workout_logs(family_id);
CREATE INDEX IF NOT EXISTS idx_workout_logs_member ON workout_logs(family_id, member_id);
drop trigger if exists set_workout_logs_updated on workout_logs;
CREATE TRIGGER set_workout_logs_updated BEFORE UPDATE ON workout_logs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SCHOOL TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS school_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  subject text NOT NULL,
  teacher text,
  room text,
  time_slot text,
  day_of_week int, -- 0=Sunday, 1=Monday, etc.
  school_name text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_school_classes_family ON school_classes(family_id);
CREATE INDEX IF NOT EXISTS idx_school_classes_member ON school_classes(family_id, member_id);
drop trigger if exists set_school_classes_updated on school_classes;
CREATE TRIGGER set_school_classes_updated BEFORE UPDATE ON school_classes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS grades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  class_id uuid REFERENCES school_classes(id) ON DELETE SET NULL,
  subject text NOT NULL,
  title text,
  grade text,
  grade_type grade_type NOT NULL DEFAULT 'other',
  score numeric(5,2),
  max_score numeric(5,2) DEFAULT 100,
  date date NOT NULL DEFAULT CURRENT_DATE,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_grades_family ON grades(family_id);
CREATE INDEX IF NOT EXISTS idx_grades_member ON grades(family_id, member_id);
drop trigger if exists set_grades_updated on grades;
CREATE TRIGGER set_grades_updated BEFORE UPDATE ON grades FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- SPORTS TABLES
-- ============================================================

CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  sport text NOT NULL,
  team_name text NOT NULL,
  season text,
  coach text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_teams_family ON teams(family_id);
drop trigger if exists set_teams_updated on teams;
CREATE TRIGGER set_teams_updated BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS game_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  opponent text NOT NULL,
  our_score int NOT NULL DEFAULT 0,
  their_score int NOT NULL DEFAULT 0,
  date date NOT NULL DEFAULT CURRENT_DATE,
  result game_result NOT NULL,
  notes text,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_game_results_family ON game_results(family_id);
CREATE INDEX IF NOT EXISTS idx_game_results_team ON game_results(team_id);
drop trigger if exists set_game_results_updated on game_results;
CREATE TRIGGER set_game_results_updated BEFORE UPDATE ON game_results FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- RLS POLICIES FOR ALL NEW TABLES
-- ============================================================

DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'financial_accounts', 'transactions', 'budgets', 'bills', 'savings_goals',
    'health_metrics', 'workout_logs',
    'school_classes', 'grades',
    'teams', 'game_results'
  ])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Members can manage %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Members can manage %1$s" ON %1$I FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id))',
      tbl
    );
  END LOOP;
END $$;

-- ============================================================
-- Done! 11 new tables with indexes, triggers, and RLS policies.
-- ============================================================



-- ══════════ 0007_home_asset_warranties.sql ══════════
-- ============================================================
-- Migration 0007: Warranty storage for home assets
-- Links documents to home_assets and provisions the private
-- "documents" Storage bucket + folder-scoped RLS (family_id is the
-- first path segment), so warranty files are uploaded for real
-- instead of relying on a manually-created bucket.
-- ============================================================

-- ── documents.asset_id: link a document (e.g. a warranty PDF) to a home asset ──
ALTER TABLE documents ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES home_assets(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_documents_asset ON documents(asset_id);

-- ============================================================
-- STORAGE: private "documents" bucket, scoped per family folder
-- Path convention: {family_id}/{category}/{filename}
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('documents', 'documents', false, 26214400) -- 25 MB
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Family members can read their documents" ON storage.objects;
drop policy if exists "Family members can read their documents" on storage.objects;
CREATE POLICY "Family members can read their documents" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'documents'
    AND is_family_member(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "Family members can upload their documents" ON storage.objects;
drop policy if exists "Family members can upload their documents" on storage.objects;
CREATE POLICY "Family members can upload their documents" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'documents'
    AND is_family_member(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "Family members can update their documents" ON storage.objects;
drop policy if exists "Family members can update their documents" on storage.objects;
CREATE POLICY "Family members can update their documents" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'documents'
    AND is_family_member(((storage.foldername(name))[1])::uuid)
  );

DROP POLICY IF EXISTS "Family members can delete their documents" ON storage.objects;
drop policy if exists "Family members can delete their documents" on storage.objects;
CREATE POLICY "Family members can delete their documents" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'documents'
    AND is_family_member(((storage.foldername(name))[1])::uuid)
  );

-- ============================================================
-- Done! Warranty files upload to the real "documents" bucket,
-- tagged to a home asset via documents.asset_id.
-- ============================================================



-- ══════════ 0008_super_admins.sql ══════════
-- ============================================================
-- Migration 0008: Super Administrator (site-wide)
-- A super admin is identified by email, independent of family
-- membership — they oversee the whole site, not a single household.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.super_admins (
  email      text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS is enabled with NO policies on purpose: no client (including the
-- super admin's own session) may SELECT/INSERT/UPDATE/DELETE this table
-- directly. The only way in is the SECURITY DEFINER function below,
-- which only ever reveals a true/false answer about the caller.
ALTER TABLE public.super_admins ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.super_admins
    WHERE email = lower(coalesce(auth.jwt()->>'email', ''))
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

INSERT INTO public.super_admins (email)
VALUES ('daniel.hughen@gmail.com')
ON CONFLICT (email) DO NOTHING;



-- ══════════ 0009_medical_dental.sql ══════════
-- ============================================================
-- Migration 0009: Medical & Dental records
-- Providers (doctors/dentists), insurance policies, and per-member
-- medical profiles. One set of tables serves both the Medical and
-- Dental sections, discriminated by the record_kind enum.
-- Run in the Supabase SQL Editor.
-- ============================================================

-- ── Enum ───────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE record_kind AS ENUM ('medical', 'dental');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Reuse the shared updated_at trigger function ───────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ============================================================
-- PROVIDERS  (doctors / dentists)
-- member_id null = a whole-family provider (e.g. family physician).
-- ============================================================
CREATE TABLE IF NOT EXISTS health_providers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES family_members(id) ON DELETE SET NULL,
  kind          record_kind NOT NULL DEFAULT 'medical',
  name          text NOT NULL,
  specialty     text,
  practice_name text,
  phone         text,
  fax           text,
  email         text,
  address       text,
  is_primary    boolean NOT NULL DEFAULT false,
  notes         text,
  created_by    uuid REFERENCES auth.users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_providers_family ON health_providers(family_id, kind);
CREATE INDEX IF NOT EXISTS idx_health_providers_member ON health_providers(family_id, member_id);
drop trigger if exists set_health_providers_updated on health_providers;
CREATE TRIGGER set_health_providers_updated BEFORE UPDATE ON health_providers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- INSURANCE POLICIES  (medical or dental)
-- member_id null = covers the whole family.
-- Card photos live in the private "documents" Storage bucket;
-- we keep only the object path here.
-- ============================================================
CREATE TABLE IF NOT EXISTS insurance_policies (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id              uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id              uuid REFERENCES family_members(id) ON DELETE SET NULL,
  kind                   record_kind NOT NULL DEFAULT 'medical',
  insurer                text NOT NULL,
  plan_name              text,
  plan_type              text,
  policy_number          text,
  group_number           text,
  rx_bin                 text,
  rx_pcn                 text,
  rx_group               text,
  customer_service_phone text,
  front_image_path       text,
  back_image_path        text,
  effective_date         date,
  is_primary             boolean NOT NULL DEFAULT true,
  notes                  text,
  created_by             uuid REFERENCES auth.users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_family ON insurance_policies(family_id, kind);
CREATE INDEX IF NOT EXISTS idx_insurance_policies_member ON insurance_policies(family_id, member_id);
drop trigger if exists set_insurance_policies_updated on insurance_policies;
CREATE TRIGGER set_insurance_policies_updated BEFORE UPDATE ON insurance_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- MEDICAL PROFILES  (one row per member; shared by both sections)
-- Holds the history copied onto every check-in form.
-- ============================================================
CREATE TABLE IF NOT EXISTS medical_profiles (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id                  uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id                  uuid NOT NULL UNIQUE REFERENCES family_members(id) ON DELETE CASCADE,
  blood_type                 text,
  allergies                  text,
  conditions                 text,
  current_medications        text,
  primary_physician          text,
  preferred_pharmacy         text,
  pharmacy_phone             text,
  emergency_contact_name     text,
  emergency_contact_phone    text,
  emergency_contact_relation text,
  immunizations              text,
  dental_notes               text,
  notes                      text,
  updated_by                 uuid REFERENCES auth.users(id),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_medical_profiles_family ON medical_profiles(family_id);
drop trigger if exists set_medical_profiles_updated on medical_profiles;
CREATE TRIGGER set_medical_profiles_updated BEFORE UPDATE ON medical_profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- RLS — everyone in the family can READ; only parents/adults can WRITE.
-- This is what enforces "children view their own info read-only" at the
-- database boundary (can_manage_family => role in parent/adult).
-- ============================================================
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['health_providers', 'insurance_policies', 'medical_profiles'])
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);

    EXECUTE format('DROP POLICY IF EXISTS "Members can read %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Members can read %1$s" ON %1$I FOR SELECT TO authenticated USING (is_family_member(family_id))',
      tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS "Managers can insert %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Managers can insert %1$s" ON %1$I FOR INSERT TO authenticated WITH CHECK (can_manage_family(family_id))',
      tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS "Managers can update %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Managers can update %1$s" ON %1$I FOR UPDATE TO authenticated USING (can_manage_family(family_id)) WITH CHECK (can_manage_family(family_id))',
      tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS "Managers can delete %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Managers can delete %1$s" ON %1$I FOR DELETE TO authenticated USING (can_manage_family(family_id))',
      tbl
    );
  END LOOP;
END $$;

-- ============================================================
-- Done! 3 new tables (health_providers, insurance_policies,
-- medical_profiles) + record_kind enum, with indexes, triggers,
-- and read-all / write-managers RLS.
-- ============================================================



-- ══════════ 0010_blog_posts.sql ══════════
-- ============================================================
-- Migration 0010: Blog posts (CMS content moved into Supabase)
-- Replaces the hardcoded lib/blog/posts.ts dataset with a real
-- table. Public marketing /blog routes read published posts via
-- RLS (anon + authenticated SELECT where published = true).
-- Writes are service-role only (no write policy → RLS denies).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.blog_posts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text NOT NULL UNIQUE,
  title           text NOT NULL,
  excerpt         text NOT NULL DEFAULT '',
  author          text NOT NULL DEFAULT 'The FamilyOS Team',
  published_at    date NOT NULL DEFAULT current_date,
  reading_minutes integer NOT NULL DEFAULT 5,
  tags            text[] NOT NULL DEFAULT '{}',
  category        text NOT NULL,
  featured        boolean NOT NULL DEFAULT false,
  accent_color    text,
  body            jsonb NOT NULL DEFAULT '[]'::jsonb,
  published       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_published ON public.blog_posts (published, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_posts_category ON public.blog_posts (category);

-- keep updated_at fresh (reuses the shared trigger fn from 0003)
DROP TRIGGER IF EXISTS trg_blog_posts_updated_at ON public.blog_posts;
drop trigger if exists trg_blog_posts_updated_at on public.blog_posts;
CREATE TRIGGER trg_blog_posts_updated_at
  BEFORE UPDATE ON public.blog_posts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: published posts are world-readable; writes are service-role only ──
ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read published blog posts" ON public.blog_posts;
drop policy if exists "Anyone can read published blog posts" on public.blog_posts;
CREATE POLICY "Anyone can read published blog posts" ON public.blog_posts
  FOR SELECT TO anon, authenticated
  USING (published = true);

GRANT SELECT ON public.blog_posts TO anon, authenticated;

-- ── Seed the existing 11 posts (idempotent on slug) ──
INSERT INTO public.blog_posts (slug, title, excerpt, author, published_at, reading_minutes, tags, category, featured, accent_color, body)
VALUES
  (
    'an-ai-chief-of-staff-for-your-home',
    'The AI Family Assistant: A New Way to Stay Ahead of Everything',
    'From school emails to soccer practice, see how AI can help your family stay organized, stress-free, and always one step ahead.',
    'Jessica Miller', '2024-05-12', 6, ARRAY['ai','product'], 'AI & Technology', true, '#7c5dff',
    $json$[
      {"type":"p","text":"Chatbots answer questions. A chief of staff gets things done. That distinction is the whole idea behind the FamilyOS assistant."},
      {"type":"h2","text":"From words to records"},
      {"type":"p","text":"Ask it to add soccer every Tuesday and it creates the recurring event. Ask it to plan dinners and build a grocery list, and it writes real rows into your family's database."}
    ]$json$::jsonb
  ),
  (
    'sync-family-schedule',
    'How to Sync Your Family''s Schedule (Without the Chaos)',
    'A practical guide to keeping everyone on the same page — from soccer practice to dentist appointments.',
    'The FamilyOS Team', '2024-05-10', 5, ARRAY['organization'], 'Organization', false, '#3b82f6',
    $json$[{"type":"p","text":"Every household runs on a hidden layer of coordination. Here's how to make it visible and shared."}]$json$::jsonb
  ),
  (
    'last-day-school-checklist',
    'Last-Day-of-School Checklist: Don''t Miss a Thing',
    'Return the library books, pick up art projects, say goodbye to teachers — a complete end-of-year checklist.',
    'The FamilyOS Team', '2024-05-09', 4, ARRAY['school'], 'School & Activities', false, '#10b981',
    $json$[{"type":"p","text":"The last week of school is a whirlwind. Here's how to get through it without forgetting anything."}]$json$::jsonb
  ),
  (
    'healthy-family-habits',
    'Healthy Family Habits That Stick (Even on Busy Weeks)',
    'Small rituals that make a big difference — and how to actually maintain them when life gets hectic.',
    'The FamilyOS Team', '2024-05-07', 6, ARRAY['wellness'], 'Wellness', false, '#f59e0b',
    $json$[{"type":"p","text":"The habits that stick are the ones that require the least willpower."}]$json$::jsonb
  ),
  (
    'family-budget-basics',
    'Budgeting as a Family: 5 Simple Steps to Get Started',
    'Money conversations don''t have to be stressful. Here''s a framework that actually works for busy families.',
    'The FamilyOS Team', '2024-05-04', 5, ARRAY['finances'], 'Family Finances', false, '#ec4899',
    $json$[{"type":"p","text":"Starting a family budget feels overwhelming. Break it into five simple steps."}]$json$::jsonb
  ),
  (
    'ai-family-life',
    '5 Ways AI Can Make Family Life So Much Easier',
    'From meal planning to homework help, AI is quietly transforming how modern families operate.',
    'The FamilyOS Team', '2024-05-02', 6, ARRAY['ai'], 'AI & Technology', false, '#7c5dff',
    $json$[{"type":"p","text":"AI isn't just for tech companies. Here are five practical ways it's changing family life."}]$json$::jsonb
  ),
  (
    'quality-time',
    'How to Create More Quality Time (Without More Time)',
    'The secret isn''t finding more hours. It''s making the hours you have count.',
    'The FamilyOS Team', '2024-04-30', 6, ARRAY['parenting','wellness'], 'Parenting', false, '#f97316',
    $json$[{"type":"p","text":"Most parents already know how precious time with their kids is. The challenge is protecting it."}]$json$::jsonb
  ),
  (
    'taming-the-family-mental-load',
    'Taming the family mental load',
    'The invisible work of running a household is real. Here''s how to share it.',
    'The FamilyOS Team', '2026-05-02', 4, ARRAY['organization','parenting'], 'Parenting', false, NULL,
    $json$[{"type":"p","text":"Every household runs on a hidden layer of coordination."}]$json$::jsonb
  ),
  (
    'meal-planning-that-actually-sticks',
    'Meal planning that actually sticks',
    'A simple weekly rhythm — and how to make the grocery list build itself.',
    'The FamilyOS Team', '2026-05-18', 3, ARRAY['meals','routines'], 'Organization', false, NULL,
    $json$[{"type":"p","text":"Most meal-planning systems fail because they're too much work."}]$json$::jsonb
  )
ON CONFLICT (slug) DO NOTHING;

-- ============================================================
-- Done! Blog content now lives in Supabase. The /blog routes read
-- from public.blog_posts; lib/blog/posts.ts is now a data-access layer.
-- ============================================================



-- ══════════ 0010_support_tickets_admin_users.sql ══════════
-- ================================================================
-- Migration 0010: Support Tickets & Admin Users
-- ================================================================

-- ── support_tickets ─────────────────────────────────────────────
create table if not exists public.support_tickets (
  id               uuid        primary key default gen_random_uuid(),
  ticket_number    text        unique not null,
  subject          text        not null,
  description      text,
  category         text        not null default 'general',
    -- 'technical' | 'billing' | 'account' | 'family' | 'general' | 'feature_request'
  priority         text        not null default 'medium',
    -- 'low' | 'medium' | 'high' | 'urgent'
  status           text        not null default 'open',
    -- 'open' | 'in_progress' | 'pending' | 'resolved' | 'closed'
  requester_id     uuid        references auth.users(id) on delete set null,
  requester_name   text,
  requester_email  text        not null,
  assigned_agent_id uuid       references auth.users(id) on delete set null,
  assigned_agent_name text,
  family_id        uuid        references public.families(id) on delete set null,
  tags             text[]      not null default '{}',
  resolution_note  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  closed_at        timestamptz
);

-- ── RECONCILE a pre-existing, older-shaped support_tickets ──────────────────
-- A drifted prod DB may already have support_tickets in migration 0012's
-- CONTACT-FORM shape (name/email/message/source, no ticket_number). CREATE TABLE
-- IF NOT EXISTS above then skips, so the seed INSERT + the app's inserts (which
-- use the 0010 admin shape: ticket_number/requester_email/description/…) fail on
-- the missing columns. Bring any existing table UP to the 0010 shape, additively.
alter table public.support_tickets add column if not exists ticket_number     text;
alter table public.support_tickets add column if not exists description        text;
alter table public.support_tickets add column if not exists category          text not null default 'general';
alter table public.support_tickets add column if not exists priority          text not null default 'medium';
alter table public.support_tickets add column if not exists status            text not null default 'open';
alter table public.support_tickets add column if not exists requester_id      uuid;
alter table public.support_tickets add column if not exists requester_name    text;
alter table public.support_tickets add column if not exists requester_email   text;
alter table public.support_tickets add column if not exists assigned_agent_id uuid;
alter table public.support_tickets add column if not exists assigned_agent_name text;
alter table public.support_tickets add column if not exists family_id         uuid;
alter table public.support_tickets add column if not exists tags              text[] not null default '{}';
alter table public.support_tickets add column if not exists resolution_note   text;
alter table public.support_tickets add column if not exists resolved_at       timestamptz;
alter table public.support_tickets add column if not exists closed_at         timestamptz;
-- The 0012 shape's `email` is NOT NULL with no default and the app no longer sets
-- it (uses requester_email) — relax it so the new inserts don't null-violate. Only
-- if the legacy column is actually present.
do $$
declare c record;
begin
  if exists (select 1 from information_schema.columns
             where table_schema='public' and table_name='support_tickets' and column_name='email') then
    execute 'alter table public.support_tickets alter column email drop not null';
  end if;
  -- The 0012 shape adds CHECK constraints (e.g. status IN ('open','pending',
  -- 'resolved','closed')) that reject the 0010 seed's values ('in_progress', …).
  -- The 0010 admin shape puts NO CHECKs on these columns, so drop every CHECK on
  -- support_tickets — a no-op on a fresh DB, drift-clearing on prod.
  for c in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public' and rel.relname = 'support_tickets' and con.contype = 'c'
  loop
    execute format('alter table public.support_tickets drop constraint %I', c.conname);
  end loop;
end $$;
-- ON CONFLICT (ticket_number) needs a unique index; the fresh-DB path gets it via
-- the column's UNIQUE constraint (same name → IF NOT EXISTS skips the dup).
create unique index if not exists support_tickets_ticket_number_key on public.support_tickets (ticket_number);

-- auto-update updated_at
create or replace function public.set_support_ticket_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists trg_support_tickets_updated_at on public.support_tickets;
create trigger trg_support_tickets_updated_at
  before update on public.support_tickets
  for each row execute function public.set_support_ticket_updated_at();

-- sequential ticket number generator
create sequence if not exists public.support_ticket_seq;

-- RLS: only service-role (admin console) reads/writes
alter table public.support_tickets enable row level security;
drop policy if exists "service_role_all" on public.support_tickets;
create policy "service_role_all" on public.support_tickets
  using (true) with check (true);

-- ── admin_users ──────────────────────────────────────────────────
create table if not exists public.admin_users (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        references auth.users(id) on delete cascade,
  email         text        not null unique,
  full_name     text,
  avatar_url    text,
  admin_role    text        not null default 'administrator',
    -- 'super_administrator' | 'administrator' | 'content_manager'
    -- | 'billing_manager'  | 'moderator'     | 'viewer'
  permissions   text[]      not null default '{}',
  status        text        not null default 'pending',
    -- 'active' | 'inactive' | 'pending'
  last_active_at timestamptz,
  joined_at     timestamptz not null default now(),
  created_at    timestamptz not null default now()
);

alter table public.admin_users enable row level security;
drop policy if exists "service_role_all" on public.admin_users;
create policy "service_role_all" on public.admin_users
  using (true) with check (true);

-- ── seed sample support tickets ──────────────────────────────────
insert into public.support_tickets
  (ticket_number, subject, category, priority, status,
   requester_name, requester_email, assigned_agent_name, updated_at)
values
  ('TKT-2024-0514-001','Can''t access Family Dashboard','account','high','open',
   'John Smith','john.smith@email.com','Sarah Johnson',
   '2024-05-14 10:24:00+00'),
  ('TKT-2024-0514-002','Payment failed but amount was deducted','billing','high','in_progress',
   'Lisa Brown','lisa.brown@email.com','Michael Davis',
   '2024-05-14 09:58:00+00'),
  ('TKT-2024-0514-003','Request refund for cancelled subscription','billing','medium','pending',
   'Emily Wilson','emily.w@email.com','Jessica Lee',
   '2024-05-14 09:32:00+00'),
  ('TKT-2024-0514-004','Unable to add family member','family','medium','open',
   'Robert Taylor','robert.t@email.com','David Wilson',
   '2024-05-14 08:45:00+00'),
  ('TKT-2024-0514-005','Content not playing on Apple TV','technical','low','in_progress',
   'Amanda Clark','amanda.c@email.com','Kevin Patel',
   '2024-05-14 07:21:00+00'),
  ('TKT-2024-0513-009','How do I set screen time limits?','general','low','resolved',
   'Daniel Martinez','daniel.m@email.com','Sarah Johnson',
   '2024-05-13 23:47:00+00'),
  ('TKT-2024-0513-008','App keeps logging me out','account','high','open',
   'Olivia Anderson','olivia.a@email.com','Michael Davis',
   '2024-05-13 22:30:00+00'),
  ('TKT-2024-0513-007','Unable to update payment method','billing','medium','pending',
   'Kevin Thomas','kevin.t@email.com','Jessica Lee',
   '2024-05-13 20:12:00+00'),
  ('TKT-2024-0513-006','Feature request: Dark mode for kids app','feature_request','low','open',
   'Sophia Garcia','sophia.g@email.com',null,
   '2024-05-13 18:05:00+00'),
  ('TKT-2024-0513-005','Parental controls not working properly','technical','high','in_progress',
   'Brian White','brian.w@email.com','Kevin Patel',
   '2024-05-13 16:20:00+00')
on conflict (ticket_number) do nothing;

-- ── seed sample admin users ───────────────────────────────────────
insert into public.admin_users
  (email, full_name, admin_role, permissions, status, last_active_at, joined_at)
values
  ('admin@familyos.com','Admin User','super_administrator',
   ARRAY['All Access'],'active','2024-05-14 10:24:00+00','2024-01-15 09:30:00+00'),
  ('michael.davis@familyos.com','Michael Davis','administrator',
   ARRAY['User','Content','Reports','Billing'],'active','2024-05-14 09:58:00+00','2024-02-10 11:20:00+00'),
  ('sarah.johnson@familyos.com','Sarah Johnson','administrator',
   ARRAY['User','Content','Security','Reports'],'active','2024-05-14 09:32:00+00','2024-02-18 14:15:00+00'),
  ('james.wilson@familyos.com','James Wilson','administrator',
   ARRAY['User','Billing','Support'],'active','2024-05-14 08:45:00+00','2024-03-01 10:10:00+00'),
  ('emily.brown@familyos.com','Emily Brown','administrator',
   ARRAY['Content','Reports','Support'],'active','2024-05-13 21:00:00+00','2024-03-12 09:45:00+00'),
  ('david.wilson@familyos.com','David Wilson','administrator',
   ARRAY['User','Support'],'active','2024-05-13 18:30:00+00','2024-03-20 13:00:00+00'),
  ('jessica.lee@familyos.com','Jessica Lee','content_manager',
   ARRAY['Content Management'],'active','2024-05-13 17:00:00+00','2024-04-05 15:40:00+00'),
  ('kevin.patel@familyos.com','Kevin Patel','billing_manager',
   ARRAY['Billing','Payments','Reports'],'active','2024-05-13 16:20:00+00','2024-04-12 11:25:00+00'),
  ('olivia.martinez@familyos.com','Olivia Martinez','moderator',
   ARRAY['Support','User Management'],'active','2024-05-12 21:15:00+00','2024-04-20 14:55:00+00'),
  ('robert.taylor@familyos.com','Robert Taylor','viewer',
   ARRAY['Reports (View Only)'],'inactive','2024-05-10 10:05:00+00','2024-04-28 09:00:00+00'),
  ('amanda.clark@familyos.com','Amanda Clark','content_manager',
   ARRAY['Content Management'],'pending',null,'2024-05-13 15:30:00+00'),
  ('brian.white@familyos.com','Brian White','administrator',
   ARRAY['User','Security','Reports'],'pending',null,'2024-05-14 08:10:00+00')
on conflict (email) do nothing;



-- ══════════ 0011_public_stats.sql ══════════
-- ============================================================
-- Migration 0011: public_stats() — safe aggregate counts for the
-- public marketing site. Returns ONLY non-identifying totals so the
-- landing/pricing pages can show real numbers instead of a hardcoded
-- "10,000+ families". SECURITY DEFINER so anon can read aggregates
-- without any row-level access to the underlying tables.
-- ============================================================

-- Replay-safety: this function references task_status 'done', which historic
-- databases gained out-of-band (formally backfilled in 0103). Adding it here
-- idempotently keeps a fresh `db reset` replayable; it is a no-op on prod.
ALTER TYPE public.task_status ADD VALUE IF NOT EXISTS 'done';

CREATE OR REPLACE FUNCTION public.public_stats()
RETURNS TABLE (families bigint, members bigint, tasks_completed bigint)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT
    (SELECT count(*) FROM public.families),
    (SELECT count(*) FROM public.family_members WHERE is_active = true),
    (SELECT count(*) FROM public.chore_assignments WHERE status IN ('approved','done'));
$$;

REVOKE ALL ON FUNCTION public.public_stats() FROM public;
GRANT EXECUTE ON FUNCTION public.public_stats() TO anon, authenticated;

-- ============================================================
-- Done! Marketing pages call supabase.rpc('public_stats') to render
-- real family/member counts.
-- ============================================================



-- ══════════ 0012_support_tickets.sql ══════════
-- ============================================================
-- Migration 0012: Support tickets
-- Backs the Admin Dashboard "Support Overview" panel with real data.
-- Rows are created server-side from the public contact form (service
-- role) and read only by the super admin via the service-role client.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.support_tickets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL DEFAULT '',
  email      text NOT NULL,
  subject    text NOT NULL DEFAULT '',
  message    text NOT NULL DEFAULT '',
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'resolved', 'closed')),
  source     text NOT NULL DEFAULT 'contact',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON public.support_tickets (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON public.support_tickets;
drop trigger if exists trg_support_tickets_updated_at on public.support_tickets;
CREATE TRIGGER trg_support_tickets_updated_at
  BEFORE UPDATE ON public.support_tickets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS on with NO policies: no client session can read or write directly.
-- Inserts come from the contact API via the service-role client, and the
-- super admin reads via the service-role client in the admin console — both
-- bypass RLS. This keeps support messages off-limits to ordinary users.
ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Contact-form submissions now land in support_tickets.
-- ============================================================



-- ══════════ 0013_marketing.sql ══════════
-- ============================================================
-- Migration 0013: Admin Marketing module
-- Backs /admin/marketing. Every table follows the same security model as
-- super_admins / support_tickets: RLS is ENABLED with NO policies, so no
-- client session can read or write directly. All access happens through the
-- service-role client in the super-admin-gated admin console (which bypasses
-- RLS). This keeps marketing data fully admin-only.
--
-- "Customers" in FamilyOS are existing families/subscriptions/contacts — those
-- are NOT duplicated here; the marketing customer view is derived at read time
-- from the existing tables. These tables store marketing-specific objects only.
-- ============================================================

-- ---------- Segments ----------
CREATE TABLE IF NOT EXISTS public.marketing_segments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  kind        text NOT NULL DEFAULT 'dynamic' CHECK (kind IN ('dynamic', 'static')),
  -- Dynamic segments store their rule; static segments store an explicit list.
  rules       jsonb NOT NULL DEFAULT '{}'::jsonb,
  member_keys text[] NOT NULL DEFAULT '{}',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_segments_status ON public.marketing_segments (status, created_at DESC);

-- ---------- Campaigns ----------
CREATE TABLE IF NOT EXISTS public.marketing_campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  objective    text,
  channel      text NOT NULL DEFAULT 'email'
                 CHECK (channel IN ('email','sms','social','ads','seo','aeo','content','referral','multi')),
  type         text NOT NULL DEFAULT 'campaign'
                 CHECK (type IN ('campaign','launch','re_engagement','win_back','referral','fundraising','retargeting')),
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','scheduled','active','paused','completed','archived')),
  segment_id   uuid REFERENCES public.marketing_segments(id) ON DELETE SET NULL,
  budget_cents integer NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  starts_at    timestamptz,
  ends_at      timestamptz,
  notes        text,
  kpis         jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_campaigns_status ON public.marketing_campaigns (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_campaigns_channel ON public.marketing_campaigns (channel);

-- ---------- Email campaigns ----------
CREATE TABLE IF NOT EXISTS public.marketing_email_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid REFERENCES public.marketing_campaigns(id) ON DELETE CASCADE,
  segment_id    uuid REFERENCES public.marketing_segments(id) ON DELETE SET NULL,
  subject       text NOT NULL DEFAULT '',
  preview_text  text,
  body_html     text NOT NULL DEFAULT '',
  from_name     text,
  status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','scheduled','sending','sent','failed')),
  scheduled_at  timestamptz,
  sent_at       timestamptz,
  recipients    integer NOT NULL DEFAULT 0,
  opens         integer NOT NULL DEFAULT 0,
  clicks        integer NOT NULL DEFAULT 0,
  bounces       integer NOT NULL DEFAULT 0,
  unsubscribes  integer NOT NULL DEFAULT 0,
  provider_ref  text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_email_campaign ON public.marketing_email_campaigns (campaign_id);
CREATE INDEX IF NOT EXISTS idx_mkt_email_status ON public.marketing_email_campaigns (status, created_at DESC);

-- ---------- Content items (calendar + briefs) ----------
CREATE TABLE IF NOT EXISTS public.marketing_content_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  title        text NOT NULL,
  kind         text NOT NULL DEFAULT 'blog'
                 CHECK (kind IN ('blog','landing','social','email','ad','seo_brief','aeo_brief')),
  channel      text,
  brief        text,
  body         text,
  status       text NOT NULL DEFAULT 'idea'
                 CHECK (status IN ('idea','brief','drafting','review','approved','published')),
  publish_at   timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_content_status ON public.marketing_content_items (status, publish_at);

-- ---------- SEO pages ----------
CREATE TABLE IF NOT EXISTS public.marketing_seo_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  path             text NOT NULL UNIQUE,
  title            text,
  meta_description text,
  issues           jsonb NOT NULL DEFAULT '[]'::jsonb,
  score            integer CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','noindex','archived')),
  last_audited_at  timestamptz,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------- SEO keywords (first-party tracking; AI ideas flagged in metadata) ----------
CREATE TABLE IF NOT EXISTS public.marketing_seo_keywords (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword     text NOT NULL,
  intent      text CHECK (intent IS NULL OR intent IN ('informational','navigational','commercial','transactional')),
  target_path text,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai_suggestion','search_console')),
  status      text NOT NULL DEFAULT 'tracking' CHECK (status IN ('idea','tracking','won','dropped')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (keyword, target_path)
);
CREATE INDEX IF NOT EXISTS idx_mkt_seo_keywords_status ON public.marketing_seo_keywords (status);

-- ---------- AEO questions/answers ----------
CREATE TABLE IF NOT EXISTS public.marketing_aeo_questions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question       text NOT NULL,
  answer         text,
  entity         text,
  source_path    text,
  pattern        text CHECK (pattern IS NULL OR pattern IN ('what_is','how_to','best_x_for_y','comparison','faq','local')),
  status         text NOT NULL DEFAULT 'opportunity'
                   CHECK (status IN ('opportunity','drafting','answered','published')),
  clarity_score  integer CHECK (clarity_score IS NULL OR (clarity_score BETWEEN 0 AND 100)),
  last_reviewed  timestamptz,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_aeo_status ON public.marketing_aeo_questions (status);

-- ---------- Settings (key/value) ----------
CREATE TABLE IF NOT EXISTS public.marketing_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Marketing audit log ----------
CREATE TABLE IF NOT EXISTS public.marketing_audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email text,
  action      text NOT NULL,
  resource    text NOT NULL,
  resource_id text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_audit_created ON public.marketing_audit_logs (created_at DESC);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'marketing_segments','marketing_campaigns','marketing_email_campaigns',
    'marketing_content_items','marketing_seo_pages','marketing_seo_keywords',
    'marketing_aeo_questions'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_set_updated_at ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- RLS: enabled, NO policies (service-role / admin console only) ----------
ALTER TABLE public.marketing_segments        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_campaigns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_content_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_seo_pages       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_seo_keywords    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_aeo_questions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_settings        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_audit_logs      ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Admin Marketing tables created (admin-only via service role).
-- ============================================================



-- ══════════ 0014_core_platform.sql ══════════
-- ============================================================
-- 0014_core_platform.sql
-- FamilyOS Core Platform: Messenger · Photos · Contacts ·
--   Reminders · Recipes · Shopping Lists
-- ============================================================

-- ── Family Conversations (Messenger) ────────────────────────
create table if not exists public.family_conversations (
  id           uuid        primary key default gen_random_uuid(),
  family_id    uuid        references public.families(id) on delete cascade not null,
  name         text,
  kind         text        not null default 'group' check (kind in ('group','direct')),
  avatar_emoji text        default '💬',
  member_ids   uuid[]      not null default '{}',
  created_by   uuid        references auth.users(id) on delete set null,
  last_message_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_family_conversations_family on public.family_conversations(family_id);

alter table public.family_conversations enable row level security;
drop policy if exists "family members can manage conversations" on public.family_conversations;
create policy "family members can manage conversations"
  on public.family_conversations for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Family Messages ──────────────────────────────────────────
create table if not exists public.family_messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        references public.family_conversations(id) on delete cascade not null,
  family_id       uuid        references public.families(id) on delete cascade not null,
  sender_id       uuid        references auth.users(id) on delete set null,
  sender_name     text,
  sender_avatar   text,
  content         text,
  kind            text        not null default 'text' check (kind in ('text','image','file','voice','poll','announcement')),
  attachment_url  text,
  attachment_name text,
  attachment_mime text,
  reply_to_id     uuid        references public.family_messages(id) on delete set null,
  reactions       jsonb       not null default '{}',
  read_by         uuid[]      not null default '{}',
  is_pinned       boolean     not null default false,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_family_messages_conversation on public.family_messages(conversation_id, created_at desc);
create index if not exists idx_family_messages_family on public.family_messages(family_id);

alter table public.family_messages enable row level security;
drop policy if exists "family members can manage messages" on public.family_messages;
create policy "family members can manage messages"
  on public.family_messages for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Family Albums ────────────────────────────────────────────
create table if not exists public.family_albums (
  id           uuid        primary key default gen_random_uuid(),
  family_id    uuid        references public.families(id) on delete cascade not null,
  name         text        not null,
  description  text,
  cover_url    text,
  kind         text        not null default 'general'
               check (kind in ('general','vacation','school','sports','milestones','holiday','birthday','other')),
  is_shared    boolean     not null default true,
  photo_count  int         not null default 0,
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_family_albums_family on public.family_albums(family_id);

alter table public.family_albums enable row level security;
drop policy if exists "family members can manage albums" on public.family_albums;
create policy "family members can manage albums"
  on public.family_albums for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Family Photos ────────────────────────────────────────────
create table if not exists public.family_photos (
  id           uuid        primary key default gen_random_uuid(),
  family_id    uuid        references public.families(id) on delete cascade not null,
  album_id     uuid        references public.family_albums(id) on delete set null,
  uploaded_by  uuid        references auth.users(id) on delete set null,
  storage_path text        not null,
  url          text,
  thumbnail_url text,
  caption      text,
  taken_at     timestamptz,
  width        int,
  height       int,
  size_bytes   bigint,
  tags         text[]      not null default '{}',
  member_tags  uuid[]      not null default '{}',
  is_favorite  boolean     not null default false,
  metadata     jsonb       not null default '{}',
  created_at   timestamptz not null default now()
);

create index if not exists idx_family_photos_album on public.family_photos(album_id, created_at desc);
create index if not exists idx_family_photos_family on public.family_photos(family_id, created_at desc);

alter table public.family_photos enable row level security;
drop policy if exists "family members can manage photos" on public.family_photos;
create policy "family members can manage photos"
  on public.family_photos for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- keep album photo_count in sync
create or replace function public.sync_album_photo_count()
returns trigger language plpgsql security definer as $$
begin
  if (TG_OP = 'INSERT') then
    update public.family_albums set photo_count = photo_count + 1, updated_at = now() where id = NEW.album_id;
  elsif (TG_OP = 'DELETE') then
    update public.family_albums set photo_count = greatest(0, photo_count - 1), updated_at = now() where id = OLD.album_id;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_sync_album_photo_count on public.family_photos;
drop trigger if exists trg_sync_album_photo_count on public.family_photos;
create trigger trg_sync_album_photo_count
  after insert or delete on public.family_photos
  for each row execute function public.sync_album_photo_count();

-- ── Family Contacts ──────────────────────────────────────────
create table if not exists public.family_contacts (
  id               uuid        primary key default gen_random_uuid(),
  family_id        uuid        references public.families(id) on delete cascade not null,
  name             text        not null,
  relationship     text        not null default 'other',
  category         text        not null default 'other'
                   check (category in ('emergency','family','doctor','dentist','teacher','coach','babysitter','neighbor','work','friend','other')),
  phone            text,
  phone_alt        text,
  email            text,
  address          text,
  notes            text,
  photo_url        text,
  is_emergency     boolean     not null default false,
  birthday_month   int         check (birthday_month between 1 and 12),
  birthday_day     int         check (birthday_day between 1 and 31),
  tags             text[]      not null default '{}',
  linked_member_id uuid        references public.family_members(id) on delete set null,
  specialty        text,
  organization     text,
  created_by       uuid        references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists idx_family_contacts_family on public.family_contacts(family_id);
create index if not exists idx_family_contacts_emergency on public.family_contacts(family_id, is_emergency) where is_emergency = true;

alter table public.family_contacts enable row level security;
drop policy if exists "family members can manage contacts" on public.family_contacts;
create policy "family members can manage contacts"
  on public.family_contacts for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Family Reminders ─────────────────────────────────────────
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

-- ── Family Recipes ───────────────────────────────────────────
create table if not exists public.family_recipes (
  id                  uuid        primary key default gen_random_uuid(),
  family_id           uuid        references public.families(id) on delete cascade not null,
  name                text        not null,
  description         text,
  category            text        not null default 'dinner'
                      check (category in ('breakfast','lunch','dinner','snack','dessert','drink','side','appetizer','other')),
  cuisine             text,
  servings            int         not null default 4,
  prep_time_mins      int,
  cook_time_mins      int,
  difficulty          text        not null default 'medium' check (difficulty in ('easy','medium','hard')),
  ingredients         jsonb       not null default '[]',
  instructions        jsonb       not null default '[]',
  notes               text,
  photo_url           text,
  tags                text[]      not null default '{}',
  allergy_flags       text[]      not null default '{}',
  is_favorite         boolean     not null default false,
  is_public           boolean     not null default false,
  rating              int         check (rating between 1 and 5),
  times_made          int         not null default 0,
  last_made_at        timestamptz,
  source_url          text,
  ai_generated        boolean     not null default false,
  estimated_cost_cents int,
  created_by          uuid        references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_family_recipes_family on public.family_recipes(family_id, category);

alter table public.family_recipes enable row level security;
drop policy if exists "family members can manage recipes" on public.family_recipes;
create policy "family members can manage recipes"
  on public.family_recipes for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

-- ── Shopping Lists (multi-store) ─────────────────────────────
-- Extends existing grocery_lists / grocery_items with richer metadata.
-- We add columns if not present, then add the new family_shopping_lists
-- table for lists beyond the default grocery list.

alter table public.grocery_lists
  add column if not exists store       text,
  add column if not exists list_icon   text default '🛒',
  add column if not exists list_color  text default '#7c5dfa',
  add column if not exists sort_order  int  default 0,
  add column if not exists archived_at timestamptz;

alter table public.grocery_items
  add column if not exists quantity_unit  text,
  add column if not exists price_cents    int,
  add column if not exists assigned_to_id uuid references auth.users(id) on delete set null,
  add column if not exists note           text,
  add column if not exists sort_order     int default 0;

-- ── Seed default conversations if not present ─────────────────
-- (families get a "Family Chat" group conversation on first use via the app)

-- Notify trigger for last_message_at
create or replace function public.update_conversation_last_message()
returns trigger language plpgsql security definer as $$
begin
  update public.family_conversations
  set last_message_at = NEW.created_at, updated_at = now()
  where id = NEW.conversation_id;
  return NEW;
end;
$$;

drop trigger if exists trg_update_conversation_last_message on public.family_messages;
drop trigger if exists trg_update_conversation_last_message on public.family_messages;
create trigger trg_update_conversation_last_message
  after insert on public.family_messages
  for each row execute function public.update_conversation_last_message();



-- ══════════ 0015_todos.sql ══════════
-- Family to-do lists (personal + shared, separate from household chores)

create table if not exists public.todo_lists (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  created_by   uuid references public.family_members(id) on delete set null,
  name         text not null,
  color        text default 'violet',
  icon         text default '📋',
  is_shared    boolean not null default true,
  sort_order   int not null default 0,
  archived_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.todo_items (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  list_id        uuid not null references public.todo_lists(id) on delete cascade,
  created_by     uuid references public.family_members(id) on delete set null,
  assigned_to_id uuid references public.family_members(id) on delete set null,
  title          text not null,
  notes          text,
  is_done        boolean not null default false,
  priority       text not null default 'medium' check (priority in ('low', 'medium', 'high', 'urgent')),
  due_date       date,
  tags           text[] not null default '{}',
  sort_order     int not null default 0,
  completed_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Indexes
create index if not exists todo_lists_family_idx on public.todo_lists(family_id);
create index if not exists todo_items_list_idx   on public.todo_items(list_id);
create index if not exists todo_items_family_idx on public.todo_items(family_id);

-- RLS
alter table public.todo_lists enable row level security;
alter table public.todo_items enable row level security;

drop policy if exists "family member access" on public.todo_lists;
create policy "family member access" on public.todo_lists for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));

drop policy if exists "family member access" on public.todo_items;
create policy "family member access" on public.todo_items for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()));



-- ══════════ 0016_dashboard_preference.sql ══════════
-- Per-user default dashboard preference.
-- 'personal' = the member's role-specific dashboard (the default).
-- 'family'   = the shared Family Dashboard / Command Center overview.

alter table public.user_preferences
  add column if not exists default_dashboard text not null default 'personal'
    check (default_dashboard in ('personal', 'family'));



-- ══════════ 0017_conversation_participants.sql ══════════
-- Conversation participants by family_member id.
--
-- member_ids stores auth user_ids (used for read/access logic). That excludes
-- family members without a login (young kids, guests). participant_ids is the
-- canonical roster keyed by family_members.id, so account-less members are
-- first-class participants for display and membership.

alter table public.family_conversations
  add column if not exists participant_ids uuid[] not null default '{}';



-- ══════════ 0018_sync_platform.sql ══════════
-- FamilyOS :: 0018 sync platform
-- Two-way sync hub for calendars, reminders, and notes across Google, Microsoft/
-- Outlook, Apple (CalDAV/ICS), and Amazon/Alexa (ICS feed). This migration creates
-- the full persistence layer: providers, accounts, connections, encrypted tokens,
-- the synced item tables (calendars/events/reminders/notes), external id mappings,
-- the job/run engine tables, conflict tracking, webhook intake, change logs, error
-- tracking, audit logs, and per-family sync settings.
--
-- Tokens are NEVER stored in plaintext: lib/sync/crypto.ts encrypts them with
-- AES-256-GCM (key from SYNC_TOKEN_KEY) and only the ciphertext lands in
-- sync_tokens.access_token_enc / refresh_token_enc. RLS keeps the token table
-- service-role-only; the rest is family-scoped.

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
do $$ begin
  create type public.sync_provider as enum ('google','microsoft','apple','amazon','internal');
exception when duplicate_object then null; end $$;

do $$ begin
  -- import = provider -> theagoras, export = theagoras -> provider
  create type public.sync_direction as enum ('import','export','two_way','manual','disabled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sync_status as enum ('pending','syncing','synced','error','conflict','disabled','unsupported');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sync_item_type as enum ('calendar','event','reminder_list','reminder','note','note_folder');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sync_conflict_status as enum ('open','resolved','ignored');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sync_conflict_resolution as enum ('keep_local','keep_remote','merge','duplicate','manual');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.sync_job_status as enum ('queued','running','succeeded','failed','dead_letter','cancelled');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- Provider catalog (global reference data, readable by all authed users)
-- ----------------------------------------------------------------------------
create table if not exists public.sync_providers (
  provider          public.sync_provider primary key,
  label             text not null,
  -- honest capability matrix mirrored from lib/sync/capabilities.ts; what the
  -- provider's public API actually supports per item type & direction.
  capabilities      jsonb not null default '{}'::jsonb,
  auth_kind         text not null default 'oauth2',  -- oauth2 | caldav | ics | account_link
  is_enabled        boolean not null default true,
  docs_url          text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Per-user/family connected accounts + connections
-- ----------------------------------------------------------------------------
create table if not exists public.sync_accounts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  family_id         uuid not null references public.families(id) on delete cascade,
  provider          public.sync_provider not null references public.sync_providers(provider),
  external_id       text,                 -- provider account id / email
  display_name      text,
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'pending',
  scopes            text[] not null default '{}',
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (user_id, provider, external_id)
);
create index if not exists idx_sync_accounts_family on public.sync_accounts(family_id);
create index if not exists idx_sync_accounts_user on public.sync_accounts(user_id);

create table if not exists public.sync_connections (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.sync_accounts(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  family_id         uuid not null references public.families(id) on delete cascade,
  provider          public.sync_provider not null,
  external_id       text,
  item_types        public.sync_item_type[] not null default '{}',
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'pending',
  health            text not null default 'unknown',   -- healthy | degraded | error | unknown
  last_error        text,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_connections_account on public.sync_connections(account_id);
create index if not exists idx_sync_connections_family on public.sync_connections(family_id);

-- Encrypted credential store. Ciphertext only. Service-role access only via RLS.
create table if not exists public.sync_tokens (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references public.sync_accounts(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  family_id         uuid references public.families(id) on delete cascade,
  provider          public.sync_provider not null,
  external_id       text,
  access_token_enc  text,                 -- AES-256-GCM ciphertext (iv:tag:data, base64)
  refresh_token_enc text,
  token_type        text,
  scope             text,
  expires_at        timestamptz,
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'synced',
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (account_id)
);
create index if not exists idx_sync_tokens_account on public.sync_tokens(account_id);

-- ----------------------------------------------------------------------------
-- Synced item tables: calendars, events, reminders, notes
-- ----------------------------------------------------------------------------
create table if not exists public.sync_calendars (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  account_id        uuid references public.sync_accounts(id) on delete set null,
  provider          public.sync_provider not null default 'internal',
  external_id       text,
  name              text not null,
  description       text,
  color             text default '#6366f1',
  timezone          text not null default 'UTC',
  is_primary        boolean not null default false,
  is_owned_locally  boolean not null default true,   -- created in theagoras
  feed_token        text unique,                     -- public ICS feed slug (nullable until published)
  feed_enabled      boolean not null default false,
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'pending',
  sync_token        text,                            -- provider incremental/delta cursor
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_calendars_family on public.sync_calendars(family_id);
create index if not exists idx_sync_calendars_account on public.sync_calendars(account_id);

create table if not exists public.sync_calendar_shares (
  id                uuid primary key default gen_random_uuid(),
  calendar_id       uuid not null references public.sync_calendars(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete cascade,
  family_id         uuid not null references public.families(id) on delete cascade,
  provider          public.sync_provider not null default 'internal',
  external_id       text,
  shared_with_member uuid references public.family_members(id) on delete cascade,
  shared_with_email text,
  permission        text not null default 'read',    -- read | write | admin
  sync_direction    public.sync_direction not null default 'export',
  sync_status       public.sync_status not null default 'pending',
  revoked_at        timestamptz,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_cal_shares_cal on public.sync_calendar_shares(calendar_id);

create table if not exists public.sync_calendar_events (
  id                uuid primary key default gen_random_uuid(),
  calendar_id       uuid not null references public.sync_calendars(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  provider          public.sync_provider not null default 'internal',
  external_id       text,
  uid               text,                            -- iCalendar UID (stable across providers)
  title             text not null,
  description       text,
  location          text,
  starts_at         timestamptz not null,
  ends_at           timestamptz,
  all_day           boolean not null default false,
  timezone          text not null default 'UTC',
  recurrence_rule   text,                            -- RFC 5545 RRULE
  recurrence_id     text,                            -- override instance id
  color             text,
  reminders         jsonb not null default '[]'::jsonb, -- [{minutesBefore:int, method:'popup'|'email'}]
  status            text not null default 'confirmed',
  etag              text,                            -- provider concurrency token
  deleted_at        timestamptz,
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'pending',
  content_hash      text,                            -- change-detection digest
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_events_cal_time on public.sync_calendar_events(calendar_id, starts_at);
create index if not exists idx_sync_events_family on public.sync_calendar_events(family_id);
create index if not exists idx_sync_events_uid on public.sync_calendar_events(uid);

create table if not exists public.sync_event_attendees (
  id                uuid primary key default gen_random_uuid(),
  event_id          uuid not null references public.sync_calendar_events(id) on delete cascade,
  family_id         uuid not null references public.families(id) on delete cascade,
  provider          public.sync_provider not null default 'internal',
  external_id       text,
  member_id         uuid references public.family_members(id) on delete set null,
  email             text,
  display_name      text,
  response_status   text not null default 'needs_action', -- needs_action|accepted|declined|tentative
  is_organizer      boolean not null default false,
  sync_status       public.sync_status not null default 'pending',
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_attendees_event on public.sync_event_attendees(event_id);

create table if not exists public.sync_reminder_lists (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  account_id        uuid references public.sync_accounts(id) on delete set null,
  provider          public.sync_provider not null default 'internal',
  external_id       text,
  name              text not null,
  color             text default '#6366f1',
  is_owned_locally  boolean not null default true,
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'pending',
  sync_token        text,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_rem_lists_family on public.sync_reminder_lists(family_id);

create table if not exists public.sync_reminders (
  id                uuid primary key default gen_random_uuid(),
  list_id           uuid not null references public.sync_reminder_lists(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  provider          public.sync_provider not null default 'internal',
  external_id       text,
  title             text not null,
  notes             text,
  due_at            timestamptz,
  all_day           boolean not null default false,
  recurrence_rule   text,
  priority          text not null default 'medium',  -- low|medium|high|urgent
  is_completed      boolean not null default false,
  completed_at      timestamptz,
  assigned_member   uuid references public.family_members(id) on delete set null,
  reminders         jsonb not null default '[]'::jsonb,
  etag              text,
  deleted_at        timestamptz,
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'pending',
  content_hash      text,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_reminders_list on public.sync_reminders(list_id);
create index if not exists idx_sync_reminders_family on public.sync_reminders(family_id);

create table if not exists public.sync_note_folders (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  account_id        uuid references public.sync_accounts(id) on delete set null,
  provider          public.sync_provider not null default 'internal',
  external_id       text,
  name              text not null,
  parent_id         uuid references public.sync_note_folders(id) on delete cascade,
  is_owned_locally  boolean not null default true,
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'pending',
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_note_folders_family on public.sync_note_folders(family_id);

create table if not exists public.sync_notes (
  id                uuid primary key default gen_random_uuid(),
  folder_id         uuid references public.sync_note_folders(id) on delete set null,
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  provider          public.sync_provider not null default 'internal',
  external_id       text,
  title             text not null default 'Untitled',
  body_markdown     text,
  body_html         text,
  checklist         jsonb not null default '[]'::jsonb,
  tags              text[] not null default '{}',
  version           int not null default 1,
  etag              text,
  deleted_at        timestamptz,
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'pending',
  content_hash      text,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_notes_family on public.sync_notes(family_id);
create index if not exists idx_sync_notes_folder on public.sync_notes(folder_id);

-- ----------------------------------------------------------------------------
-- External id mapping: local row <-> provider object (the sync backbone)
-- ----------------------------------------------------------------------------
create table if not exists public.sync_external_mappings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  account_id        uuid references public.sync_accounts(id) on delete cascade,
  provider          public.sync_provider not null,
  item_type         public.sync_item_type not null,
  local_id          uuid not null,
  external_id       text not null,
  external_etag     text,
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'synced',
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (provider, item_type, external_id, account_id),
  unique (provider, item_type, local_id, account_id)
);
create index if not exists idx_sync_mappings_local on public.sync_external_mappings(local_id);
create index if not exists idx_sync_mappings_family on public.sync_external_mappings(family_id);

-- ----------------------------------------------------------------------------
-- Sync engine: jobs, runs, webhooks, change log, errors
-- ----------------------------------------------------------------------------
create table if not exists public.sync_jobs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  account_id        uuid references public.sync_accounts(id) on delete cascade,
  provider          public.sync_provider not null,
  external_id       text,
  item_type         public.sync_item_type,
  kind              text not null default 'scheduled', -- scheduled|manual|webhook|backfill
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'pending',
  status            public.sync_job_status not null default 'queued',
  scheduled_for     timestamptz not null default now(),
  attempts          int not null default 0,
  max_attempts      int not null default 5,
  next_attempt_at   timestamptz,
  idempotency_key   text,
  last_error        text,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (idempotency_key)
);
create index if not exists idx_sync_jobs_due on public.sync_jobs(status, scheduled_for);
create index if not exists idx_sync_jobs_family on public.sync_jobs(family_id);

create table if not exists public.sync_job_runs (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references public.sync_jobs(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  provider          public.sync_provider not null,
  external_id       text,
  status            public.sync_job_status not null default 'running',
  sync_status       public.sync_status not null default 'syncing',
  items_imported    int not null default 0,
  items_exported    int not null default 0,
  items_skipped     int not null default 0,
  conflicts_found   int not null default 0,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  duration_ms       int,
  error             text,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_job_runs_job on public.sync_job_runs(job_id);

create table if not exists public.sync_webhook_events (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid references public.families(id) on delete cascade,
  account_id        uuid references public.sync_accounts(id) on delete cascade,
  provider          public.sync_provider not null,
  external_id       text,                            -- provider subscription/resource id
  resource          text,
  payload           jsonb not null default '{}'::jsonb,
  signature_ok      boolean not null default false,
  processed         boolean not null default false,
  sync_status       public.sync_status not null default 'pending',
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_webhooks_unprocessed on public.sync_webhook_events(processed, received_at);

create table if not exists public.sync_change_logs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  provider          public.sync_provider not null default 'internal',
  external_id       text,
  item_type         public.sync_item_type not null,
  local_id          uuid,
  operation         text not null,                   -- create|update|delete|complete
  origin            text not null default 'local',   -- local|remote
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'synced',
  before            jsonb,
  after             jsonb,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_changes_family_time on public.sync_change_logs(family_id, created_at);

create table if not exists public.sync_provider_errors (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid references public.families(id) on delete cascade,
  account_id        uuid references public.sync_accounts(id) on delete cascade,
  provider          public.sync_provider not null,
  external_id       text,
  code              text,
  message_redacted  text,                            -- redacted: no tokens/PII
  http_status       int,
  is_fatal          boolean not null default false,
  sync_status       public.sync_status not null default 'error',
  occurred_at       timestamptz not null default now(),
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_errors_provider_time on public.sync_provider_errors(provider, occurred_at);

-- ----------------------------------------------------------------------------
-- Conflicts
-- ----------------------------------------------------------------------------
create table if not exists public.sync_conflicts (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  account_id        uuid references public.sync_accounts(id) on delete cascade,
  provider          public.sync_provider not null,
  external_id       text,
  item_type         public.sync_item_type not null,
  local_id          uuid,
  conflict_kind     text not null,                   -- both_edited|deleted_vs_edited|time_changed|completed_vs_edited
  local_snapshot    jsonb,
  remote_snapshot   jsonb,
  status            public.sync_conflict_status not null default 'open',
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'conflict',
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_conflicts_open on public.sync_conflicts(family_id, status);

create table if not exists public.sync_conflict_resolutions (
  id                uuid primary key default gen_random_uuid(),
  conflict_id       uuid not null references public.sync_conflicts(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid not null references public.families(id) on delete cascade,
  provider          public.sync_provider not null,
  external_id       text,
  resolution        public.sync_conflict_resolution not null,
  resolved_by       uuid references auth.users(id) on delete set null,
  sync_direction    public.sync_direction not null default 'two_way',
  sync_status       public.sync_status not null default 'synced',
  result_snapshot   jsonb,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_conflict_res_conflict on public.sync_conflict_resolutions(conflict_id);

-- ----------------------------------------------------------------------------
-- Audit log + per-family settings
-- ----------------------------------------------------------------------------
create table if not exists public.sync_audit_logs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete set null,
  family_id         uuid references public.families(id) on delete cascade,
  provider          public.sync_provider,
  external_id       text,
  action            text not null,                   -- connect|disconnect|sync|push|pull|resolve|revoke|token_refresh|error
  item_type         public.sync_item_type,
  target_id         uuid,
  sync_direction    public.sync_direction,
  sync_status       public.sync_status,
  ip_redacted       text,
  detail            jsonb not null default '{}'::jsonb,
  last_synced_at    timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_sync_audit_family_time on public.sync_audit_logs(family_id, created_at);

create table if not exists public.sync_settings (
  family_id           uuid primary key references public.families(id) on delete cascade,
  user_id             uuid references auth.users(id) on delete set null,
  provider            public.sync_provider,
  external_id         text,
  default_direction   public.sync_direction not null default 'two_way',
  sync_interval_mins  int not null default 15,
  auto_resolve        public.sync_conflict_resolution,  -- null = always manual
  calendars_enabled   boolean not null default true,
  reminders_enabled   boolean not null default true,
  notes_enabled       boolean not null default true,
  sync_status         public.sync_status not null default 'synced',
  last_synced_at      timestamptz,
  created_by          uuid references auth.users(id) on delete set null,
  updated_by          uuid references auth.users(id) on delete set null,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- updated_at triggers for every new table
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select unnest(array[
      'sync_providers','sync_accounts','sync_connections','sync_tokens',
      'sync_calendars','sync_calendar_shares','sync_calendar_events','sync_event_attendees',
      'sync_reminder_lists','sync_reminders','sync_note_folders','sync_notes',
      'sync_external_mappings','sync_jobs','sync_job_runs','sync_webhook_events',
      'sync_change_logs','sync_provider_errors','sync_conflicts','sync_conflict_resolutions',
      'sync_audit_logs','sync_settings'
    ])
  loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Lightweight audit trigger: record create/update/delete on the synced item
-- tables into sync_change_logs (origin defaults to 'local'; provider-side syncs
-- set metadata.origin='remote' on the row before writing to flip this).
-- ----------------------------------------------------------------------------
create or replace function public.sync_log_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_family uuid;
  v_item public.sync_item_type;
  v_origin text;
begin
  v_item := tg_argv[0]::public.sync_item_type;
  if tg_op = 'DELETE' then
    v_family := old.family_id;
    v_origin := coalesce(old.metadata->>'origin', 'local');
    insert into public.sync_change_logs (family_id, item_type, local_id, operation, origin, before)
    values (v_family, v_item, old.id, 'delete', v_origin, to_jsonb(old));
    return old;
  else
    v_family := new.family_id;
    v_origin := coalesce(new.metadata->>'origin', 'local');
    insert into public.sync_change_logs (family_id, item_type, local_id, operation, origin, before, after)
    values (v_family, v_item,
            new.id,
            case when tg_op = 'INSERT' then 'create' else 'update' end,
            v_origin,
            case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
            to_jsonb(new));
    return new;
  end if;
end; $$;

do $$ begin
  drop trigger if exists trg_sync_log on public.sync_calendar_events;
  drop trigger if exists trg_sync_log on public.sync_calendar_events;
create trigger trg_sync_log after insert or update or delete on public.sync_calendar_events
    for each row execute function public.sync_log_change('event');
  drop trigger if exists trg_sync_log on public.sync_reminders;
  drop trigger if exists trg_sync_log on public.sync_reminders;
create trigger trg_sync_log after insert or update or delete on public.sync_reminders
    for each row execute function public.sync_log_change('reminder');
  drop trigger if exists trg_sync_log on public.sync_notes;
  drop trigger if exists trg_sync_log on public.sync_notes;
create trigger trg_sync_log after insert or update or delete on public.sync_notes
    for each row execute function public.sync_log_change('note');
end $$;

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
alter table public.sync_providers            enable row level security;
alter table public.sync_accounts             enable row level security;
alter table public.sync_connections          enable row level security;
alter table public.sync_tokens               enable row level security;
alter table public.sync_calendars            enable row level security;
alter table public.sync_calendar_shares      enable row level security;
alter table public.sync_calendar_events      enable row level security;
alter table public.sync_event_attendees      enable row level security;
alter table public.sync_reminder_lists       enable row level security;
alter table public.sync_reminders            enable row level security;
alter table public.sync_note_folders         enable row level security;
alter table public.sync_notes                enable row level security;
alter table public.sync_external_mappings    enable row level security;
alter table public.sync_jobs                 enable row level security;
alter table public.sync_job_runs             enable row level security;
alter table public.sync_webhook_events       enable row level security;
alter table public.sync_change_logs          enable row level security;
alter table public.sync_provider_errors      enable row level security;
alter table public.sync_conflicts            enable row level security;
alter table public.sync_conflict_resolutions enable row level security;
alter table public.sync_audit_logs           enable row level security;
alter table public.sync_settings             enable row level security;

-- Provider catalog: any authenticated user may read; nobody writes via RLS
-- (service role / migrations manage it).
drop policy if exists "providers readable" on public.sync_providers;
create policy "providers readable" on public.sync_providers
  for select using (auth.role() = 'authenticated');

-- Family-scoped tables: members of the family can do everything; the service
-- role bypasses RLS for background sync jobs.
do $$
declare t text;
begin
  for t in
    select unnest(array[
      'sync_accounts','sync_connections','sync_calendars','sync_calendar_shares',
      'sync_calendar_events','sync_event_attendees','sync_reminder_lists','sync_reminders',
      'sync_note_folders','sync_notes','sync_external_mappings','sync_jobs','sync_job_runs',
      'sync_change_logs','sync_provider_errors','sync_conflicts','sync_conflict_resolutions',
      'sync_audit_logs','sync_settings','sync_webhook_events'
    ])
  loop
    execute format($f$drop policy if exists "family member access" on public.%I$f$, t);
    execute format($f$
      create policy "family member access" on public.%I for all
        using (public.is_family_member(family_id))
        with check (public.is_family_member(family_id))
    $f$, t);
  end loop;
end $$;

-- sync_tokens is the credential store: no client access at all. Only the
-- service role (which bypasses RLS) may read/write. The locked-down policy makes
-- the intent explicit and denies the anon/authenticated roles.
drop policy if exists "tokens service only" on public.sync_tokens;
create policy "tokens service only" on public.sync_tokens
  for all using (false) with check (false);

-- ----------------------------------------------------------------------------
-- Seed provider catalog (honest capabilities mirror lib/sync/capabilities.ts)
-- ----------------------------------------------------------------------------
insert into public.sync_providers (provider, label, auth_kind, docs_url, capabilities, notes) values
  ('google',    'Google',            'oauth2',
     'https://developers.google.com/calendar',
     '{"calendar":{"read":true,"write":true},"reminder":{"read":true,"write":true},"note":{"read":false,"write":false}}'::jsonb,
     'Calendar API + Tasks API support two-way sync. Google Keep has no public API — notes fall back to Google Docs export or internal-only.'),
  ('microsoft', 'Microsoft / Outlook','oauth2',
     'https://learn.microsoft.com/graph/api/resources/calendar',
     '{"calendar":{"read":true,"write":true},"reminder":{"read":true,"write":true},"note":{"read":true,"write":true}}'::jsonb,
     'Graph API: Outlook Calendar, Microsoft To Do, and OneNote all support two-way sync with delta queries + webhooks.'),
  ('apple',     'Apple',             'caldav',
     'https://support.apple.com/en-us/HT204397',
     '{"calendar":{"read":true,"write":true},"reminder":{"read":true,"write":true},"note":{"read":false,"write":false}}'::jsonb,
     'CalDAV (app-specific password) for Calendar + Reminders. Public ICS feed publishing for subscribe. Apple Notes has no public API — internal-only.'),
  ('amazon',    'Amazon / Alexa',    'ics',
     'https://developer.amazon.com/docs/alexa/account-linking/account-linking-concepts.html',
     '{"calendar":{"read":false,"write":true},"reminder":{"read":false,"write":false},"note":{"read":false,"write":false}}'::jsonb,
     'No general calendar/reminder write API. Alexa can subscribe to a published ICS calendar feed. Reminder writes require an Alexa Skill with account linking.'),
  ('internal',  'theagoras.com',     'oauth2',
     null,
     '{"calendar":{"read":true,"write":true},"reminder":{"read":true,"write":true},"note":{"read":true,"write":true}}'::jsonb,
     'Native storage. Always fully supported.')
on conflict (provider) do update set
  label = excluded.label, auth_kind = excluded.auth_kind, docs_url = excluded.docs_url,
  capabilities = excluded.capabilities, notes = excluded.notes, updated_at = now();



-- ══════════ 0019_sync_connections_unique.sql ══════════
-- FamilyOS :: 0019 sync_connections one-per-account
-- connectAccount() upserts a single connection row per provider account, so the
-- account_id needs a unique constraint to back the ON CONFLICT target.

create unique index if not exists sync_connections_account_ukey
  on public.sync_connections(account_id);



-- ══════════ 0020_marketing_channels.sql ══════════
-- ============================================================
-- Migration 0014: Marketing channels & builders
-- SMS, social, ads, automation, funnels, landing pages, and forms.
-- Same security model as 0013: RLS ENABLED with NO policies — admin/service
-- role only. Multi-step structures (automation steps, funnel steps, form
-- fields) are stored as jsonb on the parent row.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_sms_campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  segment_id   uuid REFERENCES public.marketing_segments(id) ON DELETE SET NULL,
  message      text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','failed')),
  scheduled_at timestamptz,
  sent_at      timestamptz,
  recipients   integer NOT NULL DEFAULT 0,
  delivered    integer NOT NULL DEFAULT 0,
  replies      integer NOT NULL DEFAULT 0,
  opt_outs     integer NOT NULL DEFAULT 0,
  provider_ref text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_sms_status ON public.marketing_sms_campaigns (status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.marketing_social_posts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  platform     text NOT NULL DEFAULT 'instagram'
                 CHECK (platform IN ('facebook','instagram','linkedin','tiktok','x','youtube')),
  content      text NOT NULL DEFAULT '',
  link         text,
  status       text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','published')),
  scheduled_at timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_social_status ON public.marketing_social_posts (status, scheduled_at);

CREATE TABLE IF NOT EXISTS public.marketing_ad_campaigns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id  uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  platform     text NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta','google','linkedin','tiktok','x')),
  name         text NOT NULL,
  objective    text,
  budget_cents integer NOT NULL DEFAULT 0 CHECK (budget_cents >= 0),
  spend_cents  integer NOT NULL DEFAULT 0 CHECK (spend_cents >= 0),
  impressions  integer NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  conversions  integer NOT NULL DEFAULT 0,
  utm          jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','paused','completed')),
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_ads_status ON public.marketing_ad_campaigns (status);

CREATE TABLE IF NOT EXISTS public.marketing_automation_workflows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  trigger     text NOT NULL DEFAULT 'customer_created',
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  run_count   integer NOT NULL DEFAULT 0,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketing_automation_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.marketing_automation_workflows(id) ON DELETE CASCADE,
  status      text NOT NULL DEFAULT 'completed' CHECK (status IN ('running','completed','failed')),
  subject_key text,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_runs_workflow ON public.marketing_automation_runs (workflow_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.marketing_funnels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketing_landing_pages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL,
  headline    text,
  subhead     text,
  body        text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  published   boolean NOT NULL DEFAULT false,
  views       integer NOT NULL DEFAULT 0,
  conversions integer NOT NULL DEFAULT 0,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketing_forms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.marketing_campaigns(id) ON DELETE SET NULL,
  name        text NOT NULL,
  fields      jsonb NOT NULL DEFAULT '[]'::jsonb,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.marketing_form_submissions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id    uuid NOT NULL REFERENCES public.marketing_forms(id) ON DELETE CASCADE,
  email      text,
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  source     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_form_subs ON public.marketing_form_submissions (form_id, created_at DESC);

-- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'marketing_sms_campaigns','marketing_social_posts','marketing_ad_campaigns',
    'marketing_automation_workflows','marketing_funnels','marketing_landing_pages','marketing_forms'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_set_updated_at ON public.%I', t);
    EXECUTE format('CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- RLS: enabled, NO policies (service-role / admin console only)
ALTER TABLE public.marketing_sms_campaigns        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_social_posts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_ad_campaigns         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_automation_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_automation_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_funnels              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_landing_pages        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_forms                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.marketing_form_submissions     ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Marketing channel + builder tables created.
-- ============================================================



-- ══════════ 0021_marketing_suppressions.sql ══════════
-- ============================================================
-- Migration 0021: Marketing email suppressions
-- Honors unsubscribes, bounces, and spam complaints. Anyone in this table is
-- excluded from marketing sends. Same security model: RLS enabled, no policies
-- (admin/service-role only). The unsubscribe route writes here via the service
-- role; the Resend webhook adds bounces/complaints.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_suppressions (
  email       text PRIMARY KEY,
  reason      text NOT NULL DEFAULT 'unsubscribe'
                CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual')),
  campaign_id uuid REFERENCES public.marketing_email_campaigns(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.marketing_suppressions ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Suppressed addresses are excluded from all marketing sends.
-- ============================================================



-- ══════════ 0022_family_os.sql ══════════
-- ============================================================
-- Migration 0014: Family AI Operating System modules
-- Adds the tables that power the new Family OS surfaces:
--   Digital Twin, Routines, AI Recommendations, Stress Prediction,
--   Life Automation, Knowledge Graph, Emergency Hub, Memory Brain.
--
-- Existing tables already cover Finance (financial_accounts, transactions,
-- budgets, bills, savings_goals), Operations (chores, calendar_events,
-- grocery_*), Health (medical_profiles, medications, appointments),
-- School (school_classes, grades, school_events), Sports (teams,
-- game_results, sports_events) and AI threads (ai_conversations,
-- ai_messages) — those modules compose what is already there.
--
-- Every new table follows the house conventions: family_id FK with
-- ON DELETE CASCADE, created_at/updated_at, created_by, a status column,
-- a metadata jsonb, an updated_at trigger, an index on family_id, and an
-- RLS policy gated on is_family_member(family_id).
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ── Family Routines ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_routines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  category text,
  time_of_day text,
  days_of_week int[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- ── Digital Twin profiles (one living model per member) ─────
CREATE TABLE IF NOT EXISTS family_digital_twin_profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES family_members(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{}',
  responsibilities jsonb NOT NULL DEFAULT '[]',
  strengths text,
  notes text,
  ai_insights text,
  stress_baseline int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, member_id)
);

-- ── AI recommendations (next-best-action feed) ─────────────
CREATE TABLE IF NOT EXISTS family_ai_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  category text NOT NULL DEFAULT 'general',
  title text NOT NULL,
  body text,
  priority text NOT NULL DEFAULT 'medium',
  cta_href text,
  source text,
  status text NOT NULL DEFAULT 'pending', -- pending | accepted | dismissed | done
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Stress prediction inputs + outputs ─────────────────────
CREATE TABLE IF NOT EXISTS family_stress_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  signal_type text NOT NULL,
  weight numeric(6,2) NOT NULL DEFAULT 1,
  source text,
  occurred_on date NOT NULL DEFAULT CURRENT_DATE,
  notes text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_stress_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  for_date date NOT NULL DEFAULT CURRENT_DATE,
  score int NOT NULL DEFAULT 0,
  level text NOT NULL DEFAULT 'low',
  factors jsonb NOT NULL DEFAULT '[]',
  suggestions jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Life automation rules + run log ────────────────────────
CREATE TABLE IF NOT EXISTS family_automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  name text NOT NULL,
  trigger_type text NOT NULL,
  trigger_config jsonb NOT NULL DEFAULT '{}',
  action_type text NOT NULL,
  action_config jsonb NOT NULL DEFAULT '{}',
  is_enabled boolean NOT NULL DEFAULT true,
  requires_approval boolean NOT NULL DEFAULT true,
  last_run_at timestamptz,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  rule_id uuid REFERENCES family_automation_rules(id) ON DELETE CASCADE,
  trigger_type text,
  status text NOT NULL DEFAULT 'pending', -- pending | approved | executed | skipped | failed
  summary text,
  result jsonb NOT NULL DEFAULT '{}',
  approved_by uuid REFERENCES auth.users(id),
  approved_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Knowledge graph (nodes + edges) ────────────────────────
CREATE TABLE IF NOT EXISTS family_knowledge_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  node_type text NOT NULL,
  label text NOT NULL,
  ref_table text,
  ref_id uuid,
  weight numeric(6,2) NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_knowledge_edges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES family_knowledge_nodes(id) ON DELETE CASCADE,
  target_id uuid NOT NULL REFERENCES family_knowledge_nodes(id) ON DELETE CASCADE,
  relation text NOT NULL DEFAULT 'related_to',
  weight numeric(6,2) NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Emergency hub ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_emergency_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  name text NOT NULL,
  relationship text,
  phone text,
  alt_phone text,
  email text,
  address text,
  is_primary boolean NOT NULL DEFAULT false,
  can_pickup boolean NOT NULL DEFAULT false,
  priority int NOT NULL DEFAULT 100,
  notes text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS family_emergency_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title text NOT NULL,
  plan_type text,
  content text,
  safe_location text,
  instructions text,
  is_active boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Memory brain ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  title text NOT NULL,
  body text,
  kind text NOT NULL DEFAULT 'journal', -- photo | quote | trip | achievement | journal | milestone
  memory_date date NOT NULL DEFAULT CURRENT_DATE,
  media_path text,
  tags text[] NOT NULL DEFAULT '{}',
  is_favorite boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE IF NOT EXISTS family_milestones (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text,
  milestone_date date NOT NULL DEFAULT CURRENT_DATE,
  category text,
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- Indexes, updated_at triggers, RLS for every new table
-- ============================================================
DO $$
DECLARE
  tbl text;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'family_routines', 'family_digital_twin_profiles', 'family_ai_recommendations',
    'family_stress_signals', 'family_stress_predictions',
    'family_automation_rules', 'family_automation_runs',
    'family_knowledge_nodes', 'family_knowledge_edges',
    'family_emergency_contacts', 'family_emergency_plans',
    'family_memories', 'family_milestones'
  ])
  LOOP
    EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%1$s_family ON %1$I(family_id)', tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS set_%1$s_updated ON %1$I', tbl);
    EXECUTE format('CREATE TRIGGER set_%1$s_updated BEFORE UPDATE ON %1$I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', tbl);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS "Members can manage %1$s" ON %1$I', tbl);
    EXECUTE format(
      'CREATE POLICY "Members can manage %1$s" ON %1$I FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id))',
      tbl
    );
  END LOOP;
END $$;

-- Extra hot-path indexes
CREATE INDEX IF NOT EXISTS idx_family_routines_member ON family_routines(family_id, member_id);
CREATE INDEX IF NOT EXISTS idx_family_ai_recommendations_status ON family_ai_recommendations(family_id, status);
CREATE INDEX IF NOT EXISTS idx_family_stress_signals_date ON family_stress_signals(family_id, occurred_on);
CREATE INDEX IF NOT EXISTS idx_family_stress_predictions_date ON family_stress_predictions(family_id, for_date);
CREATE INDEX IF NOT EXISTS idx_family_automation_runs_rule ON family_automation_runs(family_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_family_knowledge_edges_src ON family_knowledge_edges(family_id, source_id);
CREATE INDEX IF NOT EXISTS idx_family_knowledge_edges_tgt ON family_knowledge_edges(family_id, target_id);
CREATE INDEX IF NOT EXISTS idx_family_memories_date ON family_memories(family_id, memory_date);
CREATE INDEX IF NOT EXISTS idx_family_milestones_date ON family_milestones(family_id, milestone_date);

-- ============================================================
-- Done — 13 new tables, indexed, triggered, RLS-isolated.
-- ============================================================



-- ══════════ 0023_admin_console.sql ══════════
-- ============================================================
-- Migration 0015: Admin console support tables
--   app_settings        — persisted platform/system settings (key/value)
--   system_backups      — logged backup events + their metrics
--   admin_integrations  — third-party integration registry + status
--
-- These are SITE-ADMIN tables: RLS is enabled with NO policies, so no client
-- session can read/write them directly. The admin console reaches them only
-- through the service-role client (gated by the super-admin check in
-- admin/layout.tsx) — exactly like support_tickets (migration 0012).
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

-- ── Settings (key/value) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

-- ── Backup events ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.system_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'full',          -- full | incremental
  status text NOT NULL DEFAULT 'completed',    -- completed | warning | failed | running
  size_bytes bigint NOT NULL DEFAULT 0,
  location text,
  row_counts jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_system_backups_created ON public.system_backups(created_at DESC);
ALTER TABLE public.system_backups ENABLE ROW LEVEL SECURITY;

-- ── Integration registry ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.admin_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text UNIQUE NOT NULL,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'Other',
  status text NOT NULL DEFAULT 'available',     -- connected | issue | disconnected | available
  config jsonb NOT NULL DEFAULT '{}',
  last_sync_at timestamptz,
  created_by uuid REFERENCES auth.users(id),
  updated_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS set_admin_integrations_updated ON public.admin_integrations;
drop trigger if exists set_admin_integrations_updated on public.admin_integrations;
CREATE TRIGGER set_admin_integrations_updated BEFORE UPDATE ON public.admin_integrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE public.admin_integrations ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done — 3 admin-only tables (service-role access only).
-- ============================================================



-- ══════════ 0024_weather_locations.sql ══════════
-- ============================================================
-- Migration 0024: Weather saved locations
-- Per-family list of saved cities for the Weather feature. Live forecast data
-- comes from a real-time weather API in the browser; only the user's chosen
-- locations are persisted here. Family-scoped with the standard RLS model.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.weather_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  admin1      text,
  country     text,
  latitude    double precision NOT NULL,
  longitude   double precision NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- Avoid duplicate saved cities within a family (rounded to ~11m).
  UNIQUE (family_id, latitude, longitude)
);

CREATE INDEX IF NOT EXISTS idx_weather_locations_family ON public.weather_locations (family_id, sort_order);

DROP TRIGGER IF EXISTS trg_weather_locations_updated_at ON public.weather_locations;
drop trigger if exists trg_weather_locations_updated_at on public.weather_locations;
CREATE TRIGGER trg_weather_locations_updated_at
  BEFORE UPDATE ON public.weather_locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- RLS: family-scoped CRUD (matches 0004 pattern) ----------
ALTER TABLE public.weather_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS weather_locations_select ON public.weather_locations;
drop policy if exists weather_locations_select on public.weather_locations;
CREATE POLICY weather_locations_select ON public.weather_locations
  FOR SELECT USING (public.is_family_member(family_id));
DROP POLICY IF EXISTS weather_locations_insert ON public.weather_locations;
drop policy if exists weather_locations_insert on public.weather_locations;
CREATE POLICY weather_locations_insert ON public.weather_locations
  FOR INSERT WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS weather_locations_update ON public.weather_locations;
drop policy if exists weather_locations_update on public.weather_locations;
CREATE POLICY weather_locations_update ON public.weather_locations
  FOR UPDATE USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS weather_locations_delete ON public.weather_locations;
drop policy if exists weather_locations_delete on public.weather_locations;
CREATE POLICY weather_locations_delete ON public.weather_locations
  FOR DELETE USING (public.is_family_member(family_id));

-- ============================================================
-- Done! Families can save weather locations; forecasts are fetched live.
-- ============================================================



-- ══════════ 0025_fix_grocery_lists_rls.sql ══════════
-- ============================================================
-- Migration 0025: Repair grocery_lists / grocery_items RLS
-- Symptom: creating a shopping list fails with "new row violates row-level
-- security policy for table grocery_lists". That happens when RLS is enabled on
-- the table but the family-scoped INSERT policy isn't present (e.g. a DB set up
-- from a partial bundle that ran the table alters but not 0004's policy block).
--
-- This re-asserts the standard family CRUD policies idempotently. It's a no-op
-- on a correctly-migrated database and a fix on one that's missing them.
-- ============================================================

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['grocery_lists', 'grocery_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_select ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_select ON public.%1$I FOR SELECT USING (public.is_family_member(family_id))', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_insert ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_insert ON public.%1$I FOR INSERT WITH CHECK (public.is_family_member(family_id))', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_update ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_update ON public.%1$I FOR UPDATE USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);

    EXECUTE format('DROP POLICY IF EXISTS %1$s_delete ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_delete ON public.%1$I FOR DELETE USING (public.is_family_member(family_id))', t);
  END LOOP;
END $$;

-- ============================================================
-- Done! Family members can create/read/update/delete their shopping lists.
-- ============================================================



-- ══════════ 0026_display_layouts.sql ══════════
-- ============================================================
-- Migration 0026: Customizable Kitchen Display layouts
-- One saved layout per family for the /display kiosk. The layout is a JSON list
-- of tiles ({ id, widget, size }), edited in-app and rendered on the display.
-- Family-scoped with the standard RLS model.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.display_layouts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL UNIQUE REFERENCES public.families(id) ON DELETE CASCADE,
  tiles       jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_display_layouts_updated_at ON public.display_layouts;
drop trigger if exists trg_display_layouts_updated_at on public.display_layouts;
CREATE TRIGGER trg_display_layouts_updated_at
  BEFORE UPDATE ON public.display_layouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.display_layouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS display_layouts_select ON public.display_layouts;
drop policy if exists display_layouts_select on public.display_layouts;
CREATE POLICY display_layouts_select ON public.display_layouts
  FOR SELECT USING (public.is_family_member(family_id));
DROP POLICY IF EXISTS display_layouts_insert ON public.display_layouts;
drop policy if exists display_layouts_insert on public.display_layouts;
CREATE POLICY display_layouts_insert ON public.display_layouts
  FOR INSERT WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS display_layouts_update ON public.display_layouts;
drop policy if exists display_layouts_update on public.display_layouts;
CREATE POLICY display_layouts_update ON public.display_layouts
  FOR UPDATE USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS display_layouts_delete ON public.display_layouts;
drop policy if exists display_layouts_delete on public.display_layouts;
CREATE POLICY display_layouts_delete ON public.display_layouts
  FOR DELETE USING (public.is_family_member(family_id));

-- ============================================================
-- Done! Each family can customize its kitchen-display grid.
-- ============================================================



-- ══════════ 0026_medication_doses.sql ══════════
-- ============================================================
-- Migration 0026: Medication dose log (adherence tracking)
-- Backs the Medication Tracker. `medications` and
-- `medication_schedules` already exist (migration 0002); this adds a
-- per-dose log so adherence can be measured over time instead of only
-- tracking the last time a med was taken.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE dose_status AS ENUM ('taken', 'skipped', 'missed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.medication_doses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  medication_id uuid NOT NULL REFERENCES public.medications(id) ON DELETE CASCADE,
  schedule_id   uuid REFERENCES public.medication_schedules(id) ON DELETE SET NULL,
  member_id     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  -- The calendar day + scheduled time this dose belongs to. `scheduled_for`
  -- is the canonical slot; a (schedule_id, scheduled_for) pair is unique so a
  -- dose can be toggled idempotently from the UI.
  scheduled_for timestamptz NOT NULL,
  status        dose_status NOT NULL DEFAULT 'taken',
  taken_at      timestamptz,
  notes         text,
  logged_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_med_doses_family ON public.medication_doses(family_id);
CREATE INDEX IF NOT EXISTS idx_med_doses_med ON public.medication_doses(medication_id);
CREATE INDEX IF NOT EXISTS idx_med_doses_scheduled ON public.medication_doses(family_id, scheduled_for);
-- One row per scheduled slot so "mark taken/skip" is an idempotent upsert.
CREATE UNIQUE INDEX IF NOT EXISTS uq_med_doses_slot
  ON public.medication_doses(schedule_id, scheduled_for)
  WHERE schedule_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.medication_doses;
drop trigger if exists trg_set_updated_at on public.medication_doses;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.medication_doses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.medication_doses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage medication_doses" ON public.medication_doses;
drop policy if exists "Members can manage medication_doses" on public.medication_doses;
CREATE POLICY "Members can manage medication_doses" ON public.medication_doses
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0027_rides.sql ══════════
-- ============================================================
-- Migration 0027: Transportation / Carpool planner
-- Backs the Rides Planner (Top-50 complaint #17 "coordinating rides
-- → AI transportation planner"). Tracks who is driving whom, when, and
-- to/from where — with an optional link to a calendar event.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE ride_status AS ENUM ('planned', 'confirmed', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.rides (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title            text NOT NULL,
  ride_date        date NOT NULL,
  pickup_time      time,
  dropoff_time     time,
  pickup_location  text,
  dropoff_location text,
  -- Driver is a family member (or null when a ride still needs one).
  driver_id        uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  -- Riders are family members; kept as an array so a ride is a single row.
  rider_ids        uuid[] NOT NULL DEFAULT '{}',
  status           ride_status NOT NULL DEFAULT 'planned',
  notes            text,
  event_id         uuid REFERENCES public.calendar_events(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rides_family ON public.rides(family_id);
CREATE INDEX IF NOT EXISTS idx_rides_date ON public.rides(family_id, ride_date);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON public.rides(driver_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.rides;
drop trigger if exists trg_set_updated_at on public.rides;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.rides
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.rides ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage rides" ON public.rides;
drop policy if exists "Members can manage rides" on public.rides;
CREATE POLICY "Members can manage rides" ON public.rides
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0028_reward_redemptions.sql ══════════
-- ============================================================
-- Migration 0028: Reward redemptions (allowance / points ledger)
-- Backs the Rewards & Allowance center (Top-50 complaints #7 "kids don't
-- do chores → gamification" and #21 "parents overloaded"). The existing
-- `rewards` table (migration 0002) modelled a one-shot redeemable; this
-- turns rewards into a reusable catalog and logs each redemption as a
-- request that a parent approves, so points balances have real history.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE redemption_status AS ENUM ('requested', 'approved', 'fulfilled', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.reward_redemptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  reward_id    uuid REFERENCES public.rewards(id) ON DELETE SET NULL,
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  -- Snapshot of the reward's title + cost at redemption time so history
  -- survives the reward being edited or deleted.
  reward_title text NOT NULL,
  cost_points  integer NOT NULL DEFAULT 0,
  status       redemption_status NOT NULL DEFAULT 'requested',
  note         text,
  decided_by   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reward_redemptions_family ON public.reward_redemptions(family_id);
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_member ON public.reward_redemptions(member_id);
CREATE INDEX IF NOT EXISTS idx_reward_redemptions_status ON public.reward_redemptions(family_id, status);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.reward_redemptions;
drop trigger if exists trg_set_updated_at on public.reward_redemptions;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.reward_redemptions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.reward_redemptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage reward_redemptions" ON public.reward_redemptions;
drop policy if exists "Members can manage reward_redemptions" on public.reward_redemptions;
CREATE POLICY "Members can manage reward_redemptions" ON public.reward_redemptions
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0029_trips.sql ══════════
-- ============================================================
-- Migration 0029: Travel / Trip planner
-- Backs the Trip Planner (Top-50 complaint #18 "vacation planning
-- difficult → AI family trip planner"). A trip plus a checklist of items
-- (packing, to-dos, reservations, documents) the family works through.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE trip_status AS ENUM ('planning', 'booked', 'active', 'completed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE trip_item_kind AS ENUM ('packing', 'todo', 'reservation', 'document');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.trips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name         text NOT NULL,
  destination  text,
  start_date   date,
  end_date     date,
  status       trip_status NOT NULL DEFAULT 'planning',
  traveler_ids uuid[] NOT NULL DEFAULT '{}',
  notes        text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trips_family ON public.trips(family_id);
CREATE INDEX IF NOT EXISTS idx_trips_dates ON public.trips(family_id, start_date);

CREATE TABLE IF NOT EXISTS public.trip_items (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  trip_id     uuid NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  kind        trip_item_kind NOT NULL DEFAULT 'packing',
  label       text NOT NULL,
  details     text,
  assignee_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  is_done     boolean NOT NULL DEFAULT false,
  due_at      timestamptz,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_items_family ON public.trip_items(family_id);
CREATE INDEX IF NOT EXISTS idx_trip_items_trip ON public.trip_items(trip_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.trips;
drop trigger if exists trg_set_updated_at on public.trips;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_set_updated_at ON public.trip_items;
drop trigger if exists trg_set_updated_at on public.trip_items;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.trip_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
-- Explicit per-table statements (no DO/format loop): the dollar-quoted
-- format() placeholders confuse some SQL clients' statement parsers.
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage trips" ON public.trips;
drop policy if exists "Members can manage trips" on public.trips;
CREATE POLICY "Members can manage trips" ON public.trips
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.trip_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage trip_items" ON public.trip_items;
drop policy if exists "Members can manage trip_items" on public.trip_items;
CREATE POLICY "Members can manage trip_items" ON public.trip_items
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0030_homework.sql ══════════
-- ============================================================
-- Migration 0030: Homework tracker
-- Backs the Homework Tracker (Top-50 complaint #16 "kids miss homework
-- → AI student assistant"). Per-student assignments with subject, due
-- date, and a simple status workflow.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE homework_status AS ENUM ('assigned', 'in_progress', 'done', 'submitted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.homework_assignments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  subject     text,
  title       text NOT NULL,
  details     text,
  due_at      timestamptz,
  status      homework_status NOT NULL DEFAULT 'assigned',
  completed_at timestamptz,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_homework_family ON public.homework_assignments(family_id);
CREATE INDEX IF NOT EXISTS idx_homework_member ON public.homework_assignments(member_id);
CREATE INDEX IF NOT EXISTS idx_homework_due ON public.homework_assignments(family_id, due_at);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.homework_assignments;
drop trigger if exists trg_set_updated_at on public.homework_assignments;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.homework_assignments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.homework_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage homework_assignments" ON public.homework_assignments;
drop policy if exists "Members can manage homework_assignments" on public.homework_assignments;
CREATE POLICY "Members can manage homework_assignments" ON public.homework_assignments
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0031_opportunities.sql ══════════
-- ============================================================
-- Migration 0031: Registrations & Signups tracker
-- Backs the Signups tracker (Top-50 complaints #27 "school
-- registrations missed → AI registration monitoring" and #28 "camp
-- signups fill up → AI opportunity alerts"). Time-boxed opportunities
-- (camp/school/sports/activity registrations) with a deadline and a
-- simple status workflow so nothing fills up or closes unnoticed.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE opportunity_status AS ENUM ('interested', 'registered', 'waitlisted', 'passed', 'missed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.opportunities (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title       text NOT NULL,
  category    text,                 -- camp / school / sports / activity / class / other
  url         text,
  cost        numeric(10,2),
  opens_at    date,                 -- registration opens
  deadline    date,                 -- registration closes
  status      opportunity_status NOT NULL DEFAULT 'interested',
  notes       text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_opportunities_family ON public.opportunities(family_id);
CREATE INDEX IF NOT EXISTS idx_opportunities_deadline ON public.opportunities(family_id, deadline);
CREATE INDEX IF NOT EXISTS idx_opportunities_member ON public.opportunities(member_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.opportunities;
drop trigger if exists trg_set_updated_at on public.opportunities;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.opportunities
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage opportunities" ON public.opportunities;
drop policy if exists "Members can manage opportunities" on public.opportunities;
CREATE POLICY "Members can manage opportunities" ON public.opportunities
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0032_care_log.sql ══════════
-- ============================================================
-- Migration 0032: Caregiver / Elder care log
-- Backs the Care Log (Top-50 complaint #25 "elder care difficult → AI
-- caregiver dashboard"). A timeline of check-ins, visits, calls, and
-- well-being notes for a family member who needs coordinated care, so
-- the whole family can see who last checked in and how they're doing.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE care_log_type AS ENUM ('check_in', 'visit', 'call', 'meal', 'medication', 'appointment', 'incident', 'note');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.care_log (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  -- The person being cared for.
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  log_type     care_log_type NOT NULL DEFAULT 'check_in',
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  -- Optional 1–5 well-being rating recorded at the time.
  wellbeing    smallint CHECK (wellbeing BETWEEN 1 AND 5),
  note         text,
  -- The family member who performed/recorded the care.
  logged_by    uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_care_log_family ON public.care_log(family_id);
CREATE INDEX IF NOT EXISTS idx_care_log_member ON public.care_log(family_id, member_id, occurred_at DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.care_log;
drop trigger if exists trg_set_updated_at on public.care_log;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.care_log
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.care_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage care_log" ON public.care_log;
drop policy if exists "Members can manage care_log" on public.care_log;
CREATE POLICY "Members can manage care_log" ON public.care_log
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0033_renewals.sql ══════════
-- ============================================================
-- Migration 0033: Renewals & Expirations tracker
-- Backs the Renewals tracker (Top-50 complaints #30 "household documents
-- expire → AI expiration management" and #31 "appliance warranties
-- forgotten → AI warranty manager"). Tracks anything that expires and
-- needs renewing — IDs, licenses, registrations, warranties, insurance,
-- subscriptions — each with its own reminder lead time.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE renewal_status AS ENUM ('active', 'renewed', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.renewals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title         text NOT NULL,
  category      text,                 -- id / passport / license / registration / warranty / insurance / subscription / other
  expires_at    date NOT NULL,
  -- How many days before expiry this should start warning.
  reminder_days integer NOT NULL DEFAULT 30,
  cost          numeric(10,2),
  url           text,
  status        renewal_status NOT NULL DEFAULT 'active',
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_renewals_family ON public.renewals(family_id);
CREATE INDEX IF NOT EXISTS idx_renewals_expiry ON public.renewals(family_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_renewals_member ON public.renewals(member_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.renewals;
drop trigger if exists trg_set_updated_at on public.renewals;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.renewals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.renewals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage renewals" ON public.renewals;
drop policy if exists "Members can manage renewals" on public.renewals;
CREATE POLICY "Members can manage renewals" ON public.renewals
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0034_social_command_center.sql ══════════
-- FamilyOS :: 0034 social media command center
-- Persistence for the Social Media Command Center: connected accounts + encrypted
-- tokens, the unified feed, drafts/variants/targets, media library, scheduling,
-- the publish job/result pipeline, comments/messages (inbox), analytics snapshots,
-- AI generation history, campaigns, calendar items, webhook intake, provider error
-- + usage tracking, audit logs, per-family settings, and granular social access.
--
-- Security model:
--   * Every household table is family-scoped via public.is_family_member(family_id)
--     — the same hard isolation boundary used everywhere else in FamilyOS. No row
--     ever crosses a family.
--   * social_account_tokens stores ONLY ciphertext (encrypt with lib/social/crypto
--     / the existing SYNC_TOKEN_KEY AES-256-GCM helper). RLS leaves it with NO
--     policy, so only the service-role client can ever read tokens. The browser
--     physically cannot.
--   * social_providers is global read-only reference data, mirrored from
--     lib/social/capabilities.ts.
--   * Granular in-family roles (owner…read_only) are enforced in server actions and,
--     for the publish-sensitive tables, in RLS via public.social_has_permission().

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
do $$ begin
  create type public.social_platform as enum
    ('x','facebook','instagram','linkedin','tiktok','youtube','pinterest','threads','reddit');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_account_status as enum
    ('pending','connected','error','expired','disconnected','revoked','requires_setup');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_post_kind as enum
    ('text','image','video','audio','short','carousel','thread','poll','link','announcement');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_post_status as enum
    ('draft','scheduled','publishing','published','partially_published','failed','canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_target_status as enum
    ('pending','publishing','published','failed','skipped','canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_job_status as enum
    ('queued','running','succeeded','failed','dead_letter','canceled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_approval_status as enum
    ('not_required','pending','approved','rejected','changes_requested');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_inbox_status as enum
    ('open','resolved','ignored','snoozed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_asset_kind as enum
    ('image','video','audio','document','thumbnail');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.social_role as enum
    ('owner','admin','marketing_manager','social_manager','content_creator','approver','analyst','read_only');
exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- Provider catalog (global reference, readable by all authenticated users)
-- ----------------------------------------------------------------------------
create table if not exists public.social_providers (
  platform          public.social_platform primary key,
  label             text not null,
  -- honest capability matrix mirrored from lib/social/capabilities.ts
  capabilities      jsonb not null default '{}'::jsonb,
  auth_method       text not null default 'oauth2',
  is_enabled        boolean not null default true,
  needs_app_review  boolean not null default false,
  char_limit        integer not null default 0,
  docs_url          text,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- Connected accounts + (service-role-only) encrypted tokens
-- ----------------------------------------------------------------------------
create table if not exists public.social_accounts (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families(id) on delete cascade,
  user_id              uuid not null references auth.users(id) on delete cascade,
  platform             public.social_platform not null references public.social_providers(platform),
  account_type         text,
  provider_account_id  text,
  handle               text,
  display_name         text,
  avatar_url           text,
  profile_url          text,
  status               public.social_account_status not null default 'pending',
  health               text not null default 'unknown',
  scopes               text[] not null default '{}',
  last_synced_at       timestamptz,
  last_error           text,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  deleted_at           timestamptz,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (family_id, platform, provider_account_id)
);
create index if not exists idx_social_accounts_family on public.social_accounts(family_id);
create index if not exists idx_social_accounts_platform on public.social_accounts(family_id, platform);

create table if not exists public.social_account_tokens (
  id                   uuid primary key default gen_random_uuid(),
  account_id           uuid not null references public.social_accounts(id) on delete cascade,
  family_id            uuid references public.families(id) on delete cascade,
  platform             public.social_platform not null,
  provider_account_id  text,
  access_token_enc     text,
  refresh_token_enc    text,
  token_type           text,
  scope                text,
  expires_at           timestamptz,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_tokens_account on public.social_account_tokens(account_id);

-- ----------------------------------------------------------------------------
-- Unified feed
-- ----------------------------------------------------------------------------
create table if not exists public.social_feed_items (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid not null references public.social_accounts(id) on delete cascade,
  platform             public.social_platform not null,
  provider_object_id   text,
  author_name          text,
  author_handle        text,
  author_avatar_url    text,
  permalink_url        text,
  body                 text,
  media_type           text,
  media                jsonb not null default '[]'::jsonb,
  metrics              jsonb not null default '{}'::jsonb,
  posted_at            timestamptz,
  fetched_at           timestamptz not null default now(),
  status               text not null default 'active',
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  deleted_at           timestamptz,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (account_id, provider_object_id)
);
create index if not exists idx_social_feed_family_time on public.social_feed_items(family_id, posted_at desc);
create index if not exists idx_social_feed_platform on public.social_feed_items(family_id, platform);

-- ----------------------------------------------------------------------------
-- Campaigns + drafts + per-platform variants + publish targets
-- ----------------------------------------------------------------------------
create table if not exists public.social_campaigns (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  name         text not null,
  description  text,
  status       text not null default 'active',
  goal         text,
  color        text,
  starts_on    date,
  ends_on      date,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_campaigns_family on public.social_campaigns(family_id);

create table if not exists public.social_posts (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null,
  campaign_id       uuid references public.social_campaigns(id) on delete set null,
  title             text,
  body              text not null default '',
  kind              public.social_post_kind not null default 'text',
  status            public.social_post_status not null default 'draft',
  link              text,
  scheduled_for     timestamptz,
  published_at      timestamptz,
  approval_status   public.social_approval_status not null default 'not_required',
  approved_by       uuid references auth.users(id) on delete set null,
  approved_at       timestamptz,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  deleted_at        timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_social_posts_family on public.social_posts(family_id, status);
create index if not exists idx_social_posts_schedule on public.social_posts(family_id, scheduled_for);

create table if not exists public.social_post_variants (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.social_posts(id) on delete cascade,
  family_id    uuid not null references public.families(id) on delete cascade,
  platform     public.social_platform not null,
  body         text not null default '',
  hashtags     text[] not null default '{}',
  mentions     text[] not null default '{}',
  char_count   integer not null default 0,
  status       text not null default 'ready',
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (post_id, platform)
);
create index if not exists idx_social_variants_post on public.social_post_variants(post_id);

create table if not exists public.social_post_targets (
  id                   uuid primary key default gen_random_uuid(),
  post_id              uuid not null references public.social_posts(id) on delete cascade,
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete set null,
  platform             public.social_platform not null,
  status               public.social_target_status not null default 'pending',
  provider_object_id   text,
  permalink_url        text,
  error                text,
  scheduled_for        timestamptz,
  published_at         timestamptz,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_targets_post on public.social_post_targets(post_id);
create index if not exists idx_social_targets_family on public.social_post_targets(family_id, status);

-- ----------------------------------------------------------------------------
-- Media library + post<->asset links
-- ----------------------------------------------------------------------------
create table if not exists public.social_media_library (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  kind         public.social_asset_kind not null,
  title        text,
  url          text,
  storage_path text,
  mime_type    text,
  width        integer,
  height       integer,
  duration_ms  integer,
  size_bytes   bigint,
  alt_text     text,
  tags         text[] not null default '{}',
  source       text not null default 'upload',   -- upload | ai_generated | prompt | storyboard
  status       text not null default 'ready',     -- ready | processing | prompt_only | failed
  usage_count  integer not null default 0,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_media_family on public.social_media_library(family_id, kind);

create table if not exists public.social_post_assets (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.social_posts(id) on delete cascade,
  family_id    uuid not null references public.families(id) on delete cascade,
  asset_id     uuid not null references public.social_media_library(id) on delete cascade,
  platform     public.social_platform,
  position     integer not null default 0,
  role         text not null default 'primary',
  created_by   uuid references auth.users(id) on delete set null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_post_assets_post on public.social_post_assets(post_id);

-- ----------------------------------------------------------------------------
-- Scheduling + publish pipeline
-- ----------------------------------------------------------------------------
create table if not exists public.social_schedules (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.social_posts(id) on delete cascade,
  family_id     uuid not null references public.families(id) on delete cascade,
  scheduled_for timestamptz not null,
  timezone      text not null default 'UTC',
  recurrence    text not null default 'none',
  status        text not null default 'scheduled',
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_social_schedules_due on public.social_schedules(family_id, scheduled_for);

create table if not exists public.social_publish_jobs (
  id               uuid primary key default gen_random_uuid(),
  post_id          uuid not null references public.social_posts(id) on delete cascade,
  family_id        uuid not null references public.families(id) on delete cascade,
  status           public.social_job_status not null default 'queued',
  scheduled_for    timestamptz not null default now(),
  attempts         integer not null default 0,
  max_attempts     integer not null default 3,
  next_attempt_at  timestamptz,
  idempotency_key  text,
  last_error       text,
  created_by       uuid references auth.users(id) on delete set null,
  updated_by       uuid references auth.users(id) on delete set null,
  metadata         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_social_jobs_due on public.social_publish_jobs(status, scheduled_for);
create index if not exists idx_social_jobs_post on public.social_publish_jobs(post_id);

create table if not exists public.social_publish_results (
  id                   uuid primary key default gen_random_uuid(),
  job_id               uuid references public.social_publish_jobs(id) on delete cascade,
  target_id            uuid references public.social_post_targets(id) on delete cascade,
  post_id              uuid not null references public.social_posts(id) on delete cascade,
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete set null,
  platform             public.social_platform not null,
  status               public.social_target_status not null default 'pending',
  provider_object_id   text,
  permalink_url        text,
  error_code           text,
  error_message        text,
  raw_response         jsonb not null default '{}'::jsonb,
  attempted_at         timestamptz not null default now(),
  created_by           uuid references auth.users(id) on delete set null,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_results_post on public.social_publish_results(post_id);
create index if not exists idx_social_results_family on public.social_publish_results(family_id, status);

-- ----------------------------------------------------------------------------
-- Inbox: comments + messages
-- ----------------------------------------------------------------------------
create table if not exists public.social_comments (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete cascade,
  platform             public.social_platform not null,
  provider_object_id   text,
  feed_item_id         uuid references public.social_feed_items(id) on delete set null,
  parent_provider_id   text,
  kind                 text not null default 'comment',   -- comment | mention | reply
  author_name          text,
  author_handle        text,
  body                 text,
  permalink_url        text,
  status               public.social_inbox_status not null default 'open',
  assigned_to          uuid references auth.users(id) on delete set null,
  posted_at            timestamptz,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  deleted_at           timestamptz,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_comments_inbox on public.social_comments(family_id, status);

create table if not exists public.social_messages (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete cascade,
  platform             public.social_platform not null,
  provider_object_id   text,
  thread_id            text,
  direction            text not null default 'inbound',   -- inbound | outbound
  author_name          text,
  author_handle        text,
  body                 text,
  status               public.social_inbox_status not null default 'open',
  assigned_to          uuid references auth.users(id) on delete set null,
  posted_at            timestamptz,
  created_by           uuid references auth.users(id) on delete set null,
  updated_by           uuid references auth.users(id) on delete set null,
  deleted_at           timestamptz,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_messages_inbox on public.social_messages(family_id, status);

-- ----------------------------------------------------------------------------
-- Analytics + AI generations + templates + calendar
-- ----------------------------------------------------------------------------
create table if not exists public.social_analytics_snapshots (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid not null references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete cascade,
  post_id              uuid references public.social_posts(id) on delete cascade,
  platform             public.social_platform not null,
  captured_for         date not null default current_date,
  impressions          bigint not null default 0,
  reach                bigint not null default 0,
  likes                bigint not null default 0,
  comments             bigint not null default 0,
  shares               bigint not null default 0,
  saves                bigint not null default 0,
  clicks               bigint not null default 0,
  views                bigint not null default 0,
  watch_time_seconds   bigint not null default 0,
  followers            bigint not null default 0,
  engagement_rate      numeric(6,4) not null default 0,
  metrics              jsonb not null default '{}'::jsonb,
  created_by           uuid references auth.users(id) on delete set null,
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_analytics_family on public.social_analytics_snapshots(family_id, platform, captured_for);

create table if not exists public.social_ai_generations (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  post_id      uuid references public.social_posts(id) on delete set null,
  kind         text not null,                       -- caption | hashtags | rewrite | ideas | video_script | ...
  platform     public.social_platform,
  prompt       text,
  input        jsonb not null default '{}'::jsonb,
  output       jsonb not null default '{}'::jsonb,
  model        text,
  tokens       integer not null default 0,
  status       text not null default 'succeeded',
  created_by   uuid references auth.users(id) on delete set null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_ai_family on public.social_ai_generations(family_id, created_at desc);

create table if not exists public.social_content_templates (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  name         text not null,
  kind         public.social_post_kind not null default 'text',
  body         text not null default '',
  platforms    text[] not null default '{}',
  hashtags     text[] not null default '{}',
  status       text not null default 'active',
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  deleted_at   timestamptz,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_templates_family on public.social_content_templates(family_id);

create table if not exists public.social_calendar_items (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  post_id       uuid references public.social_posts(id) on delete cascade,
  campaign_id   uuid references public.social_campaigns(id) on delete set null,
  title         text,
  platform      public.social_platform,
  scheduled_for timestamptz not null,
  status        text not null default 'scheduled',
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_social_calendar_due on public.social_calendar_items(family_id, scheduled_for);

-- ----------------------------------------------------------------------------
-- Webhooks, provider errors, usage, audit, settings, access
-- ----------------------------------------------------------------------------
create table if not exists public.social_webhook_events (
  id                   uuid primary key default gen_random_uuid(),
  family_id            uuid references public.families(id) on delete cascade,
  account_id           uuid references public.social_accounts(id) on delete set null,
  platform             public.social_platform not null,
  provider_object_id   text,
  event_type           text,
  payload              jsonb not null default '{}'::jsonb,
  signature_ok         boolean not null default false,
  processed            boolean not null default false,
  processed_at         timestamptz,
  received_at          timestamptz not null default now(),
  metadata             jsonb not null default '{}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists idx_social_webhooks_unprocessed on public.social_webhook_events(processed, received_at);

create table if not exists public.social_provider_errors (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid references public.families(id) on delete cascade,
  account_id    uuid references public.social_accounts(id) on delete set null,
  platform      public.social_platform not null,
  scope         text,
  error_code    text,
  error_message text,
  context       jsonb not null default '{}'::jsonb,
  occurred_at   timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_social_provider_errors on public.social_provider_errors(platform, occurred_at desc);

create table if not exists public.social_usage_events (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null,
  platform     public.social_platform,
  kind         text not null,                       -- ai_generation | publish | media_upload | feed_sync
  quantity     integer not null default 1,
  unit         text not null default 'count',
  occurred_at  timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_usage_family on public.social_usage_events(family_id, occurred_at desc);

create table if not exists public.social_audit_logs (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  actor_id     uuid references auth.users(id) on delete set null,
  action       text not null,
  entity_type  text,
  entity_id    uuid,
  summary      text,
  before       jsonb,
  after        jsonb,
  ip           text,
  occurred_at  timestamptz not null default now(),
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_social_audit_family on public.social_audit_logs(family_id, occurred_at desc);

create table if not exists public.social_settings (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade unique,
  default_timezone   text not null default 'UTC',
  default_platforms  text[] not null default '{}',
  require_approval   boolean not null default false,
  auto_hashtags      boolean not null default true,
  signature          text,
  ai_tone            text not null default 'friendly',
  created_by         uuid references auth.users(id) on delete set null,
  updated_by         uuid references auth.users(id) on delete set null,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists public.social_access_permissions (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  member_id    uuid references public.family_members(id) on delete set null,
  social_role  public.social_role not null default 'read_only',
  status       text not null default 'active',
  granted_by   uuid references auth.users(id) on delete set null,
  created_by   uuid references auth.users(id) on delete set null,
  updated_by   uuid references auth.users(id) on delete set null,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (family_id, user_id)
);
create index if not exists idx_social_access_family on public.social_access_permissions(family_id);

-- ----------------------------------------------------------------------------
-- Permission helper (SECURITY DEFINER): granular in-family social role check.
-- Resolves the caller's social role (explicit row, else default by member role)
-- and tests it against the role->permission matrix mirrored from lib/social/roles.ts.
-- ----------------------------------------------------------------------------
create or replace function public.social_role_for(p_family_id uuid)
returns public.social_role language sql security definer stable set search_path = public as $$
  select coalesce(
    (select social_role from public.social_access_permissions
       where family_id = p_family_id and user_id = auth.uid() and status = 'active' limit 1),
    (select case fm.role
              when 'parent' then 'admin'::public.social_role
              when 'adult'  then 'marketing_manager'::public.social_role
              when 'teen'   then 'content_creator'::public.social_role
              else 'read_only'::public.social_role
            end
       from public.family_members fm
      where fm.family_id = p_family_id and fm.user_id = auth.uid() and fm.is_active
      limit 1)
  );
$$;

create or replace function public.social_has_permission(p_family_id uuid, p_permission text)
returns boolean language sql security definer stable set search_path = public as $$
  with role_cte as (select public.social_role_for(p_family_id) as r)
  select public.is_family_member(p_family_id) and (
    select case (select r from role_cte)
      when 'owner' then true
      when 'admin' then true
      when 'marketing_manager' then p_permission in
        ('connect_accounts','view_feed','create_drafts','generate_ai','upload_media',
         'publish_posts','schedule_posts','approve_posts','view_analytics','manage_settings')
      when 'social_manager' then p_permission in
        ('view_feed','create_drafts','generate_ai','upload_media','publish_posts','schedule_posts','view_analytics')
      when 'content_creator' then p_permission in
        ('view_feed','create_drafts','generate_ai','upload_media')
      when 'approver' then p_permission in ('view_feed','approve_posts','view_analytics')
      when 'analyst' then p_permission in ('view_feed','view_analytics')
      when 'read_only' then p_permission in ('view_feed')
      else false
    end
  );
$$;

-- ----------------------------------------------------------------------------
-- Audit trigger: record account + post + result mutations into social_audit_logs.
-- ----------------------------------------------------------------------------
create or replace function public.social_write_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_family uuid;
  v_id uuid;
begin
  if (tg_op = 'DELETE') then
    v_family := old.family_id; v_id := old.id;
  else
    v_family := new.family_id; v_id := new.id;
  end if;
  if v_family is not null then
    insert into public.social_audit_logs (family_id, actor_id, action, entity_type, entity_id, summary)
    values (v_family, auth.uid(), tg_op, tg_table_name, v_id,
            tg_op || ' on ' || tg_table_name);
  end if;
  if (tg_op = 'DELETE') then return old; end if;
  return new;
end; $$;

drop trigger if exists trg_audit_social_accounts on public.social_accounts;
drop trigger if exists trg_audit_social_accounts on public.social_accounts;
create trigger trg_audit_social_accounts
  after insert or update or delete on public.social_accounts
  for each row execute function public.social_write_audit();

drop trigger if exists trg_audit_social_posts on public.social_posts;
drop trigger if exists trg_audit_social_posts on public.social_posts;
create trigger trg_audit_social_posts
  after insert or update or delete on public.social_posts
  for each row execute function public.social_write_audit();

drop trigger if exists trg_audit_social_results on public.social_publish_results;
drop trigger if exists trg_audit_social_results on public.social_publish_results;
create trigger trg_audit_social_results
  after insert or update on public.social_publish_results
  for each row execute function public.social_write_audit();

-- ----------------------------------------------------------------------------
-- updated_at triggers for every social_* table that has the column.
-- ----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'updated_at'
      and table_name like 'social\_%'
    group by table_name
  loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
do $$
declare t text;
declare social_tables text[] := array[
  'social_accounts','social_feed_items','social_campaigns','social_posts',
  'social_post_variants','social_post_targets','social_media_library',
  'social_post_assets','social_schedules','social_publish_jobs','social_publish_results',
  'social_comments','social_messages','social_analytics_snapshots','social_ai_generations',
  'social_content_templates','social_calendar_items','social_provider_errors',
  'social_usage_events','social_audit_logs','social_settings','social_access_permissions'
];
begin
  -- enable RLS on every social_* table (incl. tokens, providers, webhooks)
  for t in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_name like 'social\_%'
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;

  -- generic family-scoped CRUD for the household tables above
  foreach t in array social_tables loop
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t);
  end loop;
end $$;

-- Providers: global read-only reference for any authenticated user.
drop policy if exists social_providers_read on public.social_providers;
drop policy if exists social_providers_read on public.social_providers;
create policy social_providers_read on public.social_providers for select
  using (auth.role() = 'authenticated');

-- Tokens: NO policy → only the service-role client (which bypasses RLS) can touch
-- them. RLS is enabled above, so authenticated users get zero rows. This is the
-- deliberate "secure token storage" boundary; never add a permissive policy here.

-- Webhook events: family members may read events scoped to their family; writes
-- are service-role only (no insert/update policy).
drop policy if exists social_webhooks_select on public.social_webhook_events;
drop policy if exists social_webhooks_select on public.social_webhook_events;
create policy social_webhooks_select on public.social_webhook_events for select
  using (family_id is not null and public.is_family_member(family_id));

-- Tighten the publish-sensitive writes to the granular role (defense in depth on
-- top of family isolation). Publishing/scheduling requires the matching permission.
drop policy if exists social_publish_jobs_insert on public.social_publish_jobs;
drop policy if exists social_publish_jobs_insert on public.social_publish_jobs;
create policy social_publish_jobs_insert on public.social_publish_jobs for insert
  with check (public.social_has_permission(family_id, 'publish_posts')
              or public.social_has_permission(family_id, 'schedule_posts'));

-- These two policy names were already created generically by the loop above;
-- drop them first, then recreate with the stricter manage_access check.
drop policy if exists social_access_permissions_insert on public.social_access_permissions;
drop policy if exists social_access_permissions_insert on public.social_access_permissions;
create policy social_access_permissions_insert on public.social_access_permissions for insert
  with check (public.is_family_admin(family_id) or public.social_has_permission(family_id, 'manage_access'));
drop policy if exists social_access_permissions_update on public.social_access_permissions;
drop policy if exists social_access_permissions_update on public.social_access_permissions;
create policy social_access_permissions_update on public.social_access_permissions for update
  using (public.is_family_admin(family_id) or public.social_has_permission(family_id, 'manage_access'))
  with check (public.is_family_admin(family_id) or public.social_has_permission(family_id, 'manage_access'));

-- ----------------------------------------------------------------------------
-- Seed the provider catalog (mirrors lib/social/capabilities.ts).
-- ----------------------------------------------------------------------------
insert into public.social_providers (platform, label, auth_method, needs_app_review, char_limit, docs_url) values
  ('x',         'X (Twitter)',         'oauth2', false, 280,   'https://developer.x.com/en/docs'),
  ('facebook',  'Facebook Pages',      'oauth2', true,  63206, 'https://developers.facebook.com/docs/pages-api'),
  ('instagram', 'Instagram Business',  'oauth2', true,  2200,  'https://developers.facebook.com/docs/instagram-api'),
  ('linkedin',  'LinkedIn',            'oauth2', true,  3000,  'https://learn.microsoft.com/en-us/linkedin/marketing/'),
  ('tiktok',    'TikTok',              'oauth2', true,  2200,  'https://developers.tiktok.com/doc/content-posting-api-get-started'),
  ('youtube',   'YouTube',             'oauth2', true,  5000,  'https://developers.google.com/youtube/v3'),
  ('pinterest', 'Pinterest',           'oauth2', true,  500,   'https://developers.pinterest.com/docs/api/v5/'),
  ('threads',   'Threads',             'oauth2', true,  500,   'https://developers.facebook.com/docs/threads'),
  ('reddit',    'Reddit',              'oauth2', false, 40000, 'https://www.reddit.com/dev/api/')
on conflict (platform) do update set
  label = excluded.label,
  auth_method = excluded.auth_method,
  needs_app_review = excluded.needs_app_review,
  char_limit = excluded.char_limit,
  docs_url = excluded.docs_url,
  updated_at = now();



-- ══════════ 0035_push_devices.sql ══════════
-- FamilyOS :: 0035 push devices
-- Stores per-user push registrations so the notification engine can deliver
-- pushes to the installed PWA (Web Push / VAPID) and the native iOS/iPadOS and
-- Android apps (Capacitor → APNs/FCM tokens). One row per physical device.
--
-- Security: a user may only see/manage their OWN devices (user_id = auth.uid()).
-- The server-role dispatcher (lib/server/push.ts) reads across users to send.

create table if not exists public.push_devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  family_id     uuid references public.families(id) on delete set null,
  platform      text not null default 'web',     -- web | ios | android
  provider      text not null default 'webpush', -- webpush | fcm | apns
  -- Web Push (VAPID) fields:
  endpoint      text,
  p256dh        text,
  auth          text,
  -- Native (APNs/FCM) token:
  token         text,
  -- Stable per-device key (endpoint for web, token for native) for upsert.
  device_key    text not null,
  user_agent    text,
  enabled       boolean not null default true,
  last_seen_at  timestamptz not null default now(),
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, device_key)
);
create index if not exists idx_push_devices_user on public.push_devices(user_id);
create index if not exists idx_push_devices_enabled on public.push_devices(enabled) where enabled;

-- updated_at trigger (matches the project-wide pattern).
drop trigger if exists trg_set_updated_at on public.push_devices;
drop trigger if exists trg_set_updated_at on public.push_devices;
create trigger trg_set_updated_at before update on public.push_devices
  for each row execute function public.set_updated_at();

-- RLS: own-device only.
alter table public.push_devices enable row level security;

drop policy if exists push_devices_select on public.push_devices;
drop policy if exists push_devices_select on public.push_devices;
create policy push_devices_select on public.push_devices for select
  using (user_id = auth.uid());
drop policy if exists push_devices_insert on public.push_devices;
drop policy if exists push_devices_insert on public.push_devices;
create policy push_devices_insert on public.push_devices for insert
  with check (user_id = auth.uid());
drop policy if exists push_devices_update on public.push_devices;
drop policy if exists push_devices_update on public.push_devices;
create policy push_devices_update on public.push_devices for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists push_devices_delete on public.push_devices;
drop policy if exists push_devices_delete on public.push_devices;
create policy push_devices_delete on public.push_devices for delete
  using (user_id = auth.uid());



-- ══════════ 0036_home_maintenance.sql ══════════
-- FamilyOS :: 0036 home & maintenance command center
-- Turns "Home & Maintenance" into a full homeowner system: properties, enriched
-- assets, first-class warranty management, a maintenance + AI-forecast loop,
-- service history, and saved contractors ("find a pro"). Builds on the existing
-- home_assets + maintenance_tasks tables (0002) and warranty document storage
-- (0007); nothing here breaks those.
--
-- Every table is family-scoped via public.is_family_member(family_id) — the same
-- hard isolation boundary used across FamilyOS. updated_at is auto-maintained.

-- ----------------------------------------------------------------------------
-- Properties
-- ----------------------------------------------------------------------------
create table if not exists public.homes (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  name          text not null,                 -- "Main House", "Lake Cabin"
  address       text,
  home_type     text,                          -- single_family | condo | townhouse | apartment | other
  year_built    integer,
  square_feet   integer,
  bedrooms      integer,
  bathrooms     numeric(4,1),
  purchase_date date,
  is_primary    boolean not null default true,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  deleted_at    timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_homes_family on public.homes(family_id);

-- ----------------------------------------------------------------------------
-- Enrich existing home_assets for warranties + AI maintenance forecasting
-- ----------------------------------------------------------------------------
alter table public.home_assets add column if not exists home_id uuid references public.homes(id) on delete set null;
alter table public.home_assets add column if not exists serial_number text;
alter table public.home_assets add column if not exists installed_on date;
alter table public.home_assets add column if not exists filter_size text;        -- e.g. 16x25x1
alter table public.home_assets add column if not exists purchase_price numeric(12,2);
alter table public.home_assets add column if not exists expected_life_years integer;
alter table public.home_assets add column if not exists condition text;          -- new | good | fair | poor
alter table public.home_assets add column if not exists last_serviced_on date;
create index if not exists idx_home_assets_home on public.home_assets(home_id);

-- ----------------------------------------------------------------------------
-- Saved contractors ("find a pro")
-- ----------------------------------------------------------------------------
create table if not exists public.home_contractors (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  name          text not null,
  trade         text,                          -- hvac | plumbing | electrical | roofing | appliance | general | landscaping | pest
  company       text,
  phone         text,
  email         text,
  website       text,
  rating        integer,                        -- 1..5
  hourly_rate   numeric(10,2),
  is_preferred  boolean not null default false,
  last_used_on  date,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  deleted_at    timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_home_contractors_family on public.home_contractors(family_id);

-- ----------------------------------------------------------------------------
-- First-class warranties (manufacturer / extended / home warranty / service plan)
-- ----------------------------------------------------------------------------
create table if not exists public.home_warranties (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  home_id       uuid references public.homes(id) on delete set null,
  asset_id      uuid references public.home_assets(id) on delete set null,
  name          text not null,                 -- "LG Fridge extended warranty"
  provider      text,                          -- "LG", "Asurion", "First American"
  warranty_type text not null default 'manufacturer', -- manufacturer | extended | home_warranty | service_plan
  policy_number text,
  coverage      text,                          -- what's covered, deductibles
  starts_on     date,
  expires_on    date,
  cost          numeric(12,2),
  premium_period text,                         -- one_time | monthly | annual
  claim_phone   text,
  claim_url     text,
  claim_email   text,
  document_id   uuid references public.documents(id) on delete set null,
  status        text not null default 'active', -- active | expired | claimed | cancelled
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  deleted_at    timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_home_warranties_family on public.home_warranties(family_id);
create index if not exists idx_home_warranties_asset on public.home_warranties(asset_id);
create index if not exists idx_home_warranties_expiry on public.home_warranties(family_id, expires_on);

-- ----------------------------------------------------------------------------
-- Service history log (per asset / home)
-- ----------------------------------------------------------------------------
create table if not exists public.home_service_records (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  home_id       uuid references public.homes(id) on delete set null,
  asset_id      uuid references public.home_assets(id) on delete set null,
  contractor_id uuid references public.home_contractors(id) on delete set null,
  title         text not null,
  service_date  date not null default current_date,
  provider      text,
  cost          numeric(12,2),
  description   text,
  next_due_on   date,
  created_by    uuid references auth.users(id) on delete set null,
  updated_by    uuid references auth.users(id) on delete set null,
  deleted_at    timestamptz,
  metadata      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_home_service_family on public.home_service_records(family_id, service_date desc);
create index if not exists idx_home_service_asset on public.home_service_records(asset_id);

-- ----------------------------------------------------------------------------
-- AI logs (maintenance forecasting, repair diagnosis, find-a-pro guidance)
-- ----------------------------------------------------------------------------
create table if not exists public.home_ai_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  asset_id    uuid references public.home_assets(id) on delete set null,
  kind        text not null,                   -- forecast | diagnose | find_pro
  input       jsonb not null default '{}'::jsonb,
  output      jsonb not null default '{}'::jsonb,
  model       text,
  status      text not null default 'succeeded',
  created_by  uuid references auth.users(id) on delete set null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_home_ai_family on public.home_ai_logs(family_id, created_at desc);

-- ----------------------------------------------------------------------------
-- updated_at triggers for the new tables
-- ----------------------------------------------------------------------------
do $$
declare t text;
declare tbls text[] := array['homes','home_contractors','home_warranties','home_service_records','home_ai_logs'];
begin
  foreach t in array tbls loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ----------------------------------------------------------------------------
-- Row Level Security — family-scoped CRUD on every new table
-- ----------------------------------------------------------------------------
do $$
declare t text;
declare tbls text[] := array['homes','home_contractors','home_warranties','home_service_records','home_ai_logs'];
begin
  foreach t in array tbls loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t);
  end loop;
end $$;



-- ══════════ 0037_auto.sql ══════════
-- FamilyOS :: 0037 auto / vehicles command center
-- A full vehicle system mirroring Home & Maintenance: vehicles, driver licenses,
-- registrations, inspection stickers, insurance (full policy + an emergency
-- quick-glance), rental cars, a service log, and AI logs. Every record carries a
-- renewal/expiry date so the app can surface reminders.
--
-- Family-scoped via public.is_family_member(family_id); updated_at auto-maintained.

-- ----------------------------------------------------------------------------
-- Vehicles
-- ----------------------------------------------------------------------------
create table if not exists public.vehicles (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  nickname        text,
  make            text,
  model           text,
  year            integer,
  trim            text,
  color           text,
  vin             text,
  license_plate   text,
  plate_state     text,
  body_type       text,           -- sedan | suv | truck | van | coupe | ev | motorcycle | other
  fuel_type       text,           -- gas | diesel | hybrid | electric
  mileage         integer,
  purchase_date   date,
  primary_driver  uuid references public.family_members(id) on delete set null,
  status          text not null default 'active',  -- active | sold | stored
  photo_url       text,
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null,
  deleted_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_vehicles_family on public.vehicles(family_id);

-- ----------------------------------------------------------------------------
-- Driver licenses (per person)
-- ----------------------------------------------------------------------------
create table if not exists public.driver_licenses (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  member_id       uuid references public.family_members(id) on delete set null,
  holder_name     text not null,
  license_number  text,
  state           text,
  license_class   text,           -- C / CDL-A / etc.
  endorsements    text,
  restrictions    text,
  issued_on       date,
  expires_on      date,
  status          text not null default 'active',
  document_id     uuid references public.documents(id) on delete set null,
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null,
  deleted_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_driver_licenses_family on public.driver_licenses(family_id, expires_on);

-- ----------------------------------------------------------------------------
-- Registrations + inspection stickers (per vehicle)
-- ----------------------------------------------------------------------------
create table if not exists public.vehicle_registrations (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  vehicle_id      uuid references public.vehicles(id) on delete cascade,
  plate           text,
  state           text,
  registered_on   date,
  expires_on      date,
  fee             numeric(10,2),
  document_id     uuid references public.documents(id) on delete set null,
  status          text not null default 'active',
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null,
  deleted_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_vehicle_registrations_family on public.vehicle_registrations(family_id, expires_on);
create index if not exists idx_vehicle_registrations_vehicle on public.vehicle_registrations(vehicle_id);

create table if not exists public.vehicle_inspections (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  vehicle_id      uuid references public.vehicles(id) on delete cascade,
  inspection_type text not null default 'safety',  -- safety | emissions | both
  station         text,
  inspected_on    date,
  expires_on      date,           -- the sticker expiry
  result          text,           -- pass | fail | advisory
  document_id     uuid references public.documents(id) on delete set null,
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  updated_by      uuid references auth.users(id) on delete set null,
  deleted_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_vehicle_inspections_family on public.vehicle_inspections(family_id, expires_on);
create index if not exists idx_vehicle_inspections_vehicle on public.vehicle_inspections(vehicle_id);

-- ----------------------------------------------------------------------------
-- Insurance policies (full details + emergency quick-glance fields)
-- ----------------------------------------------------------------------------
create table if not exists public.auto_insurance_policies (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families(id) on delete cascade,
  vehicle_id        uuid references public.vehicles(id) on delete set null,
  provider          text,
  policy_number     text,
  naic              text,
  coverage_summary  text,
  liability_limits  text,           -- e.g. 100/300/100
  deductible_collision     numeric(10,2),
  deductible_comprehensive numeric(10,2),
  agent_name        text,
  agent_phone       text,
  claims_phone      text,
  roadside_phone    text,
  effective_on      date,
  expires_on        date,
  premium           numeric(10,2),
  premium_period    text,           -- monthly | 6_month | annual
  document_id       uuid references public.documents(id) on delete set null,
  is_active         boolean not null default true,
  status            text not null default 'active',
  notes             text,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  deleted_at        timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_auto_insurance_family on public.auto_insurance_policies(family_id, expires_on);

-- ----------------------------------------------------------------------------
-- Rental cars
-- ----------------------------------------------------------------------------
create table if not exists public.rental_cars (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families(id) on delete cascade,
  company           text,
  confirmation_number text,
  pickup_location   text,
  dropoff_location  text,
  pickup_at         timestamptz,
  return_at         timestamptz,
  vehicle_desc      text,
  daily_rate        numeric(10,2),
  total_cost        numeric(10,2),
  coverage          text,
  driver_member_id  uuid references public.family_members(id) on delete set null,
  status            text not null default 'upcoming', -- upcoming | active | returned | cancelled
  document_id       uuid references public.documents(id) on delete set null,
  notes             text,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  deleted_at        timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_rental_cars_family on public.rental_cars(family_id, pickup_at desc);

-- ----------------------------------------------------------------------------
-- Vehicle service log
-- ----------------------------------------------------------------------------
create table if not exists public.auto_service_records (
  id                uuid primary key default gen_random_uuid(),
  family_id         uuid not null references public.families(id) on delete cascade,
  vehicle_id        uuid references public.vehicles(id) on delete cascade,
  title             text not null,
  service_date      date not null default current_date,
  provider          text,
  cost              numeric(10,2),
  mileage           integer,
  description       text,
  next_due_on       date,
  next_due_mileage  integer,
  created_by        uuid references auth.users(id) on delete set null,
  updated_by        uuid references auth.users(id) on delete set null,
  deleted_at        timestamptz,
  metadata          jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_auto_service_family on public.auto_service_records(family_id, service_date desc);
create index if not exists idx_auto_service_vehicle on public.auto_service_records(vehicle_id);

-- ----------------------------------------------------------------------------
-- AI logs (accident assistant, maintenance forecast, claim helper)
-- ----------------------------------------------------------------------------
create table if not exists public.auto_ai_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  vehicle_id  uuid references public.vehicles(id) on delete set null,
  kind        text not null,                   -- accident | maintenance | claim
  input       jsonb not null default '{}'::jsonb,
  output      jsonb not null default '{}'::jsonb,
  model       text,
  status      text not null default 'succeeded',
  created_by  uuid references auth.users(id) on delete set null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_auto_ai_family on public.auto_ai_logs(family_id, created_at desc);

-- ----------------------------------------------------------------------------
-- updated_at triggers + RLS for all new tables
-- ----------------------------------------------------------------------------
do $$
declare t text;
declare tbls text[] := array[
  'vehicles','driver_licenses','vehicle_registrations','vehicle_inspections',
  'auto_insurance_policies','rental_cars','auto_service_records','auto_ai_logs'
];
begin
  foreach t in array tbls loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);

    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t);
  end loop;
end $$;



-- ══════════ 0038_notification_pushed_at.sql ══════════
-- Bubaly :: 0038 notification pushed_at
-- Split push and email delivery so a single notification can be BOTH pushed and
-- emailed. Previously both channels gated on notifications.sent_at and stamped
-- it, so whichever ran first in the cron starved the other. Push now tracks its
-- own pushed_at column; the email digest keeps sent_at.

alter table public.notifications
  add column if not exists pushed_at timestamptz;

-- Backfill: rows already delivered historically (sent_at set, stamped by the
-- push job before this split) are treated as already pushed so the next run
-- does not re-push the entire backlog.
update public.notifications
  set pushed_at = sent_at
  where sent_at is not null and pushed_at is null;

-- Index the un-pushed working set the dispatcher scans each run.
create index if not exists idx_notif_pending_push
  on public.notifications (created_at)
  where pushed_at is null;



-- ══════════ 0039_referral_program.sql ══════════
-- ============================================================
-- Migration 0039: Referral Program (viral growth loop)
-- Each family gets a unique referral code/link. When a referred family signs
-- up and converts to a paid plan, both sides earn a reward credit.
--
-- referral_codes  — one code per family (family-scoped, family-readable).
-- referrals       — the tracked referral relationship + reward state.
--
-- Reads are family-scoped via the standard is_family_member() model so a family
-- can see the people it referred (and the credit it earned). All WRITES happen
-- through the service-role client (signup attribution, admin, Stripe webhook),
-- so there are deliberately no INSERT/UPDATE/DELETE policies.
-- ============================================================

-- ---------- Referral codes (one per family) ----------
CREATE TABLE IF NOT EXISTS public.referral_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL UNIQUE REFERENCES public.families(id) ON DELETE CASCADE,
  code        text NOT NULL UNIQUE,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON public.referral_codes (code);

DROP TRIGGER IF EXISTS trg_referral_codes_updated_at ON public.referral_codes;
drop trigger if exists trg_referral_codes_updated_at on public.referral_codes;
CREATE TRIGGER trg_referral_codes_updated_at
  BEFORE UPDATE ON public.referral_codes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.referral_codes ENABLE ROW LEVEL SECURITY;

-- A family can read its own code. Writes are service-role only.
DROP POLICY IF EXISTS referral_codes_select ON public.referral_codes;
drop policy if exists referral_codes_select on public.referral_codes;
CREATE POLICY referral_codes_select ON public.referral_codes
  FOR SELECT USING (public.is_family_member(family_id));

-- ---------- Referrals (the tracked relationship) ----------
CREATE TABLE IF NOT EXISTS public.referrals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  text NOT NULL,
  referrer_family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  referred_family_id    uuid REFERENCES public.families(id) ON DELETE SET NULL,
  referred_email        text,
  status                text NOT NULL DEFAULT 'signed_up'
                          CHECK (status IN ('pending','signed_up','converted','rewarded','void')),
  source                text,
  referrer_reward_cents integer NOT NULL DEFAULT 0 CHECK (referrer_reward_cents >= 0),
  referred_reward_cents integer NOT NULL DEFAULT 0 CHECK (referred_reward_cents >= 0),
  signed_up_at          timestamptz NOT NULL DEFAULT now(),
  converted_at          timestamptz,
  rewarded_at           timestamptz,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- A family can only be referred once, and never by itself.
  CONSTRAINT referrals_referred_once UNIQUE (referred_family_id),
  CONSTRAINT referrals_no_self CHECK (referred_family_id IS NULL OR referred_family_id <> referrer_family_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON public.referrals (referrer_family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON public.referrals (referred_family_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status   ON public.referrals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_code     ON public.referrals (code);

DROP TRIGGER IF EXISTS trg_referrals_updated_at ON public.referrals;
drop trigger if exists trg_referrals_updated_at on public.referrals;
CREATE TRIGGER trg_referrals_updated_at
  BEFORE UPDATE ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

-- Both the referrer and the referred family can read the referral. Writes are
-- service-role only (attribution + reward crediting happen server-side).
DROP POLICY IF EXISTS referrals_select ON public.referrals;
drop policy if exists referrals_select on public.referrals;
CREATE POLICY referrals_select ON public.referrals
  FOR SELECT USING (
    public.is_family_member(referrer_family_id)
    OR (referred_family_id IS NOT NULL AND public.is_family_member(referred_family_id))
  );

-- ============================================================
-- Done! Families can refer friends and earn rewards on conversion.
-- ============================================================



-- ══════════ 0040_surveys.sql ══════════
-- ============================================================
-- Migration 0040: Surveys (NPS / CSAT / CES) — Marketing Pillar 1
-- A lightweight survey engine for measuring customer sentiment:
--   * NPS  — "How likely are you to recommend…" (0–10)
--   * CSAT — "How satisfied were you…" (1–5)
--   * CES  — "How easy was it…" (1–7)
--   * custom numeric scales
--
-- surveys           — the survey definition (admin/business-owned).
-- survey_responses  — one row per submitted response (score + optional comment).
--
-- Like the rest of the marketing suite these are business-wide, not family-scoped.
-- RLS is ENABLED with NO policies, so they are reachable only through the
-- service-role client: the admin console (super-admin gated) for management and
-- analytics, and the public response endpoint (server action / server component)
-- for fetching an active survey by slug and inserting a response. There is no
-- direct client access.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.surveys (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  type               text NOT NULL DEFAULT 'nps'
                       CHECK (type IN ('nps','csat','ces','custom')),
  question           text NOT NULL,
  scale_min          integer NOT NULL DEFAULT 0,
  scale_max          integer NOT NULL DEFAULT 10,
  low_label          text,
  high_label         text,
  follow_up_question text,
  thank_you_message  text,
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','active','closed')),
  audience           text,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at         timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_surveys_status ON public.surveys (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_surveys_updated_at ON public.surveys;
drop trigger if exists trg_surveys_updated_at on public.surveys;
CREATE TRIGGER trg_surveys_updated_at
  BEFORE UPDATE ON public.surveys
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.survey_responses (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id            uuid NOT NULL REFERENCES public.surveys(id) ON DELETE CASCADE,
  score                integer,
  comment              text,
  respondent_email     text,
  respondent_family_id uuid REFERENCES public.families(id) ON DELETE SET NULL,
  channel              text NOT NULL DEFAULT 'link',  -- link | email | in_app
  user_agent           text,
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_survey_responses_survey ON public.survey_responses (survey_id, submitted_at DESC);

DROP TRIGGER IF EXISTS trg_survey_responses_updated_at ON public.survey_responses;
drop trigger if exists trg_survey_responses_updated_at on public.survey_responses;
CREATE TRIGGER trg_survey_responses_updated_at
  BEFORE UPDATE ON public.survey_responses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS on, no policies → service-role only (admin console + public endpoint).
ALTER TABLE public.surveys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_responses ENABLE ROW LEVEL SECURITY;



-- ══════════ 0041_reviews.sql ══════════
-- ============================================================
-- Migration 0041: Reviews & Reputation — Marketing Pillar 2
-- Collect star reviews from customers, moderate them, reply, feature the best,
-- and route happy customers to public review platforms (Google / App Store /
-- Trustpilot). Pairs with Pillar 1 (Surveys): an NPS promoter can be linked to
-- the review they leave.
--
-- reviews              — one row per submitted review (rating + text + moderation).
-- reputation_settings  — singleton business config (platform links + messaging).
--
-- Business-wide like the rest of marketing: RLS ENABLED with NO policies, so both
-- tables are reachable only via the service-role client — the super-admin console
-- (moderation/analytics), the public submission endpoint, and the public reviews
-- wall (server component reads approved rows via service role). No direct client
-- access.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.reviews (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rating             integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title              text,
  body               text,
  author_name        text,
  author_email       text,
  source             text NOT NULL DEFAULT 'internal'
                       CHECK (source IN ('internal','google','app_store','trustpilot','nps','import')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','featured','rejected')),
  reply              text,
  replied_at         timestamptz,
  replied_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  family_id          uuid REFERENCES public.families(id) ON DELETE SET NULL,
  survey_response_id uuid REFERENCES public.survey_responses(id) ON DELETE SET NULL,
  submitted_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON public.reviews (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON public.reviews (rating);

DROP TRIGGER IF EXISTS trg_reviews_updated_at ON public.reviews;
drop trigger if exists trg_reviews_updated_at on public.reviews;
CREATE TRIGGER trg_reviews_updated_at
  BEFORE UPDATE ON public.reviews
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.reputation_settings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton          boolean NOT NULL DEFAULT true UNIQUE,  -- enforce a single row
  google_url         text,
  app_store_url      text,
  play_store_url     text,
  trustpilot_url     text,
  request_headline   text,
  request_message    text,
  thank_you_high     text,
  thank_you_low      text,
  min_public_rating  integer NOT NULL DEFAULT 4 CHECK (min_public_rating BETWEEN 1 AND 5),
  auto_approve_min   integer CHECK (auto_approve_min BETWEEN 1 AND 5),
  updated_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_reputation_settings_updated_at ON public.reputation_settings;
drop trigger if exists trg_reputation_settings_updated_at on public.reputation_settings;
CREATE TRIGGER trg_reputation_settings_updated_at
  BEFORE UPDATE ON public.reputation_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS on, no policies → service-role only.
ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reputation_settings ENABLE ROW LEVEL SECURITY;



-- ══════════ 0042_family_location.sql ══════════
-- ============================================================
-- Migration 0042: Family Location (locator, places, geofencing)
-- Bubaly's answer to FamilyWall's flagship "Family Locator". Three tables:
--   family_places     — saved places (home/school/work) with a geofence radius
--   member_locations  — each member's latest position (one row per member)
--   location_events   — arrival/departure/ping history
-- Location sharing is strictly opt-in (member_locations.is_sharing) and every
-- row is family-scoped via is_family_member RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE location_event_type AS ENUM ('arrived', 'left', 'ping');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.family_places (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  icon        text,                       -- home / school / work / gym / other
  address     text,
  latitude    double precision NOT NULL,
  longitude   double precision NOT NULL,
  radius_m    integer NOT NULL DEFAULT 150,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_places_family ON public.family_places(family_id);

CREATE TABLE IF NOT EXISTS public.member_locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  latitude    double precision,
  longitude   double precision,
  accuracy_m  double precision,
  battery     integer,                     -- 0–100 if reported
  place_id    uuid REFERENCES public.family_places(id) ON DELETE SET NULL,
  is_sharing  boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id)
);
CREATE INDEX IF NOT EXISTS idx_member_locations_family ON public.member_locations(family_id);

CREATE TABLE IF NOT EXISTS public.location_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  place_id    uuid REFERENCES public.family_places(id) ON DELETE SET NULL,
  place_name  text,                        -- snapshot so history survives place edits
  event_type  location_event_type NOT NULL DEFAULT 'ping',
  latitude    double precision,
  longitude   double precision,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_location_events_member ON public.location_events(family_id, member_id, occurred_at DESC);

-- updated_at triggers
DROP TRIGGER IF EXISTS trg_set_updated_at ON public.family_places;
drop trigger if exists trg_set_updated_at on public.family_places;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.family_places
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_set_updated_at ON public.member_locations;
drop trigger if exists trg_set_updated_at on public.member_locations;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.member_locations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS (explicit per-table; no DO/format loop so the dashboard SQL editor
--    never injects ALTER statements into a dollar-quoted block) ──────────────
ALTER TABLE public.family_places ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage family_places" ON public.family_places;
drop policy if exists "Members can manage family_places" on public.family_places;
CREATE POLICY "Members can manage family_places" ON public.family_places
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.member_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage member_locations" ON public.member_locations;
drop policy if exists "Members can manage member_locations" on public.member_locations;
CREATE POLICY "Members can manage member_locations" ON public.member_locations
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.location_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage location_events" ON public.location_events;
drop policy if exists "Members can manage location_events" on public.location_events;
CREATE POLICY "Members can manage location_events" ON public.location_events
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0042_loyalty.sql ══════════
-- ============================================================
-- Migration 0042: Loyalty & Rewards — Marketing Pillar 3
-- A points-based loyalty program for customer families: earn points (signup,
-- referral, review, spend, manual), climb tiers, and redeem from a rewards
-- catalog. Pairs with Referrals (Pillar shipped) and Reviews (Pillar 2).
--
-- loyalty_settings     — singleton program config (earn rules + tier thresholds).
-- loyalty_rewards      — the redeemable catalog (admin-defined).
-- loyalty_accounts     — one per family: balance + lifetime + tier.
-- loyalty_transactions — the points ledger (signed, with running balance_after).
-- loyalty_redemptions  — a redeemed reward + fulfillment state.
--
-- A family can READ its own account/ledger/redemptions and the active catalog
-- (the same model as Referrals). All point mutations happen through the
-- service-role engine (lib/loyalty/server.ts): admin actions + the redeem action,
-- so balances can never be tampered with client-side. Hence no client write
-- policies; settings/redemption writes are service-role only.
-- ============================================================

-- ---------- Program settings (singleton) ----------
CREATE TABLE IF NOT EXISTS public.loyalty_settings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  singleton         boolean NOT NULL DEFAULT true UNIQUE,
  enabled           boolean NOT NULL DEFAULT false,
  program_name      text NOT NULL DEFAULT 'Bubaly Rewards',
  points_label      text NOT NULL DEFAULT 'points',
  earn_signup       integer NOT NULL DEFAULT 100,
  earn_referral     integer NOT NULL DEFAULT 500,
  earn_review       integer NOT NULL DEFAULT 50,
  earn_per_dollar   numeric(6,2) NOT NULL DEFAULT 1,
  tier_silver_at    integer NOT NULL DEFAULT 1000,
  tier_gold_at      integer NOT NULL DEFAULT 5000,
  updated_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------- Rewards catalog ----------
CREATE TABLE IF NOT EXISTS public.loyalty_rewards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  cost_points  integer NOT NULL CHECK (cost_points >= 0),
  kind         text NOT NULL DEFAULT 'credit'
                 CHECK (kind IN ('credit','free_month','discount','swag','donation','custom')),
  value_cents  integer,
  image_url    text,
  stock        integer,                       -- NULL = unlimited
  is_active    boolean NOT NULL DEFAULT true,
  sort         integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_rewards_active ON public.loyalty_rewards (is_active, sort);

-- ---------- Per-family account ----------
CREATE TABLE IF NOT EXISTS public.loyalty_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL UNIQUE REFERENCES public.families(id) ON DELETE CASCADE,
  points_balance  integer NOT NULL DEFAULT 0,
  lifetime_points integer NOT NULL DEFAULT 0,
  tier            text NOT NULL DEFAULT 'bronze',
  joined_at       timestamptz NOT NULL DEFAULT now(),
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- Points ledger ----------
CREATE TABLE IF NOT EXISTS public.loyalty_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  points        integer NOT NULL,             -- signed: +earn / -redeem
  kind          text NOT NULL DEFAULT 'earn'
                  CHECK (kind IN ('earn','redeem','adjust','expire')),
  reason        text,
  source        text,                         -- signup | referral | review | purchase | manual | redemption
  balance_after integer NOT NULL DEFAULT 0,
  reward_id     uuid REFERENCES public.loyalty_rewards(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_tx_family ON public.loyalty_transactions (family_id, created_at DESC);

-- ---------- Redemptions ----------
CREATE TABLE IF NOT EXISTS public.loyalty_redemptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  reward_id     uuid REFERENCES public.loyalty_rewards(id) ON DELETE SET NULL,
  reward_name   text NOT NULL,
  cost_points   integer NOT NULL,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','fulfilled','cancelled')),
  code          text,
  fulfilled_at  timestamptz,
  fulfilled_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_family ON public.loyalty_redemptions (family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loyalty_redemptions_status ON public.loyalty_redemptions (status, created_at DESC);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['loyalty_settings','loyalty_rewards','loyalty_accounts','loyalty_transactions','loyalty_redemptions'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- RLS ----------
ALTER TABLE public.loyalty_settings ENABLE ROW LEVEL SECURITY;     -- service-role only
ALTER TABLE public.loyalty_rewards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loyalty_redemptions ENABLE ROW LEVEL SECURITY;

-- Catalog is readable by any authenticated user (families browse rewards).
DROP POLICY IF EXISTS loyalty_rewards_read ON public.loyalty_rewards;
drop policy if exists loyalty_rewards_read on public.loyalty_rewards;
CREATE POLICY loyalty_rewards_read ON public.loyalty_rewards
  FOR SELECT USING (auth.role() = 'authenticated');

-- A family can read its own account, ledger, and redemptions. All writes are
-- service-role (admin actions + the redeem engine), so no write policies.
DROP POLICY IF EXISTS loyalty_accounts_select ON public.loyalty_accounts;
drop policy if exists loyalty_accounts_select on public.loyalty_accounts;
CREATE POLICY loyalty_accounts_select ON public.loyalty_accounts
  FOR SELECT USING (public.is_family_member(family_id));

DROP POLICY IF EXISTS loyalty_transactions_select ON public.loyalty_transactions;
drop policy if exists loyalty_transactions_select on public.loyalty_transactions;
CREATE POLICY loyalty_transactions_select ON public.loyalty_transactions
  FOR SELECT USING (public.is_family_member(family_id));

DROP POLICY IF EXISTS loyalty_redemptions_select ON public.loyalty_redemptions;
drop policy if exists loyalty_redemptions_select on public.loyalty_redemptions;
CREATE POLICY loyalty_redemptions_select ON public.loyalty_redemptions
  FOR SELECT USING (public.is_family_member(family_id));



-- ══════════ 0043_chore_missions.sql ══════════
-- ============================================================
-- Migration 0043: Family Missions — AI chore proof, validation, disputes,
-- and gamification. EXTENDS the existing chores / chore_assignments / rewards
-- system (migrations 0002 + 0028); it does not replace it.
--
-- Adds:
--   * Reward/AI/safety config columns on chores.
--   * AI score + dispute flag on chore_assignments.
--   * chore_submissions      — a kid's photo/video proof for an assignment.
--   * chore_ai_validations   — structured AI verdict for a submission.
--   * chore_disputes         — kid "ask a parent" / retake flow.
--   * chore_approval_events  — append-only audit of parent decisions.
--   * kid_progress           — per-member XP, level, and streaks.
--   * badges / member_badges — gamification catalog + awards.
--   * storage bucket 'chore-proof' (private) for proof media.
--
-- All point/cash mutations still flow through the existing approval path;
-- AI never auto-pays without the parent's configured auto-approve threshold.
-- ============================================================

-- ---------- Config columns on chores ----------
ALTER TABLE public.chores
  ADD COLUMN IF NOT EXISTS category          text,
  ADD COLUMN IF NOT EXISTS difficulty         text NOT NULL DEFAULT 'medium'
    CHECK (difficulty IN ('easy','medium','hard')),
  ADD COLUMN IF NOT EXISTS est_minutes        integer,
  ADD COLUMN IF NOT EXISTS proof_required      text NOT NULL DEFAULT 'none'
    CHECK (proof_required IN ('none','photo','video','before_after')),
  ADD COLUMN IF NOT EXISTS reward_mode         text NOT NULL DEFAULT 'fixed_points'
    CHECK (reward_mode IN ('fixed_cash','fixed_points','ai_cash','ai_points','prize','responsibility')),
  ADD COLUMN IF NOT EXISTS cash_cents          integer,
  ADD COLUMN IF NOT EXISTS cash_min_cents      integer,
  ADD COLUMN IF NOT EXISTS cash_max_cents      integer,
  ADD COLUMN IF NOT EXISTS points_min          integer,
  ADD COLUMN IF NOT EXISTS points_max          integer,
  ADD COLUMN IF NOT EXISTS auto_approve_score  integer,   -- NULL = always require parent
  ADD COLUMN IF NOT EXISTS safety_level        text NOT NULL DEFAULT 'none'
    CHECK (safety_level IN ('none','caution','parent_required')),
  ADD COLUMN IF NOT EXISTS instructions        text,
  ADD COLUMN IF NOT EXISTS example_image_url   text,
  ADD COLUMN IF NOT EXISTS icon                text,
  ADD COLUMN IF NOT EXISTS is_active           boolean NOT NULL DEFAULT true;

-- ---------- AI score + dispute flag on assignments ----------
ALTER TABLE public.chore_assignments
  ADD COLUMN IF NOT EXISTS ai_score   integer,
  ADD COLUMN IF NOT EXISTS cash_awarded_cents integer,
  ADD COLUMN IF NOT EXISTS disputed   boolean NOT NULL DEFAULT false;

-- ---------- Submissions (proof) ----------
CREATE TABLE IF NOT EXISTS public.chore_submissions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  assignment_id uuid NOT NULL REFERENCES public.chore_assignments(id) ON DELETE CASCADE,
  chore_id      uuid REFERENCES public.chores(id) ON DELETE SET NULL,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'photo'
                  CHECK (kind IN ('none','photo','video','before_after')),
  media_paths   text[] NOT NULL DEFAULT '{}',   -- storage object paths (private)
  note          text,
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','ai_reviewed','approved','needs_improvement','rejected','parent_review','disputed')),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chore_submissions_family ON public.chore_submissions (family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chore_submissions_assignment ON public.chore_submissions (assignment_id);
CREATE INDEX IF NOT EXISTS idx_chore_submissions_status ON public.chore_submissions (family_id, status);

-- ---------- AI validation verdicts ----------
CREATE TABLE IF NOT EXISTS public.chore_ai_validations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id               uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  submission_id           uuid NOT NULL REFERENCES public.chore_submissions(id) ON DELETE CASCADE,
  status                  text NOT NULL
                            CHECK (status IN ('approved','needs_improvement','unclear','rejected','parent_review_required')),
  quality_score           integer,    -- 0..100
  confidence              integer,    -- 0..100
  recommended_reward_type text CHECK (recommended_reward_type IN ('cash','points','prize','none')),
  recommended_reward_amount numeric(10,2),
  kid_feedback            text,
  parent_summary          text,
  detected_issues         jsonb NOT NULL DEFAULT '[]'::jsonb,
  safety_flags            jsonb NOT NULL DEFAULT '[]'::jsonb,
  needs_parent_review     boolean NOT NULL DEFAULT true,
  model                   text,
  is_fallback             boolean NOT NULL DEFAULT false,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chore_ai_validations_sub ON public.chore_ai_validations (submission_id);

-- ---------- Disputes (kid asks a parent) ----------
CREATE TABLE IF NOT EXISTS public.chore_disputes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  submission_id uuid NOT NULL REFERENCES public.chore_submissions(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  reason        text,
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','resolved','cancelled')),
  resolution    text,
  resolved_by   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chore_disputes_family ON public.chore_disputes (family_id, status);

-- ---------- Approval audit (append-only) ----------
CREATE TABLE IF NOT EXISTS public.chore_approval_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  assignment_id uuid REFERENCES public.chore_assignments(id) ON DELETE CASCADE,
  submission_id uuid REFERENCES public.chore_submissions(id) ON DELETE SET NULL,
  actor_id      uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  action        text NOT NULL
                  CHECK (action IN ('submit','ai_validate','approve','adjust','reject','redo','dispute','resolve','auto_approve')),
  points_awarded integer,
  cash_cents    integer,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chore_approval_events_assignment ON public.chore_approval_events (assignment_id, created_at);

-- ---------- Per-member gamification progress ----------
CREATE TABLE IF NOT EXISTS public.kid_progress (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL UNIQUE REFERENCES public.family_members(id) ON DELETE CASCADE,
  xp              integer NOT NULL DEFAULT 0,
  level           integer NOT NULL DEFAULT 1,
  current_streak  integer NOT NULL DEFAULT 0,
  longest_streak  integer NOT NULL DEFAULT 0,
  last_activity   date,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_kid_progress_family ON public.kid_progress (family_id);

-- ---------- Badges catalog (global, read-only) + awards ----------
CREATE TABLE IF NOT EXISTS public.badges (
  id          text PRIMARY KEY,           -- stable slug, e.g. 'first_chore'
  name        text NOT NULL,
  description text,
  icon        text,
  sort        integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.member_badges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  badge_id    text NOT NULL REFERENCES public.badges(id) ON DELETE CASCADE,
  awarded_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, badge_id)
);
CREATE INDEX IF NOT EXISTS idx_member_badges_member ON public.member_badges (member_id);

-- Seed a starter badge catalog (idempotent).
INSERT INTO public.badges (id, name, description, icon, sort) VALUES
  ('first_chore',   'First Mission',   'Completed your very first chore.',        '🎯', 10),
  ('streak_3',      'On a Roll',       'Three days in a row.',                    '🔥', 20),
  ('streak_7',      'Week Warrior',    'Seven days in a row.',                    '⚡', 30),
  ('ten_done',      'Double Digits',   'Completed ten chores.',                   '🏅', 40),
  ('perfect_score', 'Perfectionist',   'Earned a 100 quality score from the AI.', '⭐', 50),
  ('helper',        'Team Player',     'Helped on a family quest.',               '🤝', 60),
  ('level_5',       'Rising Star',     'Reached level 5.',                        '🌟', 70)
ON CONFLICT (id) DO NOTHING;

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['chore_submissions','chore_ai_validations','chore_disputes','kid_progress'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- RLS ----------
ALTER TABLE public.chore_submissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chore_ai_validations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chore_disputes         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chore_approval_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kid_progress           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.badges                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_badges          ENABLE ROW LEVEL SECURITY;

-- Family members manage their family's submissions/disputes/progress/badges.
DROP POLICY IF EXISTS chore_submissions_all ON public.chore_submissions;
drop policy if exists chore_submissions_all on public.chore_submissions;
CREATE POLICY chore_submissions_all ON public.chore_submissions
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

DROP POLICY IF EXISTS chore_disputes_all ON public.chore_disputes;
drop policy if exists chore_disputes_all on public.chore_disputes;
CREATE POLICY chore_disputes_all ON public.chore_disputes
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

DROP POLICY IF EXISTS kid_progress_all ON public.kid_progress;
drop policy if exists kid_progress_all on public.kid_progress;
CREATE POLICY kid_progress_all ON public.kid_progress
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

DROP POLICY IF EXISTS member_badges_all ON public.member_badges;
drop policy if exists member_badges_all on public.member_badges;
CREATE POLICY member_badges_all ON public.member_badges
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

-- AI validations + approval audit are readable by the family, written by the
-- service-role engine (server actions), so SELECT only for members.
DROP POLICY IF EXISTS chore_ai_validations_select ON public.chore_ai_validations;
drop policy if exists chore_ai_validations_select on public.chore_ai_validations;
CREATE POLICY chore_ai_validations_select ON public.chore_ai_validations
  FOR SELECT TO authenticated USING (public.is_family_member(family_id));

DROP POLICY IF EXISTS chore_approval_events_select ON public.chore_approval_events;
drop policy if exists chore_approval_events_select on public.chore_approval_events;
CREATE POLICY chore_approval_events_select ON public.chore_approval_events
  FOR SELECT TO authenticated USING (public.is_family_member(family_id));

-- Badge catalog is world-readable to any signed-in user.
DROP POLICY IF EXISTS badges_read ON public.badges;
drop policy if exists badges_read on public.badges;
CREATE POLICY badges_read ON public.badges
  FOR SELECT TO authenticated USING (true);

-- ---------- Private storage bucket for proof media ----------
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('chore-proof', 'chore-proof', false, 52428800) -- 50 MB (short videos)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Family can read chore proof" ON storage.objects;
drop policy if exists "Family can read chore proof" on storage.objects;
CREATE POLICY "Family can read chore proof" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'chore-proof' AND public.is_family_member(((storage.foldername(name))[1])::uuid));

DROP POLICY IF EXISTS "Family can upload chore proof" ON storage.objects;
drop policy if exists "Family can upload chore proof" on storage.objects;
CREATE POLICY "Family can upload chore proof" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'chore-proof' AND public.is_family_member(((storage.foldername(name))[1])::uuid));

DROP POLICY IF EXISTS "Family can delete chore proof" ON storage.objects;
drop policy if exists "Family can delete chore proof" on storage.objects;
CREATE POLICY "Family can delete chore proof" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'chore-proof' AND public.is_family_member(((storage.foldername(name))[1])::uuid));



-- ══════════ 0043_wishlists.sql ══════════
-- ============================================================
-- Migration 0043: Wish Lists (gift coordination with surprise-hiding)
-- Bubaly's answer to FamilyWall's "Wish Lists". Each member keeps a list
-- of things they want; OTHER members can privately "claim" an item to
-- coordinate gifts — and the claim is hidden from the wish's owner so the
-- surprise survives (enforced in the app layer; RLS keeps it family-scoped).
-- ============================================================

DO $$ BEGIN
  CREATE TYPE wish_priority AS ENUM ('low', 'medium', 'high');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.wishlist_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  -- Whose wish this is.
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  title        text NOT NULL,
  url          text,
  price        numeric(10,2),
  priority     wish_priority NOT NULL DEFAULT 'medium',
  notes        text,
  -- Gift coordination: who has claimed/bought this for the owner. Hidden from
  -- the owner in the UI so it stays a surprise.
  claimed_by   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  claimed_at   timestamptz,
  is_purchased boolean NOT NULL DEFAULT false,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wishlist_family ON public.wishlist_items(family_id);
CREATE INDEX IF NOT EXISTS idx_wishlist_member ON public.wishlist_items(family_id, member_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.wishlist_items;
drop trigger if exists trg_set_updated_at on public.wishlist_items;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.wishlist_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.wishlist_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage wishlist_items" ON public.wishlist_items;
drop policy if exists "Members can manage wishlist_items" on public.wishlist_items;
CREATE POLICY "Members can manage wishlist_items" ON public.wishlist_items
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0044_school_timetable.sql ══════════
-- ============================================================
-- Migration 0044: School timetable — alternating-week support
-- Bubaly already stores recurring classes (school_classes: subject, teacher,
-- room, time_slot, day_of_week). FamilyWall additionally offers "alternating
-- week" timetables (A/B weeks). This adds a week_pattern so a class can repeat
-- every week, only on A weeks, or only on B weeks — powering the new visual
-- weekly timetable grid.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE week_pattern AS ENUM ('all', 'a', 'b');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.school_classes
  ADD COLUMN IF NOT EXISTS week_pattern week_pattern NOT NULL DEFAULT 'all';



-- ══════════ 0045_calendar_feeds.sql ══════════
-- ============================================================
-- Migration 0045: Calendar feed subscriptions (Subscribe to Public Calendars)
-- Bubaly could already one-shot import an ICS URL, but the subscription itself
-- lived in the browser's localStorage — so it never synced across devices,
-- never auto-refreshed, and re-importing duplicated every event. This makes
-- "Subscribe to Public Calendars (URL)" 100% server-side:
--   • calendar_feeds persists each subscription per family (RLS-scoped)
--   • calendar_events gains feed_id (cascade) + external_uid for upsert dedup
--   • a partial unique index lets re-syncs UPDATE in place instead of duplicating
-- Why Bubaly's is superior: cross-device subscriptions, nightly auto-refresh,
-- and idempotent dedup so a public calendar can change and we mirror it cleanly.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.calendar_feeds (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id      uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name           text NOT NULL,
  url            text NOT NULL,
  color          text NOT NULL DEFAULT 'blue',
  -- 'ok' | 'error' | 'pending' — surfaced in the UI with the last message.
  last_status    text NOT NULL DEFAULT 'pending',
  last_error     text,
  last_synced_at timestamptz,
  event_count    integer NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_feeds_family ON public.calendar_feeds(family_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.calendar_feeds;
drop trigger if exists trg_set_updated_at on public.calendar_feeds;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.calendar_feeds
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Link imported events back to their feed (cascade delete) and stamp the source
-- iCalendar UID so re-syncs can upsert rather than duplicate.
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS feed_id uuid REFERENCES public.calendar_feeds(id) ON DELETE CASCADE;
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS external_uid text;

-- One row per (feed, source UID): the upsert conflict target for idempotent sync.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_calendar_events_feed_uid
  ON public.calendar_events(feed_id, external_uid)
  WHERE feed_id IS NOT NULL AND external_uid IS NOT NULL;

-- ── RLS ────────────────────────────────────────────────────
ALTER TABLE public.calendar_feeds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage calendar_feeds" ON public.calendar_feeds;
drop policy if exists "Members can manage calendar_feeds" on public.calendar_feeds;
CREATE POLICY "Members can manage calendar_feeds" ON public.calendar_feeds
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0046_announcements.sql ══════════
-- ============================================================
-- Migration 0046: Family Announcements (broadcast board)
-- Parents broadcast updates ("Grandma visits Saturday", "Early dismissal
-- Friday") to the whole family. Members see them on a board and can mark them
-- read, so the poster gets simple read receipts. A Free-tier differentiator —
-- Cozi/FamilyWall have no real broadcast surface.
--
-- Posting is restricted to family admins in the app layer; RLS keeps everything
-- family-scoped. Reads are tracked per member.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.family_announcements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  author_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  author_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title            text NOT NULL,
  body             text,
  is_pinned        boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_announcements_family ON public.family_announcements(family_id, is_pinned DESC, created_at DESC);

DROP TRIGGER IF EXISTS trg_announcements_updated_at ON public.family_announcements;
drop trigger if exists trg_announcements_updated_at on public.family_announcements;
CREATE TRIGGER trg_announcements_updated_at BEFORE UPDATE ON public.family_announcements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_announcements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage announcements" ON public.family_announcements;
drop policy if exists "Members can manage announcements" on public.family_announcements;
CREATE POLICY "Members can manage announcements" ON public.family_announcements
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

CREATE TABLE IF NOT EXISTS public.announcement_reads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  announcement_id uuid NOT NULL REFERENCES public.family_announcements(id) ON DELETE CASCADE,
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id       uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT announcement_reads_once UNIQUE (announcement_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_announcement_reads_ann ON public.announcement_reads(announcement_id);

ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage announcement_reads" ON public.announcement_reads;
drop policy if exists "Members can manage announcement_reads" on public.announcement_reads;
CREATE POLICY "Members can manage announcement_reads" ON public.announcement_reads
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Families have a broadcast board with read receipts.
-- ============================================================



-- ══════════ 0047_event_rsvps.sql ══════════
-- ============================================================
-- Migration 0047: Event RSVPs (accept / decline / maybe)
-- Members can RSVP to family calendar events, and the organizer sees the tally.
-- A Free-tier differentiator — clicking an event now opens a detail view where
-- everyone can respond. Family-scoped RLS; one RSVP per member per event.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE rsvp_status AS ENUM ('accepted', 'declined', 'maybe');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.event_rsvps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES public.calendar_events(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  status       rsvp_status NOT NULL DEFAULT 'accepted',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT event_rsvps_once UNIQUE (event_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_event ON public.event_rsvps(event_id);
CREATE INDEX IF NOT EXISTS idx_event_rsvps_family ON public.event_rsvps(family_id);

DROP TRIGGER IF EXISTS trg_event_rsvps_updated_at ON public.event_rsvps;
drop trigger if exists trg_event_rsvps_updated_at on public.event_rsvps;
CREATE TRIGGER trg_event_rsvps_updated_at BEFORE UPDATE ON public.event_rsvps
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.event_rsvps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage event_rsvps" ON public.event_rsvps;
drop policy if exists "Members can manage event_rsvps" on public.event_rsvps;
CREATE POLICY "Members can manage event_rsvps" ON public.event_rsvps
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Family members can RSVP to calendar events.
-- ============================================================



-- ══════════ 0048_family_dates.sql ══════════
-- ============================================================
-- Migration 0048: Family Dates (Smart Birthday & Anniversary Center)
-- Custom recurring celebrations beyond member birthdays — anniversaries,
-- grandparents' birthdays, "Gotcha Day", etc. Member birthdays already live on
-- family_members.birthday; the Birthday Center merges both into one countdown.
-- Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE celebration_kind AS ENUM ('birthday', 'anniversary', 'holiday', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.family_dates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title       text NOT NULL,
  kind        celebration_kind NOT NULL DEFAULT 'birthday',
  -- Full date (YYYY-MM-DD); only month/day are used for the annual recurrence,
  -- but storing the year lets us show "turning N".
  event_date  date NOT NULL,
  notes       text,
  remind_days integer NOT NULL DEFAULT 7 CHECK (remind_days >= 0),
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_dates_family ON public.family_dates(family_id);

DROP TRIGGER IF EXISTS trg_family_dates_updated_at ON public.family_dates;
drop trigger if exists trg_family_dates_updated_at on public.family_dates;
CREATE TRIGGER trg_family_dates_updated_at BEFORE UPDATE ON public.family_dates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_dates ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage family_dates" ON public.family_dates;
drop policy if exists "Members can manage family_dates" on public.family_dates;
CREATE POLICY "Members can manage family_dates" ON public.family_dates
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Families can track custom celebrations alongside birthdays.
-- ============================================================



-- ══════════ 0049_ab_experiments.sql ══════════
-- ============================================================
-- Migration 0049: A/B Testing (experiments + events)
-- Marketing pillar. Admins define experiments (variants + a conversion metric);
-- the app assigns visitors to variants deterministically and records exposure /
-- conversion events. Results + statistical significance are computed at read time.
--
-- Business-wide (not family-scoped), like the rest of the marketing suite:
--   ab_experiments — RLS ENABLED, NO policies → service-role/admin console only.
--   ab_events      — RLS ENABLED, NO policies → written via the service-role
--                    tracking endpoint; read/aggregated in the admin console.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.ab_experiments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key         text NOT NULL UNIQUE,
  name        text NOT NULL,
  hypothesis  text,
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','running','paused','completed')),
  -- [{ "key": "control", "label": "Control" }, { "key": "b", "label": "Variant B" }]
  variants    jsonb NOT NULL DEFAULT '[]'::jsonb,
  metric      text NOT NULL DEFAULT 'conversion',
  winner      text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ab_experiments_status ON public.ab_experiments (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_ab_experiments_updated_at ON public.ab_experiments;
drop trigger if exists trg_ab_experiments_updated_at on public.ab_experiments;
CREATE TRIGGER trg_ab_experiments_updated_at
  BEFORE UPDATE ON public.ab_experiments
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.ab_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_key  text NOT NULL,
  variant_key     text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('exposure','conversion')),
  visitor_id      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ab_events_experiment ON public.ab_events (experiment_key, kind);
-- One exposure / one conversion per visitor per experiment (dedupes double-fires).
CREATE UNIQUE INDEX IF NOT EXISTS uq_ab_events_visitor
  ON public.ab_events (experiment_key, visitor_id, kind)
  WHERE visitor_id IS NOT NULL;

ALTER TABLE public.ab_experiments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ab_events ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Done! Experiments are authored in the admin console; events flow in via the
-- service-role tracking endpoint; results are aggregated for significance.
-- ============================================================



-- ══════════ 0050_automation_run_dedup.sql ══════════
-- ============================================================
-- Migration 0050: idempotent automation runs (event-driven triggers)
-- Event-driven workflows (form_submitted, email_opened/clicked, payment_completed)
-- now fire in real time from app events. To guarantee a workflow fires at most
-- once per logical event — even when a webhook is redelivered or a form is
-- double-submitted — we dedup on (workflow_id, subject_key). The event
-- dispatcher reserves the run row with ON CONFLICT DO NOTHING before doing any
-- work, so a duplicate event can never send a second email.
--
-- This also hardens the existing scheduled runner, which already dedups manually
-- by subject_key (= familyId); the index makes that race-proof too.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uniq_mkt_runs_workflow_subject
  ON public.marketing_automation_runs (workflow_id, subject_key)
  WHERE subject_key IS NOT NULL;



-- ══════════ 0051_checkout_sessions.sql ══════════
-- ============================================================
-- Migration 0051: checkout session tracking (abandoned-checkout automation)
-- To fire the event-driven `checkout_abandoned` workflow (#88 deferred this as
-- it needs delayed detection), we record every Stripe Checkout session we open.
-- The webhook marks it completed; a daily cron sweeps sessions still 'pending'
-- past a grace window and fires the workflow, then marks them 'abandoned' so it
-- never re-fires. Billing infra: service-role only (RLS on, no policies) — rows
-- are written by the checkout route + webhook and read by the cron.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.checkout_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   text NOT NULL UNIQUE,          -- Stripe Checkout Session id
  family_id    uuid REFERENCES public.families(id) ON DELETE CASCADE,
  email        text,
  name         text,
  plan         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'abandoned')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  abandoned_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_checkout_sessions_status ON public.checkout_sessions (status, created_at);

-- Service-role only: no policies. The checkout route + Stripe webhook (service
-- client) write; the cron reads. Never exposed to client/anon.
ALTER TABLE public.checkout_sessions ENABLE ROW LEVEL SECURITY;



-- ══════════ 0052_family_onboarding.sql ══════════
-- ============================================================
-- Migration 0052: Family onboarding details
-- Captures the "About your family" step of the customer onboarding journey:
-- household makeup, location, goals, and how they heard about Bubaly. One row
-- per family. This is family-owned data (the family can read/edit its own), and
-- the marketing platform reads it business-wide via the service role for
-- segmentation/personalization.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.family_onboarding (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id          uuid NOT NULL UNIQUE REFERENCES public.families(id) ON DELETE CASCADE,
  household_adults   integer NOT NULL DEFAULT 1 CHECK (household_adults >= 0 AND household_adults <= 20),
  household_children integer NOT NULL DEFAULT 0 CHECK (household_children >= 0 AND household_children <= 20),
  child_ages         integer[] NOT NULL DEFAULT '{}',
  region             text,                       -- state / province
  postal_code        text,
  country            text,
  goals              text[] NOT NULL DEFAULT '{}',  -- chores, calendar, meals, budget, …
  referral_source    text CHECK (referral_source IS NULL OR referral_source IN
                       ('search','friend_family','social','app_store','blog','ad','podcast','other')),
  referral_detail    text,
  completed_at       timestamptz,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_onboarding_referral ON public.family_onboarding (referral_source);

DROP TRIGGER IF EXISTS trg_family_onboarding_updated_at ON public.family_onboarding;
drop trigger if exists trg_family_onboarding_updated_at on public.family_onboarding;
CREATE TRIGGER trg_family_onboarding_updated_at BEFORE UPDATE ON public.family_onboarding
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS ────────────────────────────────────────────────────
-- A family reads/writes its own onboarding row. Marketing reads via service role.
ALTER TABLE public.family_onboarding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS family_onboarding_all ON public.family_onboarding;
drop policy if exists family_onboarding_all on public.family_onboarding;
CREATE POLICY family_onboarding_all ON public.family_onboarding
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0053_landing_metrics.sql ══════════
-- ============================================================
-- Migration 0053: Landing-page metric counters
-- Atomic increment for marketing_landing_pages.views / .conversions, used by the
-- public renderer's tracking beacon (POST /api/lp/track via the service role).
-- SECURITY DEFINER so the increment is a single atomic UPDATE (no read-modify-
-- write race); only published pages are counted. Execute is restricted to the
-- service role — the public site calls it server-side, never the browser.
-- ============================================================

CREATE OR REPLACE FUNCTION public.bump_landing_metric(p_slug text, p_metric text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_metric = 'view' THEN
    UPDATE public.marketing_landing_pages
       SET views = views + 1
     WHERE slug = p_slug AND published = true AND deleted_at IS NULL;
  ELSIF p_metric = 'conversion' THEN
    UPDATE public.marketing_landing_pages
       SET conversions = conversions + 1
     WHERE slug = p_slug AND published = true AND deleted_at IS NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_landing_metric(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_landing_metric(text, text) TO service_role;



-- ══════════ 0054_recipe_sources.sql ══════════
-- ============================================================
-- Migration 0054: Recipe source provenance on the family vault
-- When a family saves an external recipe (TheMealDB, USDA, etc.) we copy it into
-- family_recipes so it survives even if the provider API is unavailable. These
-- columns record where it came from for attribution/licensing + re-normalization.
-- Additive only (ADD COLUMN IF NOT EXISTS); family_recipes RLS is unchanged.
-- ============================================================

ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS source_provider   text;
ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS source_recipe_id  text;
ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS attribution       text;
ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS license_notes     text;
ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS imported_at       timestamptz;
ALTER TABLE public.family_recipes ADD COLUMN IF NOT EXISTS raw_payload       jsonb;

-- Dedupe / "already saved" lookups by provider source.
CREATE INDEX IF NOT EXISTS idx_family_recipes_source
  ON public.family_recipes (family_id, source_provider, source_recipe_id);

-- ============================================================
-- Done! Imported recipes carry full source attribution + raw payload.
-- ============================================================



-- ══════════ 0055_meal_votes.sql ══════════
-- ============================================================
-- Migration 0055: Family Meal Voting
-- Parents propose meal options (from the recipe vault or free-text); the family
-- votes; the highest-scoring option wins and can flow to the grocery list.
-- Family-scoped RLS throughout (is_family_member). One ballot per member/option.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.meal_votes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title            text NOT NULL,
  meal_date        date,
  meal_type        text,
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  deadline         timestamptz,
  allow_maybe      boolean NOT NULL DEFAULT true,
  winner_option_id uuid,            -- set on close (FK added below, deferrable-style via app)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meal_votes_family ON public.meal_votes (family_id, status, created_at DESC);

DROP TRIGGER IF EXISTS trg_meal_votes_updated_at ON public.meal_votes;
drop trigger if exists trg_meal_votes_updated_at on public.meal_votes;
CREATE TRIGGER trg_meal_votes_updated_at BEFORE UPDATE ON public.meal_votes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.meal_vote_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id     uuid NOT NULL REFERENCES public.meal_votes(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  recipe_id   uuid REFERENCES public.family_recipes(id) ON DELETE SET NULL,
  label       text NOT NULL,         -- denormalized recipe name or free-text option
  photo_url   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meal_vote_options_vote ON public.meal_vote_options (vote_id);

CREATE TABLE IF NOT EXISTS public.meal_vote_ballots (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vote_id     uuid NOT NULL REFERENCES public.meal_votes(id) ON DELETE CASCADE,
  option_id   uuid NOT NULL REFERENCES public.meal_vote_options(id) ON DELETE CASCADE,
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  choice      text NOT NULL DEFAULT 'yes' CHECK (choice IN ('yes','no','maybe')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT meal_vote_ballots_once UNIQUE (option_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_meal_vote_ballots_vote ON public.meal_vote_ballots (vote_id);

DROP TRIGGER IF EXISTS trg_meal_vote_ballots_updated_at ON public.meal_vote_ballots;
drop trigger if exists trg_meal_vote_ballots_updated_at on public.meal_vote_ballots;
CREATE TRIGGER trg_meal_vote_ballots_updated_at BEFORE UPDATE ON public.meal_vote_ballots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: family members manage their family's votes/options/ballots ──
ALTER TABLE public.meal_votes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage meal_votes" ON public.meal_votes;
drop policy if exists "Members manage meal_votes" on public.meal_votes;
CREATE POLICY "Members manage meal_votes" ON public.meal_votes
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.meal_vote_options ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage meal_vote_options" ON public.meal_vote_options;
drop policy if exists "Members manage meal_vote_options" on public.meal_vote_options;
CREATE POLICY "Members manage meal_vote_options" ON public.meal_vote_options
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.meal_vote_ballots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage meal_vote_ballots" ON public.meal_vote_ballots;
drop policy if exists "Members manage meal_vote_ballots" on public.meal_vote_ballots;
CREATE POLICY "Members manage meal_vote_ballots" ON public.meal_vote_ballots
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Families can propose, vote on, and pick winning meals.
-- ============================================================



-- ══════════ 0056_crm.sql ══════════
-- ============================================================
-- Migration 0056: CRM — contacts + sales pipeline (deals)
-- The cornerstone of the Bubaly marketing platform ("HubSpot competitor"): a
-- single source of truth for people (contacts) and revenue (deals/pipeline).
-- Business-wide marketing data → service-role only (RLS ENABLED, NO policies),
-- accessed via lib/marketing/admin.ts requireMarketingAdmin(). Mirrors the
-- 0013_marketing.sql convention.
-- ============================================================

-- ── Contacts (people: leads, prospects, customers) ─────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name      text,
  last_name       text,
  email           text,
  phone           text,
  company         text,
  -- Pipeline status of the person as a lead.
  lead_status     text NOT NULL DEFAULT 'new'
                    CHECK (lead_status IN ('new','working','qualified','unqualified','customer')),
  -- Marketing lifecycle stage (subscriber → … → evangelist).
  lifecycle_stage text NOT NULL DEFAULT 'lead'
                    CHECK (lifecycle_stage IN ('subscriber','lead','mql','sql','opportunity','customer','evangelist')),
  lead_source     text,
  -- Optional link back to a Bubaly family (when a contact becomes a customer).
  family_id       uuid REFERENCES public.families(id) ON DELETE SET NULL,
  owner_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_contacts_email ON public.crm_contacts (lower(email));
CREATE INDEX IF NOT EXISTS idx_crm_contacts_lifecycle ON public.crm_contacts (lifecycle_stage);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_status ON public.crm_contacts (lead_status);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.crm_contacts;
drop trigger if exists trg_set_updated_at on public.crm_contacts;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.crm_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Deals (sales pipeline / revenue) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_deals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id  uuid REFERENCES public.crm_contacts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  amount_cents integer NOT NULL DEFAULT 0,
  currency    text NOT NULL DEFAULT 'usd',
  -- Pipeline stage. 'won'/'lost' are terminal.
  stage       text NOT NULL DEFAULT 'lead'
                CHECK (stage IN ('lead','qualified','proposal','negotiation','won','lost')),
  close_date  date,
  owner_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes       text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_deals_stage ON public.crm_deals (stage);
CREATE INDEX IF NOT EXISTS idx_crm_deals_contact ON public.crm_deals (contact_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.crm_deals;
drop trigger if exists trg_set_updated_at on public.crm_deals;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.crm_deals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── RLS: service-role only (admin marketing data) ──────────────────────────
ALTER TABLE public.crm_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_deals    ENABLE ROW LEVEL SECURITY;



-- ══════════ 0057_crm_quotes.sql ══════════
-- ============================================================
-- Migration 0057: Proposals / Quotes (Sales & Revenue pillar)
-- Converts qualified leads into customers — a quote tied to a CRM contact (and
-- optionally a deal), with a status lifecycle and an expiry. Service-role only
-- (RLS ENABLED, NO policies), per the marketing-table convention.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.crm_quotes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   uuid REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  deal_id      uuid REFERENCES public.crm_deals(id) ON DELETE SET NULL,
  title        text NOT NULL,
  status       text NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','sent','accepted','declined','expired')),
  amount_cents integer NOT NULL DEFAULT 0,
  currency     text NOT NULL DEFAULT 'usd',
  valid_until  date,
  notes        text,
  sent_at      timestamptz,
  responded_at timestamptz,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_quotes_status ON public.crm_quotes (status);
CREATE INDEX IF NOT EXISTS idx_crm_quotes_contact ON public.crm_quotes (contact_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.crm_quotes;
drop trigger if exists trg_set_updated_at on public.crm_quotes;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.crm_quotes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.crm_quotes ENABLE ROW LEVEL SECURITY;



-- ══════════ 0058_visitor_intelligence.sql ══════════
-- ============================================================
-- Migration 0058: Customer Intelligence Layer
-- Visitor Tracking + Attribution + CDP-lite identity stitching.
--   mkt_visitors    — one row per anonymous visitor (the CDP profile spine);
--                     contact_id links it to a CRM contact once identified.
--   mkt_sessions    — a visit, with its acquisition source/medium/campaign.
--   mkt_touchpoints — every marketing touch, for multi-touch attribution.
-- Service-role only (RLS ENABLED, NO policies). Written by /api/mkt/track and
-- read by the admin intelligence page. Mirrors the marketing-table convention.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mkt_visitors (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anonymous_id text NOT NULL UNIQUE,                 -- cookie/device id from the client
  contact_id   uuid REFERENCES public.crm_contacts(id) ON DELETE SET NULL, -- identity stitch
  device_type  text,                                 -- mobile | desktop | tablet
  country      text,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  session_count integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_visitors_contact ON public.mkt_visitors (contact_id);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.mkt_visitors;
drop trigger if exists trg_set_updated_at on public.mkt_visitors;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.mkt_visitors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.mkt_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id  uuid REFERENCES public.mkt_visitors(id) ON DELETE CASCADE,
  source      text,                                  -- google | direct | newsletter | …
  medium      text,                                  -- organic | cpc | email | referral | …
  campaign    text,
  landing_path text,
  page_views  integer NOT NULL DEFAULT 1,
  started_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_sessions_visitor ON public.mkt_sessions (visitor_id);
CREATE INDEX IF NOT EXISTS idx_mkt_sessions_started ON public.mkt_sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS public.mkt_touchpoints (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id  uuid REFERENCES public.mkt_visitors(id) ON DELETE CASCADE,
  source      text,
  medium      text,
  campaign    text,
  -- 'conversion' marks the touch where the visitor converted (signup/purchase).
  kind        text NOT NULL DEFAULT 'touch' CHECK (kind IN ('touch','conversion')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_touchpoints_visitor ON public.mkt_touchpoints (visitor_id, occurred_at);

ALTER TABLE public.mkt_visitors    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mkt_touchpoints ENABLE ROW LEVEL SECURITY;



-- ══════════ 0059_reputation.sql ══════════
-- ============================================================
-- Migration 0059: Reputation & Trust — testimonials + case studies
-- Social proof and enterprise sales enablement. Distinct from `reviews` (#41,
-- inbound moderated ratings): these are curated, published marketing assets.
-- Service-role only for writes (RLS ENABLED, NO policies); the public marketing
-- site reads published rows via the service client in a server component.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.testimonials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_name  text NOT NULL,
  author_role  text,
  company      text,
  quote        text NOT NULL,
  rating       integer CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  avatar_url   text,
  is_published boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_testimonials_published ON public.testimonials (is_published, sort_order);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.testimonials;
drop trigger if exists trg_set_updated_at on public.testimonials;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.testimonials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.case_studies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  slug          text NOT NULL UNIQUE,
  industry      text,
  customer_name text,
  summary       text,
  body          text,
  result_metric text,                      -- e.g. "Saved 6 hrs/week"
  is_published  boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_case_studies_published ON public.case_studies (is_published);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.case_studies;
drop trigger if exists trg_set_updated_at on public.case_studies;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.case_studies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.testimonials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.case_studies ENABLE ROW LEVEL SECURITY;



-- ══════════ 0060_marketing_assets.sql ══════════
-- ============================================================
-- Migration 0060: Asset Library (DAM) — marketing_assets + private bucket
-- A central digital-asset manager for the marketing OS: images, video, docs and
-- brand files, reusable by Email / Social / Content / Landing pickers.
-- Business-wide (NOT family-scoped): RLS ENABLED, NO policies → service-role only.
-- Files live in a PRIVATE storage bucket with no storage.objects policies, so the
-- service role is the only reader/writer (admin pages mint short-lived signed URLs).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  kind         text NOT NULL DEFAULT 'image' CHECK (kind IN ('image','video','document','brand')),
  storage_path text NOT NULL,
  mime_type    text,
  size_bytes   bigint,
  width        integer,
  height       integer,
  alt_text     text,
  tags         text[] NOT NULL DEFAULT '{}',
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_assets_kind ON public.marketing_assets (kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_marketing_assets_tags ON public.marketing_assets USING gin (tags);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.marketing_assets;
drop trigger if exists trg_set_updated_at on public.marketing_assets;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.marketing_assets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketing_assets ENABLE ROW LEVEL SECURITY;
-- NO policies → service-role only (matches the marketing-table convention).

-- Private "marketing-assets" Storage bucket. No storage.objects policies are
-- created, so only the service role can read/write; the admin console mints
-- short-lived signed URLs for previews. 50 MB per file.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('marketing-assets', 'marketing-assets', false, 52428800)
ON CONFLICT (id) DO NOTHING;



-- ══════════ 0061_marketing_videos.sql ══════════
-- ============================================================
-- Migration 0061: Video Marketing — marketing_videos
-- Catalog of marketing videos (YouTube / Vimeo embeds or uploaded files from the
-- Asset Library). Transcripts feed AEO/SEO; published videos embed in content +
-- landing pages. Business-wide: RLS ENABLED, NO policies → service-role only.
-- Uploaded videos reference an object in the private "marketing-assets" bucket
-- (created in 0058); external videos store provider + video_id + url.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_videos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title            text NOT NULL,
  provider         text NOT NULL DEFAULT 'youtube' CHECK (provider IN ('youtube','vimeo','upload')),
  video_id         text,        -- external id for youtube/vimeo
  url              text,        -- original source url (youtube/vimeo)
  storage_path     text,        -- for provider='upload' (marketing-assets bucket)
  poster_url       text,
  captions_url     text,
  transcript       text,
  duration_seconds integer,
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  tags             text[] NOT NULL DEFAULT '{}',
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_marketing_videos_status ON public.marketing_videos (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.marketing_videos;
drop trigger if exists trg_set_updated_at on public.marketing_videos;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.marketing_videos
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketing_videos ENABLE ROW LEVEL SECURITY;
-- NO policies → service-role only (matches the marketing-table convention).



-- ══════════ 0062_personalization.sql ══════════
-- ============================================================
-- Migration 0062: Personalization Engine — marketing_personalization_rules
-- Per-slot content variants resolved against a visitor/segment context (UTM
-- source/medium/campaign, returning, segments, session count, path, country).
-- The server picks the highest-priority matching rule for a slot (e.g.
-- home_hero, pricing_cta) and renders its variant; exposures can be recorded via
-- the A/B /api/ab/track plumbing. Business-wide: RLS ENABLED, NO policies →
-- service-role only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_personalization_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slot        text NOT NULL,                       -- e.g. home_hero, pricing_cta
  match       jsonb NOT NULL DEFAULT '{}'::jsonb,  -- audience constraints (all must hold)
  variant     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- content: headline/subhead/body/cta_*
  priority    integer NOT NULL DEFAULT 0,          -- higher wins
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_personalization_slot
  ON public.marketing_personalization_rules (slot, status, priority DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.marketing_personalization_rules;
drop trigger if exists trg_set_updated_at on public.marketing_personalization_rules;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.marketing_personalization_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketing_personalization_rules ENABLE ROW LEVEL SECURITY;
-- NO policies → service-role only (matches the marketing-table convention).



-- ══════════ 0063_marketing_push.sql ══════════
-- ============================================================
-- Migration 0063: Marketing Push Notifications — marketing_push_campaigns
-- Broadcast web/native push to opted-in devices (`push_devices`, mig 0035) via
-- the existing VAPID/FCM dispatch (lib/server/push.ts). Honors
-- `marketing_suppressions` (suppressed emails are excluded). Distinct from
-- transactional product notifications. Business-wide: RLS ENABLED, NO policies →
-- service-role only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_push_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text,
  url         text,
  segment_id  uuid REFERENCES public.marketing_segments(id) ON DELETE SET NULL, -- future targeting
  audience    text NOT NULL DEFAULT 'all_optedin' CHECK (audience IN ('all_optedin','segment')),
  status      text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sending','sent','failed')),
  recipients  integer NOT NULL DEFAULT 0,
  sent        integer NOT NULL DEFAULT 0,
  failed      integer NOT NULL DEFAULT 0,
  skipped     integer NOT NULL DEFAULT 0,
  clicked     integer NOT NULL DEFAULT 0,
  sent_at     timestamptz,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_push_status ON public.marketing_push_campaigns (status, created_at DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.marketing_push_campaigns;
drop trigger if exists trg_set_updated_at on public.marketing_push_campaigns;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.marketing_push_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketing_push_campaigns ENABLE ROW LEVEL SECURITY;
-- NO policies → service-role only (matches the marketing-table convention).



-- ══════════ 0064_exit_intent.sql ══════════
-- ============================================================
-- Migration 0064: Exit-Intent Popups — marketing_exit_intent
-- Audience-targeted offers shown on the public site when a visitor is about to
-- leave (mouseleave) or scrolls past a threshold. Reuses the personalization
-- audience-match shape. Counters are bumped from a public endpoint via a
-- SECURITY DEFINER RPC (the table has no client policies). Business-wide: RLS
-- ENABLED, NO policies → service-role only.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.marketing_exit_intent (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  headline       text NOT NULL,
  body           text,
  cta_label      text,
  cta_href       text,
  match          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- audience constraints (all must hold)
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,   -- {mode:'mouseleave'|'scroll', delayMs, scrollPercent}
  priority       integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  impressions    integer NOT NULL DEFAULT 0,
  conversions    integer NOT NULL DEFAULT 0,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  deleted_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mkt_exit_intent_active
  ON public.marketing_exit_intent (status, priority DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.marketing_exit_intent;
drop trigger if exists trg_set_updated_at on public.marketing_exit_intent;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.marketing_exit_intent
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.marketing_exit_intent ENABLE ROW LEVEL SECURITY;
-- NO policies → service-role only (matches the marketing-table convention).

-- Public counter bump. SECURITY DEFINER so the impression/conversion beacon can
-- increment without table policies; only active, non-deleted offers are counted.
CREATE OR REPLACE FUNCTION public.bump_exit_intent(p_id uuid, p_metric text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_metric = 'conversion' THEN
    UPDATE public.marketing_exit_intent
       SET conversions = conversions + 1
     WHERE id = p_id AND status = 'active' AND deleted_at IS NULL;
  ELSE
    UPDATE public.marketing_exit_intent
       SET impressions = impressions + 1
     WHERE id = p_id AND status = 'active' AND deleted_at IS NULL;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.bump_exit_intent(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bump_exit_intent(uuid, text) TO service_role;



-- ══════════ 0065_affiliates.sql ══════════
-- ============================================================
-- Migration 0065: Affiliate Management
-- Low-cost acquisition via partners who earn commission on conversions.
-- Distinct from the family Referral Program (#39, invite-a-friend rewards):
-- affiliates are external partners with a code + commission rate.
-- Service-role only (RLS ENABLED, NO policies), marketing-table convention.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.affiliates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  email           text,
  code            text NOT NULL UNIQUE,               -- ?via=CODE
  commission_rate numeric(5,4) NOT NULL DEFAULT 0.2000, -- 0.0000–1.0000
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_affiliates_status ON public.affiliates (status);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.affiliates;
drop trigger if exists trg_set_updated_at on public.affiliates;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.affiliates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.affiliate_referrals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id    uuid NOT NULL REFERENCES public.affiliates(id) ON DELETE CASCADE,
  referred_email  text,
  family_id       uuid REFERENCES public.families(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','converted','paid','void')),
  amount_cents    integer NOT NULL DEFAULT 0,         -- sale value at conversion
  commission_cents integer NOT NULL DEFAULT 0,        -- snapshot at conversion
  converted_at    timestamptz,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_affiliate ON public.affiliate_referrals (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_referrals_status ON public.affiliate_referrals (status);

ALTER TABLE public.affiliates          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.affiliate_referrals ENABLE ROW LEVEL SECURITY;



-- ══════════ 0066_competitive_intel.sql ══════════
-- ============================================================
-- Migration 0066: Competitive Intelligence
-- Competitor Monitoring + Keyword Intelligence + Backlink Monitoring (the
-- Medium-priority intel pillar). Service-role only (RLS ENABLED, NO policies),
-- per the marketing-table convention. Authored in the admin console.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.competitors (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  domain      text,
  ranking     integer,                 -- our perceived market position (1 = top)
  notes       text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_competitors_ranking ON public.competitors (ranking);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.competitors;
drop trigger if exists trg_set_updated_at on public.competitors;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.competitors
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.keyword_intel (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword       text NOT NULL,
  search_volume integer NOT NULL DEFAULT 0,   -- monthly searches
  difficulty    integer,                       -- 0–100 SEO difficulty
  our_rank      integer,                       -- our SERP position (null = unranked)
  competitor_id uuid REFERENCES public.competitors(id) ON DELETE SET NULL,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_keyword_intel_volume ON public.keyword_intel (search_volume DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.keyword_intel;
drop trigger if exists trg_set_updated_at on public.keyword_intel;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.keyword_intel
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.backlinks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_domain text NOT NULL,                 -- the site linking to us
  target_url    text,                          -- our page being linked
  authority     integer,                       -- 0–100 domain authority
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','lost','toxic')),
  discovered_at date,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_backlinks_status ON public.backlinks (status);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.backlinks;
drop trigger if exists trg_set_updated_at on public.backlinks;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.backlinks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.competitors   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_intel ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.backlinks     ENABLE ROW LEVEL SECURITY;



-- ══════════ 0067_subscription_cancel.sql ══════════
-- ============================================================
-- Migration 0067: Track scheduled cancellation on subscriptions
-- Adds cancel_at_period_end so the billing UI can show "cancels on <date>"
-- (a downgrade to Free scheduled for period end) and offer a one-tap Resume.
-- Kept in sync by the Stripe webhook (customer.subscription.updated).
-- ============================================================

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;



-- ══════════ 0068_health_visits.sql ══════════
-- ============================================================
-- Migration 0068: Health Visits log (medical · dental · vaccination · vision · …)
-- A structured visit/encounter history per family member — the backbone of a
-- world-class family medical/dental record. Captures who, when, with whom, why,
-- the outcome, follow-up date, and cost. Powers the medical + dental hubs and a
-- unified "Visits & History" view. Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE health_visit_kind AS ENUM
    ('medical','dental','vision','mental_health','specialist','vaccination','therapy','urgent_care','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.health_visits (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  provider_id     uuid REFERENCES public.health_providers(id) ON DELETE SET NULL,
  kind            health_visit_kind NOT NULL DEFAULT 'medical',
  title           text NOT NULL,
  provider_name   text,
  location        text,
  visit_date      date NOT NULL DEFAULT current_date,
  reason          text,
  outcome         text,                -- diagnosis / what happened / notes
  follow_up_date  date,
  cost_cents      integer CHECK (cost_cents IS NULL OR cost_cents >= 0),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_visits_family ON public.health_visits (family_id, visit_date DESC);
CREATE INDEX IF NOT EXISTS idx_health_visits_member ON public.health_visits (family_id, member_id);
CREATE INDEX IF NOT EXISTS idx_health_visits_followup ON public.health_visits (family_id, follow_up_date) WHERE follow_up_date IS NOT NULL;

DROP TRIGGER IF EXISTS trg_health_visits_updated_at ON public.health_visits;
drop trigger if exists trg_health_visits_updated_at on public.health_visits;
CREATE TRIGGER trg_health_visits_updated_at BEFORE UPDATE ON public.health_visits
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.health_visits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage health_visits" ON public.health_visits;
drop policy if exists "Members manage health_visits" on public.health_visits;
CREATE POLICY "Members manage health_visits" ON public.health_visits
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Structured medical/dental/vaccination visit history per member.
-- ============================================================



-- ══════════ 0069_immunizations.sql ══════════
-- ============================================================
-- Migration 0069: Structured Immunizations / Vaccine records
-- Replaces the free-text `medical_profiles.immunizations` blob with a real,
-- per-member vaccine ledger: what, when, which dose, next-due, lot #, provider.
-- High family value (school/camp/travel forms). Family-scoped RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.immunizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  vaccine         text NOT NULL,
  dose_label      text,                -- "Dose 1", "Booster", "Annual", …
  date_given      date,
  next_due_date   date,
  provider_name   text,
  lot_number      text,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_immunizations_family ON public.immunizations (family_id, member_id);
CREATE INDEX IF NOT EXISTS idx_immunizations_due ON public.immunizations (family_id, next_due_date) WHERE next_due_date IS NOT NULL;

DROP TRIGGER IF EXISTS trg_immunizations_updated_at ON public.immunizations;
drop trigger if exists trg_immunizations_updated_at on public.immunizations;
CREATE TRIGGER trg_immunizations_updated_at BEFORE UPDATE ON public.immunizations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.immunizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage immunizations" ON public.immunizations;
drop policy if exists "Members manage immunizations" on public.immunizations;
CREATE POLICY "Members manage immunizations" ON public.immunizations
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Structured per-member vaccine records with next-due tracking.
-- ============================================================



-- ══════════ 0070_vacations.sql ══════════
-- ============================================================================
-- Migration 0070: Vacation Planner — a complete family Vacation Planning OS
-- ----------------------------------------------------------------------------
-- A world-class, family-aware vacation system: trips, destinations, day-by-day
-- itineraries, flights/ground transport, lodging, activities + tickets,
-- reservations, budgets + expenses, packing, documents, emergency + medical
-- info, weather snapshots, AI recommendations, AI concierge conversations,
-- readiness (travel) scores, activity logs, notifications, and audit logs.
--
-- Every table is family-scoped (family_id NOT NULL) with is_family_member RLS,
-- has updated_at triggers, FKs with sensible cascades, and useful indexes.
-- ============================================================================

-- ---------- enums ----------
DO $$ BEGIN CREATE TYPE vacation_status AS ENUM ('planning','booked','active','completed','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vacation_kind AS ENUM ('road_trip','flight','cruise','theme_park','international','domestic','staycation','camping','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_item_kind AS ENUM ('activity','reservation','meal','travel','reminder','note','free_time'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_day_part AS ENUM ('morning','afternoon','evening','all_day'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_transport_kind AS ENUM ('car','train','bus','ferry','rideshare','shuttle','subway','walk','bike','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_lodging_kind AS ENUM ('hotel','airbnb','resort','cabin','campground','cruise_cabin','hostel','family','rental','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_budget_category AS ENUM ('flights','lodging','transportation','activities','food','shopping','insurance','fees','misc'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_pack_category AS ENUM ('clothes','toiletries','electronics','medications','documents','sports','beach','ski','camping','baby','snacks','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_doc_kind AS ENUM ('passport','id','visa','ticket','boarding_pass','hotel_confirmation','rental_confirmation','insurance','itinerary','medical','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_reco_kind AS ENUM ('missing_reservation','packing','budget_warning','weather_warning','travel_conflict','activity_suggestion','restaurant','document_missing','suggestion'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE vac_reco_status AS ENUM ('open','accepted','dismissed','done'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- core trip ----------
CREATE TABLE IF NOT EXISTS public.vacations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  title           text NOT NULL,
  kind            vacation_kind NOT NULL DEFAULT 'domestic',
  status          vacation_status NOT NULL DEFAULT 'planning',
  destination     text,                         -- primary destination label
  start_date      date,
  end_date        date,
  timezone        text,
  cover_image_url text,
  description     text,
  budget_cents    bigint CHECK (budget_cents IS NULL OR budget_cents >= 0),
  currency        text NOT NULL DEFAULT 'USD',
  is_international boolean NOT NULL DEFAULT false,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacations_family ON public.vacations (family_id, start_date);
CREATE INDEX IF NOT EXISTS idx_vacations_status ON public.vacations (family_id, status);

-- ---------- who is going ----------
CREATE TABLE IF NOT EXISTS public.vacation_members (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id         uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  member_id           uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  role                text,                      -- adult / child / grandparent / caregiver
  guest_name          text,                      -- for non-family attendees
  dietary_restrictions text,
  accessibility_needs text,
  medical_notes       text,
  preferences         text,
  emergency_contact   text,
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vacation_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_vacation_members_trip ON public.vacation_members (family_id, vacation_id);

-- ---------- destinations (multi-city / cruise stops / theme parks) ----------
CREATE TABLE IF NOT EXISTS public.vacation_destinations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id   uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  region        text,
  country       text,
  latitude      double precision,
  longitude     double precision,
  arrive_date   date,
  depart_date   date,
  sort_order    integer NOT NULL DEFAULT 0,
  notes         text,
  map_url       text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_destinations_trip ON public.vacation_destinations (family_id, vacation_id, sort_order);

-- ---------- itinerary days + items ----------
CREATE TABLE IF NOT EXISTS public.vacation_itinerary_days (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id   uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  destination_id uuid REFERENCES public.vacation_destinations(id) ON DELETE SET NULL,
  day_date      date NOT NULL,
  title         text,
  summary       text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vacation_id, day_date)
);
CREATE INDEX IF NOT EXISTS idx_vacation_days_trip ON public.vacation_itinerary_days (family_id, vacation_id, day_date);

CREATE TABLE IF NOT EXISTS public.vacation_itinerary_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id   uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  day_id        uuid REFERENCES public.vacation_itinerary_days(id) ON DELETE CASCADE,
  kind          vac_item_kind NOT NULL DEFAULT 'activity',
  day_part      vac_day_part NOT NULL DEFAULT 'morning',
  title         text NOT NULL,
  location      text,
  start_time    time,
  end_time      time,
  duration_min  integer CHECK (duration_min IS NULL OR duration_min >= 0),
  cost_cents    bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  booked        boolean NOT NULL DEFAULT false,
  confirmation_code text,
  notes         text,
  member_ids    uuid[] NOT NULL DEFAULT '{}',   -- personalized itineraries
  sort_order    integer NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_items_trip ON public.vacation_itinerary_items (family_id, vacation_id);
CREATE INDEX IF NOT EXISTS idx_vacation_items_day ON public.vacation_itinerary_items (day_id, day_part, sort_order);

-- ---------- flights ----------
CREATE TABLE IF NOT EXISTS public.vacation_flights (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  airline         text,
  flight_number   text,
  depart_airport  text,
  arrive_airport  text,
  depart_at       timestamptz,
  arrive_at       timestamptz,
  terminal        text,
  gate            text,
  seats           text,
  confirmation_code text,
  booked          boolean NOT NULL DEFAULT false,
  cost_cents      bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  document_id     uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_flights_trip ON public.vacation_flights (family_id, vacation_id, depart_at);

-- ---------- ground transportation (cars, trains, cruises legs, rideshare) ----------
CREATE TABLE IF NOT EXISTS public.vacation_transportation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  kind            vac_transport_kind NOT NULL DEFAULT 'car',
  provider        text,                          -- rental co, rail line, cruise line
  from_location   text,
  to_location     text,
  depart_at       timestamptz,
  arrive_at       timestamptz,
  confirmation_code text,
  distance_miles  numeric(8,1) CHECK (distance_miles IS NULL OR distance_miles >= 0),
  fuel_estimate_cents bigint CHECK (fuel_estimate_cents IS NULL OR fuel_estimate_cents >= 0),
  stops           jsonb NOT NULL DEFAULT '[]',   -- road-trip stops / cruise excursions
  booked          boolean NOT NULL DEFAULT false,
  cost_cents      bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_transport_trip ON public.vacation_transportation (family_id, vacation_id, depart_at);

-- ---------- lodging ----------
CREATE TABLE IF NOT EXISTS public.vacation_lodging (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  destination_id  uuid REFERENCES public.vacation_destinations(id) ON DELETE SET NULL,
  kind            vac_lodging_kind NOT NULL DEFAULT 'hotel',
  name            text NOT NULL,
  address         text,
  phone           text,
  check_in        date,
  check_out       date,
  confirmation_code text,
  nightly_cents   bigint CHECK (nightly_cents IS NULL OR nightly_cents >= 0),
  total_cents     bigint CHECK (total_cents IS NULL OR total_cents >= 0),
  booked          boolean NOT NULL DEFAULT false,
  url             text,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_lodging_trip ON public.vacation_lodging (family_id, vacation_id, check_in);

-- ---------- activities + tickets ----------
CREATE TABLE IF NOT EXISTS public.vacation_activities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  destination_id  uuid REFERENCES public.vacation_destinations(id) ON DELETE SET NULL,
  name            text NOT NULL,
  category        text,                          -- attraction / tour / restaurant / show
  location        text,
  scheduled_at    timestamptz,
  duration_min    integer CHECK (duration_min IS NULL OR duration_min >= 0),
  cost_cents      bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  family_friendly boolean NOT NULL DEFAULT true,
  url             text,
  booked          boolean NOT NULL DEFAULT false,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_activities_trip ON public.vacation_activities (family_id, vacation_id, scheduled_at);

CREATE TABLE IF NOT EXISTS public.vacation_activity_tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  activity_id     uuid REFERENCES public.vacation_activities(id) ON DELETE CASCADE,
  holder_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  holder_name     text,
  ticket_type     text,
  confirmation_code text,
  price_cents     bigint CHECK (price_cents IS NULL OR price_cents >= 0),
  document_id     uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_tickets_trip ON public.vacation_activity_tickets (family_id, vacation_id);

-- ---------- generic reservations (dining, spa, excursions, etc.) ----------
CREATE TABLE IF NOT EXISTS public.vacation_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  kind            text,                          -- dining / spa / tour / rental
  name            text NOT NULL,
  location        text,
  reserved_at     timestamptz,
  party_size      integer CHECK (party_size IS NULL OR party_size >= 0),
  confirmation_code text,
  cost_cents      bigint CHECK (cost_cents IS NULL OR cost_cents >= 0),
  booked          boolean NOT NULL DEFAULT false,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_reservations_trip ON public.vacation_reservations (family_id, vacation_id, reserved_at);

-- ---------- budget (planned by category) + expenses (actual) ----------
CREATE TABLE IF NOT EXISTS public.vacation_budgets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  category        vac_budget_category NOT NULL,
  planned_cents   bigint NOT NULL DEFAULT 0 CHECK (planned_cents >= 0),
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vacation_id, category)
);
CREATE INDEX IF NOT EXISTS idx_vacation_budgets_trip ON public.vacation_budgets (family_id, vacation_id);

CREATE TABLE IF NOT EXISTS public.vacation_expenses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  category        vac_budget_category NOT NULL DEFAULT 'misc',
  description     text NOT NULL,
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  spent_on        date NOT NULL DEFAULT current_date,
  paid_by_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_expenses_trip ON public.vacation_expenses (family_id, vacation_id, spent_on);

-- ---------- packing ----------
CREATE TABLE IF NOT EXISTS public.vacation_packing_lists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,  -- null = master/family list
  is_master       boolean NOT NULL DEFAULT false,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_packing_lists_trip ON public.vacation_packing_lists (family_id, vacation_id);

CREATE TABLE IF NOT EXISTS public.vacation_packing_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  list_id         uuid REFERENCES public.vacation_packing_lists(id) ON DELETE CASCADE,
  name            text NOT NULL,
  category        vac_pack_category NOT NULL DEFAULT 'other',
  quantity        integer NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  packed          boolean NOT NULL DEFAULT false,
  ai_suggested    boolean NOT NULL DEFAULT false,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_packing_items_list ON public.vacation_packing_items (family_id, vacation_id, list_id);

-- ---------- documents (travel docs; links to existing documents store) ----------
CREATE TABLE IF NOT EXISTS public.vacation_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  kind            vac_doc_kind NOT NULL DEFAULT 'other',
  title           text NOT NULL,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  document_id     uuid REFERENCES public.documents(id) ON DELETE SET NULL,
  file_url        text,
  number          text,                          -- passport/visa number
  issued_on       date,
  expires_on      date,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_documents_trip ON public.vacation_documents (family_id, vacation_id);

-- ---------- safety: emergency contacts + medical info ----------
CREATE TABLE IF NOT EXISTS public.vacation_emergency_contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  relationship    text,
  phone           text,
  email           text,
  category        text,                          -- doctor / insurance / embassy / local_emergency
  address         text,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_emergency_trip ON public.vacation_emergency_contacts (family_id, vacation_id);

CREATE TABLE IF NOT EXISTS public.vacation_medical_information (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  allergies       text,
  conditions      text,
  medications     text,
  blood_type      text,
  insurance_provider text,
  insurance_number text,
  physician       text,
  physician_phone text,
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_medical_trip ON public.vacation_medical_information (family_id, vacation_id);

-- ---------- checklists ----------
CREATE TABLE IF NOT EXISTS public.vacation_checklists (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  title           text NOT NULL,
  done            boolean NOT NULL DEFAULT false,
  due_date        date,
  assignee_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_checklists_trip ON public.vacation_checklists (family_id, vacation_id);

-- ---------- weather snapshots (real data cached from a weather provider) ----------
CREATE TABLE IF NOT EXISTS public.vacation_weather_snapshots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  destination_id  uuid REFERENCES public.vacation_destinations(id) ON DELETE SET NULL,
  location_label  text,
  latitude        double precision,
  longitude       double precision,
  forecast_date   date NOT NULL,
  temp_high_c     numeric(5,1),
  temp_low_c      numeric(5,1),
  precip_prob     integer CHECK (precip_prob IS NULL OR (precip_prob >= 0 AND precip_prob <= 100)),
  precip_mm       numeric(6,1),
  wind_kph        numeric(6,1),
  weather_code    integer,
  summary         text,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vacation_id, location_label, forecast_date)
);
CREATE INDEX IF NOT EXISTS idx_vacation_weather_trip ON public.vacation_weather_snapshots (family_id, vacation_id, forecast_date);

-- ---------- AI recommendations ----------
CREATE TABLE IF NOT EXISTS public.vacation_ai_recommendations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  kind            vac_reco_kind NOT NULL DEFAULT 'suggestion',
  status          vac_reco_status NOT NULL DEFAULT 'open',
  title           text NOT NULL,
  detail          text,
  severity        integer NOT NULL DEFAULT 1 CHECK (severity BETWEEN 1 AND 3),
  payload         jsonb NOT NULL DEFAULT '{}',
  source          text NOT NULL DEFAULT 'rules',  -- rules | ai
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_reco_trip ON public.vacation_ai_recommendations (family_id, vacation_id, status);

-- ---------- AI concierge conversations ----------
CREATE TABLE IF NOT EXISTS public.vacation_ai_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid REFERENCES public.vacations(id) ON DELETE CASCADE,
  title           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_ai_convos_trip ON public.vacation_ai_conversations (family_id, vacation_id);

CREATE TABLE IF NOT EXISTS public.vacation_ai_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES public.vacation_ai_conversations(id) ON DELETE CASCADE,
  role            ai_role NOT NULL,
  content         text NOT NULL,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_ai_messages_convo ON public.vacation_ai_messages (family_id, conversation_id, created_at);

-- ---------- travel/readiness score history ----------
CREATE TABLE IF NOT EXISTS public.vacation_travel_scores (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid NOT NULL REFERENCES public.vacations(id) ON DELETE CASCADE,
  score           integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  breakdown       jsonb NOT NULL DEFAULT '{}',
  computed_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_scores_trip ON public.vacation_travel_scores (family_id, vacation_id, computed_at DESC);

-- ---------- activity log + notifications + audit ----------
CREATE TABLE IF NOT EXISTS public.vacation_activity_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid REFERENCES public.vacations(id) ON DELETE CASCADE,
  actor_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  action          text NOT NULL,
  detail          text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_activity_logs_trip ON public.vacation_activity_logs (family_id, vacation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.vacation_notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid REFERENCES public.vacations(id) ON DELETE CASCADE,
  member_id       uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  title           text NOT NULL,
  body            text,
  read            boolean NOT NULL DEFAULT false,
  send_at         timestamptz,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_notifications_trip ON public.vacation_notifications (family_id, vacation_id, read);

CREATE TABLE IF NOT EXISTS public.vacation_audit_logs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id     uuid REFERENCES public.vacations(id) ON DELETE CASCADE,
  table_name      text NOT NULL,
  record_id       uuid,
  action          text NOT NULL,                 -- insert / update / delete
  changes         jsonb NOT NULL DEFAULT '{}',
  actor_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vacation_audit_trip ON public.vacation_audit_logs (family_id, vacation_id, created_at DESC);

-- ============================================================================
-- RLS + updated_at triggers, applied uniformly to every vacation table.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY[
  'vacations','vacation_members','vacation_destinations','vacation_itinerary_days',
  'vacation_itinerary_items','vacation_flights','vacation_transportation','vacation_lodging',
  'vacation_activities','vacation_activity_tickets','vacation_reservations','vacation_budgets',
  'vacation_expenses','vacation_packing_lists','vacation_packing_items','vacation_documents',
  'vacation_emergency_contacts','vacation_medical_information','vacation_checklists',
  'vacation_weather_snapshots','vacation_ai_recommendations','vacation_ai_conversations',
  'vacation_ai_messages','vacation_travel_scores','vacation_activity_logs',
  'vacation_notifications','vacation_audit_logs'
];
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
-- Done! 27 family-scoped tables powering the Bubaly Vacation Planner.
-- ============================================================================



-- ══════════ 0071_weekend_planner.sql ══════════
-- ============================================================================
-- Migration 0071: Weekend Planner — discover real local events near a ZIP code
-- ----------------------------------------------------------------------------
-- Families enter a ZIP code + a mileage radius and pull everything happening in
-- the next several days from external event providers (e.g. Ticketmaster
-- Discovery). Discovered events are cached per family, and families can shortlist
-- them into plans (interested / going / maybe / passed) with assignees + notes.
-- Family-scoped RLS, updated_at triggers, indexes.
-- ============================================================================

DO $$ BEGIN CREATE TYPE weekend_plan_status AS ENUM ('interested','going','maybe','passed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- cached discovered events ----------
CREATE TABLE IF NOT EXISTS public.weekend_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  source          text NOT NULL DEFAULT 'ticketmaster',
  external_id     text,
  title           text NOT NULL,
  category        text,
  description     text,
  venue_name      text,
  address         text,
  city            text,
  region          text,
  postal_code     text,
  latitude        double precision,
  longitude       double precision,
  starts_at       timestamptz,
  ends_at         timestamptz,
  url             text,
  image_url       text,
  price_min_cents integer CHECK (price_min_cents IS NULL OR price_min_cents >= 0),
  price_max_cents integer CHECK (price_max_cents IS NULL OR price_max_cents >= 0),
  currency        text NOT NULL DEFAULT 'USD',
  distance_miles  numeric(6,1) CHECK (distance_miles IS NULL OR distance_miles >= 0),
  is_family_friendly boolean NOT NULL DEFAULT false,
  search_zip      text,
  search_radius   integer,
  raw             jsonb NOT NULL DEFAULT '{}',
  discovered_at   timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_weekend_events_family ON public.weekend_events (family_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_weekend_events_category ON public.weekend_events (family_id, category);

-- ---------- shortlisted plans ----------
CREATE TABLE IF NOT EXISTS public.weekend_plans (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES public.weekend_events(id) ON DELETE CASCADE,
  status          weekend_plan_status NOT NULL DEFAULT 'interested',
  member_ids      uuid[] NOT NULL DEFAULT '{}',
  notes           text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_weekend_plans_family ON public.weekend_plans (family_id, status);

-- ---------- search history (drives default ZIP + radius) ----------
CREATE TABLE IF NOT EXISTS public.weekend_searches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  zip             text NOT NULL,
  radius_miles    integer NOT NULL DEFAULT 25,
  days            integer NOT NULL DEFAULT 6 CHECK (days BETWEEN 1 AND 30),
  result_count    integer NOT NULL DEFAULT 0,
  last_run_at     timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_weekend_searches_family ON public.weekend_searches (family_id, last_run_at DESC);

-- ============================================================================
-- RLS + updated_at triggers
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['weekend_events','weekend_plans','weekend_searches'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ============================================================================
-- Done! Weekend Planner — local event discovery + family shortlisting.
-- ============================================================================



-- ══════════ 0072_weekend_feeds.sql ══════════
-- ============================================================================
-- Migration 0072: Weekend Planner — local event source feeds
-- ----------------------------------------------------------------------------
-- Beyond the keyed nationwide providers (Ticketmaster, SeatGeek), families can
-- register reliable LOCAL sources as standards-based calendar/RSS feeds — a city
-- events calendar, library, parks & rec, school district, museum, etc. The
-- discovery crawler fetches each active feed, parses upcoming items in the
-- window, and merges them with provider results. Family-scoped RLS.
-- ============================================================================

DO $$ BEGIN CREATE TYPE weekend_feed_kind AS ENUM ('ics','rss'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.weekend_feeds (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  label           text NOT NULL,
  url             text NOT NULL,
  kind            weekend_feed_kind NOT NULL DEFAULT 'ics',
  is_active       boolean NOT NULL DEFAULT true,
  last_fetched_at timestamptz,
  last_status     text,                 -- 'ok' | error message
  last_count      integer NOT NULL DEFAULT 0,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, url)
);
CREATE INDEX IF NOT EXISTS idx_weekend_feeds_family ON public.weekend_feeds (family_id, is_active);

DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['weekend_feeds'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ============================================================================
-- Done! Family-curated local event feeds for the Weekend Planner crawler.
-- ============================================================================



-- ══════════ 0073_behavior_tracking.sql ══════════
-- ============================================================
-- Migration 0073: Behavior Tracking — behavior_logs (parenting insights)
-- A structured log of per-child behavior observations (positive / concern /
-- neutral) across categories (responsibility, kindness, focus, respect, mood…).
-- Powers parenting insights: balance score, trends, streaks, and AI tips.
-- Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE behavior_kind AS ENUM ('positive','concern','neutral');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.behavior_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id    uuid REFERENCES public.family_members(id) ON DELETE CASCADE,  -- the child
  kind         behavior_kind NOT NULL DEFAULT 'positive',
  category     text NOT NULL DEFAULT 'general',  -- responsibility, kindness, focus, respect, mood…
  note         text,
  points       integer NOT NULL DEFAULT 0,        -- optional +/- behavior points
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  logged_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_behavior_logs_family ON public.behavior_logs (family_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_logs_member ON public.behavior_logs (family_id, member_id, occurred_at DESC);

DROP TRIGGER IF EXISTS trg_behavior_logs_updated_at ON public.behavior_logs;
drop trigger if exists trg_behavior_logs_updated_at on public.behavior_logs;
CREATE TRIGGER trg_behavior_logs_updated_at BEFORE UPDATE ON public.behavior_logs
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.behavior_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage behavior_logs" ON public.behavior_logs;
drop policy if exists "Members manage behavior_logs" on public.behavior_logs;
CREATE POLICY "Members manage behavior_logs" ON public.behavior_logs
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0073_habits.sql ══════════
-- ============================================================================
-- Migration 0073: Habit Tracking — personal & family routine building
-- ----------------------------------------------------------------------------
-- A world-class habit tracker: per-member (or family-wide) habits with a
-- cadence + per-period target, daily/weekly check-ins, streak history, and an
-- AI coach that turns the check-in data into encouragement + nudges.
--
-- Two family-scoped tables:
--   habits       — the habit definitions (owner, cadence, target, schedule)
--   habit_logs   — one row per completion (habit + date + member)
-- Both use is_family_member RLS + the shared set_updated_at() trigger.
-- ============================================================================

DO $$ BEGIN CREATE TYPE habit_cadence AS ENUM ('daily','weekly'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- habit definitions ----------
CREATE TABLE IF NOT EXISTS public.habits (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id        uuid REFERENCES public.family_members(id) ON DELETE SET NULL,  -- null = whole-family habit
  title            text NOT NULL,
  description      text,
  icon             text NOT NULL DEFAULT 'sparkles',     -- lucide-ish key, rendered client-side
  color            text NOT NULL DEFAULT 'violet',
  cadence          habit_cadence NOT NULL DEFAULT 'daily',
  target_per_period integer NOT NULL DEFAULT 1 CHECK (target_per_period >= 1),
  reminder_time    time,                                  -- optional local reminder
  weekdays         integer[] NOT NULL DEFAULT '{}',       -- 0..6 (Sun..Sat); empty = every day
  is_active        boolean NOT NULL DEFAULT true,
  archived_at      timestamptz,
  sort_order       integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_habits_family ON public.habits (family_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_habits_member ON public.habits (family_id, member_id);

-- ---------- check-ins ----------
CREATE TABLE IF NOT EXISTS public.habit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  habit_id      uuid NOT NULL REFERENCES public.habits(id) ON DELETE CASCADE,
  member_id     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  log_date      date NOT NULL DEFAULT current_date,
  count         integer NOT NULL DEFAULT 1 CHECK (count >= 0),
  note          text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (habit_id, log_date)
);
CREATE INDEX IF NOT EXISTS idx_habit_logs_habit ON public.habit_logs (family_id, habit_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_habit_logs_date ON public.habit_logs (family_id, log_date);

-- ============================================================================
-- RLS + updated_at triggers (family-scoped, same pattern as the rest of the app)
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['habits','habit_logs'];
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
-- Done! 2 family-scoped tables powering the Bubaly Habit Tracker.
-- ============================================================================



-- ══════════ 0074_screen_time.sql ══════════
-- ============================================================
-- Migration 0074: Screen Time Dashboard — screen_time_entries + _limits
-- Daily per-child screen-time logging by category (educational / entertainment /
-- social / gaming / creative / other) with optional per-child daily limits.
-- Powers the "better balance" dashboard: totals vs limit, category mix, trends,
-- and under-limit streaks. Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE screen_time_category AS ENUM
    ('educational','entertainment','social','gaming','creative','communication','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.screen_time_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE CASCADE,
  entry_date  date NOT NULL DEFAULT current_date,
  minutes     integer NOT NULL DEFAULT 0 CHECK (minutes >= 0 AND minutes <= 1440),
  category    screen_time_category NOT NULL DEFAULT 'entertainment',
  device      text,
  note        text,
  logged_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_screen_time_family ON public.screen_time_entries (family_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_screen_time_member ON public.screen_time_entries (family_id, member_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS public.screen_time_limits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  daily_minutes integer NOT NULL DEFAULT 120 CHECK (daily_minutes >= 0 AND daily_minutes <= 1440),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, member_id)
);

DO $$ BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_screen_time_entries_updated_at ON public.screen_time_entries';
  EXECUTE 'drop trigger if exists trg_screen_time_entries_updated_at on public.screen_time_entries;
CREATE TRIGGER trg_screen_time_entries_updated_at BEFORE UPDATE ON public.screen_time_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
  EXECUTE 'DROP TRIGGER IF EXISTS trg_screen_time_limits_updated_at ON public.screen_time_limits';
  EXECUTE 'drop trigger if exists trg_screen_time_limits_updated_at on public.screen_time_limits;
CREATE TRIGGER trg_screen_time_limits_updated_at BEFORE UPDATE ON public.screen_time_limits FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
END $$;

ALTER TABLE public.screen_time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.screen_time_limits  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage screen_time_entries" ON public.screen_time_entries;
drop policy if exists "Members manage screen_time_entries" on public.screen_time_entries;
CREATE POLICY "Members manage screen_time_entries" ON public.screen_time_entries
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

DROP POLICY IF EXISTS "Members manage screen_time_limits" ON public.screen_time_limits;
drop policy if exists "Members manage screen_time_limits" on public.screen_time_limits;
CREATE POLICY "Members manage screen_time_limits" ON public.screen_time_limits
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0075_expense_splitting.sql ══════════
-- ============================================================
-- Migration 0075: Expense Splitting — expense_splits + expense_split_shares
-- Family accounting: record a shared expense (who paid, total, category), split
-- it across members, and track who owes whom until settled. Powers per-member
-- balances and minimal-transfer settlement suggestions. Family-scoped RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.expense_splits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  description text NOT NULL,
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  category    text,
  paid_by     uuid REFERENCES public.family_members(id) ON DELETE SET NULL,  -- who fronted it
  spent_on    date NOT NULL DEFAULT current_date,
  note        text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_splits_family ON public.expense_splits (family_id, spent_on DESC);

CREATE TABLE IF NOT EXISTS public.expense_split_shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  split_id    uuid NOT NULL REFERENCES public.expense_splits(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  share_cents integer NOT NULL CHECK (share_cents >= 0),
  settled     boolean NOT NULL DEFAULT false,
  settled_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_shares_split ON public.expense_split_shares (split_id);
CREATE INDEX IF NOT EXISTS idx_expense_shares_member ON public.expense_split_shares (family_id, member_id, settled);

DO $$ BEGIN
  EXECUTE 'DROP TRIGGER IF EXISTS trg_expense_splits_updated ON public.expense_splits';
  EXECUTE 'drop trigger if exists trg_expense_splits_updated on public.expense_splits;
CREATE TRIGGER trg_expense_splits_updated BEFORE UPDATE ON public.expense_splits FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
  EXECUTE 'DROP TRIGGER IF EXISTS trg_expense_shares_updated ON public.expense_split_shares';
  EXECUTE 'drop trigger if exists trg_expense_shares_updated on public.expense_split_shares;
CREATE TRIGGER trg_expense_shares_updated BEFORE UPDATE ON public.expense_split_shares FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()';
END $$;

ALTER TABLE public.expense_splits       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_split_shares ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage expense_splits" ON public.expense_splits;
drop policy if exists "Members manage expense_splits" on public.expense_splits;
CREATE POLICY "Members manage expense_splits" ON public.expense_splits
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

DROP POLICY IF EXISTS "Members manage expense_split_shares" ON public.expense_split_shares;
drop policy if exists "Members manage expense_split_shares" on public.expense_split_shares;
CREATE POLICY "Members manage expense_split_shares" ON public.expense_split_shares
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0076_subscriptions_tracked.sql ══════════
-- ============================================================
-- Migration 0076: Subscription Tracking — subscriptions_tracked
-- Track recurring paid services (streaming, apps, memberships): cost, cadence,
-- next charge, last-used. Powers "reduce waste" insights — normalised monthly /
-- annual spend and stale/unused subscription flags. Family-scoped RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.subscriptions_tracked (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  cost_cents  integer NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  cadence     text NOT NULL DEFAULT 'monthly' CHECK (cadence IN ('weekly','monthly','quarterly','yearly')),
  category    text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','trial','paused','canceled')),
  next_charge date,
  last_used   date,
  note        text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_tracked_family ON public.subscriptions_tracked (family_id, status);

DROP TRIGGER IF EXISTS trg_subscriptions_tracked_updated ON public.subscriptions_tracked;
drop trigger if exists trg_subscriptions_tracked_updated on public.subscriptions_tracked;
CREATE TRIGGER trg_subscriptions_tracked_updated BEFORE UPDATE ON public.subscriptions_tracked
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.subscriptions_tracked ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage subscriptions_tracked" ON public.subscriptions_tracked;
drop policy if exists "Members manage subscriptions_tracked" on public.subscriptions_tracked;
CREATE POLICY "Members manage subscriptions_tracked" ON public.subscriptions_tracked
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0077_tax_documents.sql ══════════
-- ============================================================
-- Migration 0077: Tax Document Vault — tax_documents
-- Organize critical tax docs by year + category (W-2, 1099, receipts,
-- deductions, statements, returns…). Files live in the existing private
-- "documents" storage bucket (family-folder RLS); this table is the index with
-- amounts for deduction totals. Family-scoped RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.tax_documents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  tax_year     integer NOT NULL,
  category     text NOT NULL DEFAULT 'other'
                 CHECK (category IN ('w2','1099','receipt','deduction','statement','return','property','charity','medical','other')),
  name         text NOT NULL,
  storage_path text,
  amount_cents integer,
  member_id    uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  note         text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_documents_family ON public.tax_documents (family_id, tax_year DESC);

DROP TRIGGER IF EXISTS trg_tax_documents_updated ON public.tax_documents;
drop trigger if exists trg_tax_documents_updated on public.tax_documents;
CREATE TRIGGER trg_tax_documents_updated BEFORE UPDATE ON public.tax_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.tax_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage tax_documents" ON public.tax_documents;
drop policy if exists "Members manage tax_documents" on public.tax_documents;
CREATE POLICY "Members manage tax_documents" ON public.tax_documents
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0078_family_polls.sql ══════════
-- ============================================================
-- Migration 0078: Group Voting — family_polls + options + votes
-- Collaborative decisions (where to go, what to do, which restaurant). Polls can
-- optionally attach to a vacation (vacation_id) for trip decisions, or stand
-- alone for any family choice. Single- or multi-choice; live tally. Family RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.family_polls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id uuid REFERENCES public.vacations(id) ON DELETE SET NULL,
  question    text NOT NULL,
  description text,
  kind        text NOT NULL DEFAULT 'single' CHECK (kind IN ('single','multi')),
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closes_at   timestamptz,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_polls_family ON public.family_polls (family_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.family_poll_options (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  poll_id   uuid NOT NULL REFERENCES public.family_polls(id) ON DELETE CASCADE,
  label     text NOT NULL,
  sort      integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_poll_options_poll ON public.family_poll_options (poll_id, sort);

CREATE TABLE IF NOT EXISTS public.family_poll_votes (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  poll_id   uuid NOT NULL REFERENCES public.family_polls(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES public.family_poll_options(id) ON DELETE CASCADE,
  member_id uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (option_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_family_poll_votes_poll ON public.family_poll_votes (poll_id);

DROP TRIGGER IF EXISTS trg_family_polls_updated ON public.family_polls;
drop trigger if exists trg_family_polls_updated on public.family_polls;
CREATE TRIGGER trg_family_polls_updated BEFORE UPDATE ON public.family_polls
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_polls        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_poll_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_poll_votes   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage family_polls" ON public.family_polls;
drop policy if exists "Members manage family_polls" on public.family_polls;
CREATE POLICY "Members manage family_polls" ON public.family_polls
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS "Members manage family_poll_options" ON public.family_poll_options;
drop policy if exists "Members manage family_poll_options" on public.family_poll_options;
CREATE POLICY "Members manage family_poll_options" ON public.family_poll_options
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));
DROP POLICY IF EXISTS "Members manage family_poll_votes" ON public.family_poll_votes;
drop policy if exists "Members manage family_poll_votes" on public.family_poll_votes;
CREATE POLICY "Members manage family_poll_votes" ON public.family_poll_votes
  FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0079_trip_memories.sql ══════════
-- ============================================================
-- Migration 0079: Trip Memories — trip_memories
-- Preserve trip experiences: a dated journal entry per memory with an optional
-- photo (stored in the private "documents" bucket), location and member. Can
-- attach to a vacation (vacation_id) or stand alone. Family-scoped RLS.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.trip_memories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  vacation_id uuid REFERENCES public.vacations(id) ON DELETE SET NULL,
  title       text NOT NULL,
  memory_date date NOT NULL DEFAULT current_date,
  note        text,
  location    text,
  photo_path  text,
  member_id   uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_memories_family ON public.trip_memories (family_id, memory_date DESC);
CREATE INDEX IF NOT EXISTS idx_trip_memories_vacation ON public.trip_memories (vacation_id);

DROP TRIGGER IF EXISTS trg_trip_memories_updated ON public.trip_memories;
drop trigger if exists trg_trip_memories_updated on public.trip_memories;
CREATE TRIGGER trg_trip_memories_updated BEFORE UPDATE ON public.trip_memories
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.trip_memories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage trip_memories" ON public.trip_memories;
drop policy if exists "Members manage trip_memories" on public.trip_memories;
CREATE POLICY "Members manage trip_memories" ON public.trip_memories
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0080_food_household.sql ══════════
-- ============================================================
-- Migration 0080: Food & Household (Tier 2)
-- Adds the missing Food & Household backing tables:
--   • pantry_items    → Pantry Tracking + Expiration Tracking + Household Inventory
--   • meal_nutrition  → AI Nutrition Analysis cache (so we never re-bill the model)
-- (Family Meal Voting already ships separately as `family_polls`/recipes voting,
--  so it is intentionally NOT duplicated here.)
-- Both tables are family-scoped member data: RLS = is_family_member(family_id).
-- ============================================================

-- ── Pantry / inventory / expiration ────────────────────────
-- One row per physical thing the household keeps on hand — food in the
-- pantry/fridge/freezer AND non-food household supplies. `expires_at` powers
-- expiration alerts; `low_threshold` powers low-stock / restock alerts.
CREATE TABLE IF NOT EXISTS public.pantry_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name          text NOT NULL,
  category      text,
  location      text NOT NULL DEFAULT 'pantry'
                  CHECK (location IN ('pantry','fridge','freezer','counter','garage','other')),
  quantity      numeric(10,2) NOT NULL DEFAULT 1,
  unit          text,
  low_threshold numeric(10,2),
  expires_at    date,
  barcode       text,
  is_staple     boolean NOT NULL DEFAULT false,
  notes         text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pantry_family   ON public.pantry_items(family_id);
CREATE INDEX IF NOT EXISTS idx_pantry_expiry   ON public.pantry_items(family_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_pantry_location ON public.pantry_items(family_id, location);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.pantry_items;
drop trigger if exists trg_set_updated_at on public.pantry_items;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.pantry_items
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.pantry_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage pantry_items" ON public.pantry_items;
drop policy if exists "Members can manage pantry_items" on public.pantry_items;
CREATE POLICY "Members can manage pantry_items" ON public.pantry_items
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ── AI nutrition analysis cache ────────────────────────────
-- Caches the model's nutrition read for a recipe, a single meal, or a whole
-- planned week so we never re-bill the model for unchanged content. Keyed by
-- (family, subject_type, subject_id) where subject_id is the recipe/meal uuid
-- or a week-start date string.
CREATE TABLE IF NOT EXISTS public.meal_nutrition (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  subject_type  text NOT NULL CHECK (subject_type IN ('recipe','meal','week')),
  subject_id    text NOT NULL,
  servings      integer,
  calories      integer,
  protein_g     numeric(8,2),
  carbs_g       numeric(8,2),
  fat_g         numeric(8,2),
  fiber_g       numeric(8,2),
  sugar_g       numeric(8,2),
  sodium_mg     numeric(8,2),
  summary       text,
  details       jsonb,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, subject_type, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_meal_nutrition_family ON public.meal_nutrition(family_id, subject_type);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.meal_nutrition;
drop trigger if exists trg_set_updated_at on public.meal_nutrition;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.meal_nutrition
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.meal_nutrition ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can read meal_nutrition" ON public.meal_nutrition;
drop policy if exists "Members can read meal_nutrition" on public.meal_nutrition;
CREATE POLICY "Members can read meal_nutrition" ON public.meal_nutrition
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0080_health_wellness.sql ══════════
-- ============================================================
-- Migration 0080: Health & Wellness — Symptom Journal + Health Goals
-- Two gaps in the Health tier:
--   symptom_logs  — a per-member symptom journal (severity, timeline, resolve).
--   health_goals  — configurable per-member targets (steps/sleep/weight/…),
--                   replacing the hard-coded 10k-step goal in the Health module.
-- Both are family-owned data: members read/write their own family's rows (RLS).
-- ============================================================

-- ---------- Symptom journal ----------
CREATE TABLE IF NOT EXISTS public.symptom_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  symptom     text NOT NULL,
  severity    integer NOT NULL DEFAULT 3 CHECK (severity BETWEEN 1 AND 5),
  body_area   text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  ended_at    timestamptz,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved')),
  notes       text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_symptom_logs_family ON public.symptom_logs (family_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_symptom_logs_member ON public.symptom_logs (member_id, status);

-- ---------- Health goals ----------
CREATE TABLE IF NOT EXISTS public.health_goals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  metric_type text NOT NULL,            -- matches health_metrics.type (steps, sleep_hours, …)
  target      numeric NOT NULL CHECK (target > 0),
  period      text NOT NULL DEFAULT 'daily' CHECK (period IN ('daily','weekly')),
  label       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, metric_type, period)
);
CREATE INDEX IF NOT EXISTS idx_health_goals_family ON public.health_goals (family_id);

-- ---------- updated_at triggers ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['symptom_logs','health_goals'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
  END LOOP;
END $$;

-- ---------- RLS (family members manage their own family's rows) ----------
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['symptom_logs','health_goals'];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%1$I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %1$s_all ON public.%1$I', t);
    EXECUTE format('CREATE POLICY %1$s_all ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
  END LOOP;
END $$;



-- ══════════ 0081_home_management.sql ══════════
-- ============================================================
-- Migration 0080: Home Management — Tier-9 gap features
-- Four family-scoped tables completing the Home Management tier:
--   utility_bills        — Utility Tracking (monitor costs over time)
--   household_info       — Household Binder (digital command center: wifi, codes,
--                          shutoffs, policies, emergency info; sensitive masking)
--   home_security_events — Security Alerts (event log + open/resolved)
--   smart_devices        — Smart Home Integration (unified device registry/status)
-- All RLS family-scoped via is_family_member(family_id).
-- ============================================================

CREATE TABLE IF NOT EXISTS public.utility_bills (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'electric'
                 CHECK (kind IN ('electric','gas','water','sewer','trash','internet','phone','cable','other')),
  provider     text,
  period_month date NOT NULL DEFAULT current_date,
  amount_cents integer NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  usage        numeric(12,2),
  unit         text,
  note         text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_utility_bills_family ON public.utility_bills (family_id, kind, period_month DESC);

CREATE TABLE IF NOT EXISTS public.household_info (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  category     text NOT NULL DEFAULT 'other'
                 CHECK (category IN ('wifi','emergency','shutoff','code','insurance','contact','instruction','account','other')),
  label        text NOT NULL,
  value        text,
  note         text,
  is_sensitive boolean NOT NULL DEFAULT false,
  sort         integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_household_info_family ON public.household_info (family_id, category, sort);

CREATE TABLE IF NOT EXISTS public.home_security_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind        text NOT NULL DEFAULT 'alert'
                 CHECK (kind IN ('alarm','camera','door','window','motion','smoke','water_leak','alert','test','breach','other')),
  severity    text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title       text NOT NULL,
  detail      text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  resolved    boolean NOT NULL DEFAULT false,
  resolved_at timestamptz,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_home_security_family ON public.home_security_events (family_id, resolved, occurred_at DESC);

CREATE TABLE IF NOT EXISTS public.smart_devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  type        text NOT NULL DEFAULT 'other'
                 CHECK (type IN ('light','lock','thermostat','camera','sensor','plug','hub','speaker','doorbell','vacuum','other')),
  room        text,
  brand       text,
  integration text NOT NULL DEFAULT 'manual'
                 CHECK (integration IN ('homekit','google','alexa','smartthings','matter','manual','other')),
  status      text NOT NULL DEFAULT 'unknown' CHECK (status IN ('online','offline','unknown')),
  last_state  text,
  note        text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_smart_devices_family ON public.smart_devices (family_id, room);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['utility_bills','household_info','home_security_events','smart_devices'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated ON public.%1$I', t);
    EXECUTE format('CREATE TRIGGER trg_%1$s_updated BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t);
    EXECUTE format('ALTER TABLE public.%1$I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "Members manage %1$s" ON public.%1$I', t);
    EXECUTE format('CREATE POLICY "Members manage %1$s" ON public.%1$I FOR ALL TO authenticated USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id))', t);
  END LOOP;
END $$;



-- ══════════ 0082_family_tree.sql ══════════
-- 0082 Family Tree — genealogy / relationship hierarchy.
-- Each node represents a person in the family tree. Nodes can link to a
-- family_member but also represent ancestors who aren't active members.

CREATE TABLE IF NOT EXISTS family_tree_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  parent_node_id uuid REFERENCES family_tree_nodes(id) ON DELETE SET NULL,
  member_id uuid REFERENCES family_members(id) ON DELETE SET NULL,
  name text NOT NULL,
  relationship text NOT NULL DEFAULT 'other',
  birth_year int,
  death_year int,
  birth_place text,
  photo_url text,
  bio text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_family_tree_nodes_family ON family_tree_nodes(family_id);
CREATE INDEX IF NOT EXISTS idx_family_tree_nodes_parent ON family_tree_nodes(parent_node_id);
CREATE INDEX IF NOT EXISTS idx_family_tree_nodes_member ON family_tree_nodes(member_id);

ALTER TABLE family_tree_nodes ENABLE ROW LEVEL SECURITY;

drop policy if exists family_tree_nodes_select on family_tree_nodes;
CREATE POLICY family_tree_nodes_select ON family_tree_nodes FOR SELECT
  USING (family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid()));
drop policy if exists family_tree_nodes_insert on family_tree_nodes;
CREATE POLICY family_tree_nodes_insert ON family_tree_nodes FOR INSERT
  WITH CHECK (family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid()));
drop policy if exists family_tree_nodes_update on family_tree_nodes;
CREATE POLICY family_tree_nodes_update ON family_tree_nodes FOR UPDATE
  USING (family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid()));
drop policy if exists family_tree_nodes_delete on family_tree_nodes;
CREATE POLICY family_tree_nodes_delete ON family_tree_nodes FOR DELETE
  USING (family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid()));

-- Replay-safety: moddatetime lives in an extension that historic databases had
-- enabled out-of-band. Creating it here idempotently keeps a fresh reset
-- replayable; no-op where it already exists.
CREATE EXTENSION IF NOT EXISTS moddatetime;

DROP TRIGGER IF EXISTS set_family_tree_nodes_updated_at ON family_tree_nodes;
drop trigger if exists set_family_tree_nodes_updated_at on family_tree_nodes;
CREATE TRIGGER set_family_tree_nodes_updated_at
  BEFORE UPDATE ON family_tree_nodes
  FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at);

-- Video sharing: add media_type to family_photos so images and videos live together.
ALTER TABLE family_photos ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'image';
ALTER TABLE family_photos ADD COLUMN IF NOT EXISTS duration_seconds int;



-- ══════════ 0083_pets.sql ══════════
-- ============================================================
-- Migration 0083: Family Pet Manager — pets + pet_care_records
-- Complete pet-care operations: a profile per animal plus a dated care ledger
-- (vaccinations, vet visits, medications, grooming, weight) with optional
-- next-due dates that power the AI care-needs engine. Family-scoped RLS.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE public.pet_species AS ENUM
    ('dog','cat','bird','fish','reptile','small_mammal','horse','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.pet_care_kind AS ENUM
    ('vaccination','vet_visit','medication','grooming','weight','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.pets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name          text NOT NULL,
  species       public.pet_species NOT NULL DEFAULT 'dog',
  breed         text,
  birthday      date,
  adoption_date date,
  weight_kg     numeric(6,2),
  color         text,
  microchip_id  text,
  photo_path    text,
  vet_name      text,
  vet_phone     text,
  notes         text,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pets_family ON public.pets (family_id, is_active);

CREATE TABLE IF NOT EXISTS public.pet_care_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  pet_id       uuid NOT NULL REFERENCES public.pets(id) ON DELETE CASCADE,
  kind         public.pet_care_kind NOT NULL DEFAULT 'vet_visit',
  title        text NOT NULL,
  record_date  date NOT NULL DEFAULT current_date,
  next_due     date,
  dose         text,
  weight_kg    numeric(6,2),
  notes        text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pet_care_family ON public.pet_care_records (family_id, record_date DESC);
CREATE INDEX IF NOT EXISTS idx_pet_care_pet ON public.pet_care_records (pet_id, record_date DESC);
CREATE INDEX IF NOT EXISTS idx_pet_care_due ON public.pet_care_records (family_id, next_due) WHERE next_due IS NOT NULL;

DROP TRIGGER IF EXISTS trg_pets_updated ON public.pets;
drop trigger if exists trg_pets_updated on public.pets;
CREATE TRIGGER trg_pets_updated BEFORE UPDATE ON public.pets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_pet_care_updated ON public.pet_care_records;
drop trigger if exists trg_pet_care_updated on public.pet_care_records;
CREATE TRIGGER trg_pet_care_updated BEFORE UPDATE ON public.pet_care_records
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.pets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage pets" ON public.pets;
drop policy if exists "Members manage pets" on public.pets;
CREATE POLICY "Members manage pets" ON public.pets
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

ALTER TABLE public.pet_care_records ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage pet_care_records" ON public.pet_care_records;
drop policy if exists "Members manage pet_care_records" on public.pet_care_records;
CREATE POLICY "Members manage pet_care_records" ON public.pet_care_records
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! Families can manage pets + a care ledger with due dates.
-- ============================================================



-- ══════════ 0084_insurance.sql ══════════
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
drop trigger if exists trg_family_insurance_updated on public.family_insurance_policies;
CREATE TRIGGER trg_family_insurance_updated BEFORE UPDATE ON public.family_insurance_policies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_insurance_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage family_insurance_policies" ON public.family_insurance_policies;
drop policy if exists "Members manage family_insurance_policies" on public.family_insurance_policies;
CREATE POLICY "Members manage family_insurance_policies" ON public.family_insurance_policies
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id)) WITH CHECK (public.is_family_member(family_id));

-- ============================================================
-- Done! One unified household insurance ledger with renewal dates + premiums.
-- ============================================================



-- ══════════ 0085_autopilot.sql ══════════
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



-- ══════════ 0086_medication_refills.sql ══════════
-- ============================================================================
-- Migration 0086: Medication refill tracking — feeds the Family Autopilot
-- ----------------------------------------------------------------------------
-- Adds an optional refill date + lead-time to medications so the autopilot can
-- predict "refill due" before a family member runs out. Purely additive,
-- nullable columns — existing rows and RLS are unaffected.
-- ============================================================================

ALTER TABLE public.medications
  ADD COLUMN IF NOT EXISTS refill_on date,
  ADD COLUMN IF NOT EXISTS refill_reminder_days integer NOT NULL DEFAULT 7
    CHECK (refill_reminder_days >= 0);

CREATE INDEX IF NOT EXISTS idx_medications_refill ON public.medications (family_id, refill_on)
  WHERE refill_on IS NOT NULL;



-- ══════════ 0087_journal.sql ══════════
-- ============================================================================
-- Migration 0087: Personal Journal — private reflection + growth
-- ----------------------------------------------------------------------------
-- A per-member journal: dated entries with a mood, optional title/body, the
-- reflection prompt that inspired it, and tags. Entries are personal (the app
-- scopes every read/write to the signed-in member), but the table uses the same
-- family-scoped RLS as the rest of the app for consistency.
-- ============================================================================

DO $$ BEGIN CREATE TYPE journal_mood AS ENUM ('great','good','okay','low','stressed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.journal_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id    uuid REFERENCES public.family_members(id) ON DELETE SET NULL, -- the author
  entry_date   date NOT NULL DEFAULT current_date,
  mood         journal_mood,
  title        text,
  body         text NOT NULL DEFAULT '',
  prompt       text,                              -- the reflection prompt used, if any
  tags         text[] NOT NULL DEFAULT '{}',
  is_private   boolean NOT NULL DEFAULT true,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_journal_member ON public.journal_entries (family_id, member_id, entry_date DESC);

-- ---- RLS + updated_at trigger (family-scoped; app scopes to the author) ----
ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage journal_entries" ON public.journal_entries;
drop policy if exists "Members manage journal_entries" on public.journal_entries;
CREATE POLICY "Members manage journal_entries" ON public.journal_entries
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_journal_entries_updated_at ON public.journal_entries;
drop trigger if exists trg_journal_entries_updated_at on public.journal_entries;
CREATE TRIGGER trg_journal_entries_updated_at BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Done! The Personal Journal store.
-- ============================================================================



-- ══════════ 0088_family_wallet.sql ══════════
-- ============================================================================
-- Migration 0088: Bubaly Family Wallet — virtual-ledger MVP
-- ----------------------------------------------------------------------------
-- The financial operating system for families. This migration builds the
-- PARENT-CONTROLLED, virtual-ledger foundation that works WITHOUT Stripe
-- Treasury/Issuing approval (the required MVP mode). Stripe-backed money
-- movement + card issuing plug into this ledger in a later phase.
--
-- Money model = an IMMUTABLE LEDGER: balances are derived by summing
-- `wallet_transactions`. Corrections are made with `reversal` rows that point at
-- the original via `reverses_id` — historical amounts/types are never edited.
-- Every table is family-scoped with is_family_member RLS (feature_flags is the
-- one global table). All amounts are integer cents.
-- ============================================================================

-- ---------- enums ----------
DO $$ BEGIN CREATE TYPE wallet_mode AS ENUM ('ledger','treasury'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wallet_bucket_kind AS ENUM ('spend','save','give','invest','goal'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wallet_txn_type AS ENUM (
  'gift_received','parent_top_up','allowance','chore_reward','babysitter_payment',
  'card_spend','card_refund','goal_transfer','bucket_transfer','withdrawal','fee','adjustment','reversal'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wallet_txn_status AS ENUM (
  'pending','requires_parent_approval','processing','completed','failed','reversed','cancelled'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE wallet_txn_direction AS ENUM ('credit','debit'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE allowance_cadence AS ENUM ('weekly','biweekly','monthly'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE approval_status AS ENUM ('pending','approved','rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- the parent-controlled family wallet ----------
CREATE TABLE IF NOT EXISTS public.family_wallets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  currency      text NOT NULL DEFAULT 'usd',
  mode          wallet_mode NOT NULL DEFAULT 'ledger',
  is_active     boolean NOT NULL DEFAULT true,
  -- compliance: parent/guardian must accept disclosures before activation
  disclosures_accepted_at timestamptz,
  disclosures_accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id)
);

-- ---------- one wallet per child ----------
CREATE TABLE IF NOT EXISTS public.child_wallets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_child_wallets_family ON public.child_wallets (family_id, is_active);

-- ---------- buckets (Spend / Save / Give / Invest / Goal) ----------
CREATE TABLE IF NOT EXISTS public.wallet_buckets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid NOT NULL REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  kind            wallet_bucket_kind NOT NULL,
  label           text NOT NULL,
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (child_wallet_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_wallet_buckets_child ON public.wallet_buckets (family_id, child_wallet_id, sort_order);

-- ---------- the immutable ledger ----------
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  bucket_id       uuid REFERENCES public.wallet_buckets(id) ON DELETE SET NULL,
  type            wallet_txn_type NOT NULL,
  status          wallet_txn_status NOT NULL DEFAULT 'completed',
  direction       wallet_txn_direction NOT NULL,           -- credit = into wallet, debit = out
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  currency        text NOT NULL DEFAULT 'usd',
  description     text,
  related_type    text,                                    -- e.g. chore_assignment | gift_payment | allowance_rule
  related_id      uuid,
  reverses_id     uuid REFERENCES public.wallet_transactions(id) ON DELETE SET NULL, -- set on reversal rows
  stripe_ref      text,                                    -- payment_intent / transfer id when Stripe-backed
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_txn_child ON public.wallet_transactions (family_id, child_wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_txn_status ON public.wallet_transactions (family_id, status);
CREATE INDEX IF NOT EXISTS idx_wallet_txn_bucket ON public.wallet_transactions (bucket_id);

-- ---------- allocation + approval rules ----------
CREATE TABLE IF NOT EXISTS public.wallet_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE, -- null = family default
  -- split percentages summing to 100, e.g. {"spend":30,"save":50,"give":10,"invest":10}
  split           jsonb NOT NULL DEFAULT '{"spend":40,"save":40,"give":10,"invest":10}',
  auto_accept_gifts boolean NOT NULL DEFAULT false,
  require_approval_over_cents bigint NOT NULL DEFAULT 5000 CHECK (require_approval_over_cents >= 0),
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, child_wallet_id)
);

-- ---------- savings goals ----------
CREATE TABLE IF NOT EXISTS public.wallet_goals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE, -- null = shared/family goal
  title           text NOT NULL,
  kind            text NOT NULL DEFAULT 'custom',          -- bike | college | car | vacation | giving | emergency | custom
  target_cents    bigint NOT NULL CHECK (target_cents >= 0),
  saved_cents     bigint NOT NULL DEFAULT 0 CHECK (saved_cents >= 0),
  target_date     date,
  status          text NOT NULL DEFAULT 'active',          -- active | reached | archived
  image_url       text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_goals_family ON public.wallet_goals (family_id, status);

-- ---------- grandparent / relative gifting ----------
CREATE TABLE IF NOT EXISTS public.gift_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  token           text NOT NULL,                           -- public share token
  occasion        text,                                    -- birthday | holiday | graduation | just_because
  message         text,
  suggested_cents integer[] NOT NULL DEFAULT '{2500,5000,10000}',
  is_active       boolean NOT NULL DEFAULT true,
  expires_at      timestamptz,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS idx_gift_links_family ON public.gift_links (family_id, is_active);

CREATE TABLE IF NOT EXISTS public.gift_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  gift_link_id    uuid REFERENCES public.gift_links(id) ON DELETE SET NULL,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  giver_name      text,
  giver_email     text,
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  message         text,
  occasion        text,
  status          wallet_txn_status NOT NULL DEFAULT 'pending',
  stripe_ref      text,                                    -- checkout session / payment intent
  applied_txn_id  uuid REFERENCES public.wallet_transactions(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gift_payments_family ON public.gift_payments (family_id, status, created_at DESC);

-- ---------- allowance automation ----------
CREATE TABLE IF NOT EXISTS public.allowance_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid NOT NULL REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  amount_cents    bigint NOT NULL CHECK (amount_cents >= 0),
  cadence         allowance_cadence NOT NULL DEFAULT 'weekly',
  split           jsonb,                                   -- optional per-rule override of wallet_rules.split
  is_active       boolean NOT NULL DEFAULT true,
  next_run_on     date,
  last_run_on     date,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_allowance_rules_due ON public.allowance_rules (is_active, next_run_on);

-- ---------- babysitter payments ----------
CREATE TABLE IF NOT EXISTS public.babysitter_profiles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,
  phone       text,
  email       text,
  rate_cents  bigint CHECK (rate_cents IS NULL OR rate_cents >= 0),
  notes       text,
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_babysitter_profiles_family ON public.babysitter_profiles (family_id, is_active);

CREATE TABLE IF NOT EXISTS public.babysitter_payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  babysitter_id uuid REFERENCES public.babysitter_profiles(id) ON DELETE SET NULL,
  event_id      uuid REFERENCES public.calendar_events(id) ON DELETE SET NULL,
  hours         numeric(5,2) CHECK (hours IS NULL OR hours >= 0),
  rate_cents    bigint CHECK (rate_cents IS NULL OR rate_cents >= 0),
  tip_cents     bigint NOT NULL DEFAULT 0 CHECK (tip_cents >= 0),
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),
  status        wallet_txn_status NOT NULL DEFAULT 'pending',
  stripe_ref    text,
  receipt_url   text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_babysitter_payments_family ON public.babysitter_payments (family_id, status, created_at DESC);

-- ---------- parent approvals (gifts/chores/spend above threshold) ----------
CREATE TABLE IF NOT EXISTS public.parent_approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind          text NOT NULL,                             -- gift | chore_reward | card_spend | withdrawal
  ref_type      text,
  ref_id        uuid,
  amount_cents  bigint,
  status        approval_status NOT NULL DEFAULT 'pending',
  requested_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_parent_approvals_family ON public.parent_approvals (family_id, status, created_at DESC);

-- ---------- audit + compliance ----------
CREATE TABLE IF NOT EXISTS public.wallet_audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action        text NOT NULL,
  entity_type   text,
  entity_id     uuid,
  detail        text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wallet_audit_family ON public.wallet_audit_logs (family_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.compliance_disclosures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind          text NOT NULL,                             -- wallet_terms | card_terms | treasury | issuing | fees
  version       text NOT NULL,
  accepted_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at   timestamptz NOT NULL DEFAULT now(),
  ip_address    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_compliance_family ON public.compliance_disclosures (family_id, kind);

-- ============================================================================
-- Family-scoped RLS + updated_at triggers for every wallet table.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY[
  'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules',
  'wallet_goals','gift_links','gift_payments','allowance_rules','babysitter_profiles',
  'babysitter_payments','parent_approvals','wallet_audit_logs','compliance_disclosures'
];
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
-- Global feature flags (NOT family-scoped). Readable by any authenticated user;
-- writes happen via service role / admin tooling. Gates the Stripe phases so the
-- app runs in virtual-ledger MVP mode until Treasury/Issuing are approved.
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.feature_flags (
  key         text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT false,
  description text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read feature_flags" ON public.feature_flags;
drop policy if exists "Authenticated read feature_flags" on public.feature_flags;
CREATE POLICY "Authenticated read feature_flags" ON public.feature_flags FOR SELECT TO authenticated USING (true);
DROP TRIGGER IF EXISTS trg_feature_flags_updated_at ON public.feature_flags;
drop trigger if exists trg_feature_flags_updated_at on public.feature_flags;
CREATE TRIGGER trg_feature_flags_updated_at BEFORE UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.feature_flags (key, enabled, description) VALUES
  ('wallet_virtual_ledger_enabled', true,  'Virtual-ledger Family Wallet (no Stripe required)'),
  ('stripe_payments_enabled',       false, 'Stripe Checkout for gifts/top-ups'),
  ('stripe_connect_enabled',        false, 'Stripe Connect parent onboarding'),
  ('stripe_treasury_enabled',       false, 'Stripe Treasury embedded financial accounts (needs approval)'),
  ('stripe_issuing_enabled',        false, 'Stripe Issuing virtual/physical cards (needs approval)'),
  ('physical_cards_enabled',        false, 'Order physical debit/prepaid cards'),
  ('custom_card_designs_enabled',   false, 'Custom Bubaly card designs (needs Stripe review)'),
  ('babysitter_payments_enabled',   true,  'Babysitter payment tracking + receipts'),
  ('grandparent_gifting_enabled',   true,  'Gift links + grandparent gifting'),
  ('ai_wallet_coach_enabled',       true,  'AI Family Financial Coach')
ON CONFLICT (key) DO NOTHING;

-- ============================================================================
-- Done! The Bubaly Family Wallet virtual-ledger foundation (14 family tables +
-- global feature flags). Stripe tables (customers/connected_accounts/financial_
-- accounts/cardholders/issuing_cards/authorizations/card_controls/card_designs/
-- webhook_events) arrive in the Stripe phase — see docs/AGENT_HANDOFF.md.
-- ============================================================================



-- ══════════ 0089_avatars_bucket.sql ══════════
-- ============================================================
-- Migration 0089: public "avatars" Storage bucket
-- Backs the onboarding + settings avatar picker (preset gradients are inline
-- data URIs and need nothing; uploaded photos go here). Public read so avatar
-- URLs render anywhere; writes are scoped to the uploader's own folder.
-- Path convention: {user_id}/{timestamp}.{ext}  (see lib/storage/avatars.ts)
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'avatars', 'avatars', true, 5242880,  -- 5 MB
  ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif']
)
ON CONFLICT (id) DO UPDATE
  SET public = true,
      file_size_limit = 5242880,
      allowed_mime_types = ARRAY['image/jpeg','image/png','image/webp','image/gif','image/avif'];

-- Public read (avatars are non-sensitive and rendered across the app).
DROP POLICY IF EXISTS "Avatars are publicly readable" ON storage.objects;
drop policy if exists "Avatars are publicly readable" on storage.objects;
CREATE POLICY "Avatars are publicly readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'avatars');

-- Authenticated users may write only inside their own {user_id}/ folder.
DROP POLICY IF EXISTS "Users upload their own avatar" ON storage.objects;
drop policy if exists "Users upload their own avatar" on storage.objects;
CREATE POLICY "Users upload their own avatar" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users update their own avatar" ON storage.objects;
drop policy if exists "Users update their own avatar" on storage.objects;
CREATE POLICY "Users update their own avatar" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1])
  WITH CHECK (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);

DROP POLICY IF EXISTS "Users delete their own avatar" ON storage.objects;
drop policy if exists "Users delete their own avatar" on storage.objects;
CREATE POLICY "Users delete their own avatar" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND auth.uid()::text = (storage.foldername(name))[1]);



-- ══════════ 0089_dashboard_layouts.sql ══════════
-- ============================================================================
-- Migration 0089: Customizable dashboard layouts (tier-aware quick actions)
-- ----------------------------------------------------------------------------
-- Stores per-user (and family-default) orderings of dashboard quick-action
-- buttons. The fixed "+" (quick_add) and AI buttons are NOT stored here — they
-- are always rendered by the app and can't be removed. Server actions validate
-- every write (tier entitlement, dedupe, max count, no fixed/locked injection);
-- RLS provides family isolation, and per-user ownership is enforced in the
-- action layer (a parent/admin may also manage the family default).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.dashboard_layouts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id      uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id        uuid REFERENCES auth.users(id) ON DELETE CASCADE,   -- null = family default
  scope          text NOT NULL DEFAULT 'user' CHECK (scope IN ('user','family')),
  device_context text NOT NULL DEFAULT 'all' CHECK (device_context IN ('all','mobile','tablet','desktop')),
  feature_keys   text[] NOT NULL DEFAULT '{}',                       -- ordered customizable button keys
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  metadata       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
-- one user layout per (user, device) and one family default per (family, device)
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_layout_user ON public.dashboard_layouts (family_id, user_id, device_context) WHERE scope = 'user' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_layout_family ON public.dashboard_layouts (family_id, device_context) WHERE scope = 'family' AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dashboard_layouts_family ON public.dashboard_layouts (family_id, scope);

CREATE TABLE IF NOT EXISTS public.dashboard_layout_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action       text NOT NULL,    -- customized | button_added | button_removed | button_replaced | reordered | reset | locked_feature_clicked | upgrade_cta_clicked | downgrade_adjusted | upgrade_adjusted
  feature_key  text,
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dashboard_events_family ON public.dashboard_layout_events (family_id, created_at DESC);

-- ---- RLS (family isolation) + updated_at trigger ----
ALTER TABLE public.dashboard_layouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage dashboard_layouts" ON public.dashboard_layouts;
drop policy if exists "Members manage dashboard_layouts" on public.dashboard_layouts;
CREATE POLICY "Members manage dashboard_layouts" ON public.dashboard_layouts
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_dashboard_layouts_updated_at ON public.dashboard_layouts;
drop trigger if exists trg_dashboard_layouts_updated_at on public.dashboard_layouts;
CREATE TRIGGER trg_dashboard_layouts_updated_at BEFORE UPDATE ON public.dashboard_layouts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.dashboard_layout_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage dashboard_layout_events" ON public.dashboard_layout_events;
drop policy if exists "Members manage dashboard_layout_events" on public.dashboard_layout_events;
CREATE POLICY "Members manage dashboard_layout_events" ON public.dashboard_layout_events
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ============================================================================
-- Done! Customizable, tier-aware dashboard layouts.
-- ============================================================================



-- ══════════ 0090_communications_hub.sql ══════════
-- AI Family Communications Hub
-- Adds family_communications message log; family_contacts already exists (0014).

-- ─── Family Communications ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS family_communications (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  contact_id    UUID        REFERENCES family_contacts(id) ON DELETE SET NULL,
  thread_id     UUID        REFERENCES family_communications(id) ON DELETE SET NULL,
  channel       TEXT        NOT NULL DEFAULT 'other'
                  CHECK (channel IN ('call','sms','email','whatsapp','instagram','school','sports','note','other')),
  direction     TEXT        NOT NULL DEFAULT 'inbound'
                  CHECK (direction IN ('inbound','outbound')),
  subject       TEXT        CHECK (char_length(subject) <= 300),
  body          TEXT        CHECK (char_length(body) <= 10000),
  summary       TEXT        CHECK (char_length(summary) <= 2000),
  action_items  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  category      TEXT        NOT NULL DEFAULT 'general'
                  CHECK (category IN ('general','school','medical','sports','social','emergency','financial','legal','other')),
  status        TEXT        NOT NULL DEFAULT 'unread'
                  CHECK (status IN ('unread','read','replied','archived','snoozed')),
  priority      TEXT        NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low','normal','high','urgent')),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS family_comms_family_idx    ON family_communications(family_id, received_at DESC);
CREATE INDEX IF NOT EXISTS family_comms_status_idx    ON family_communications(family_id, status);
CREATE INDEX IF NOT EXISTS family_comms_channel_idx   ON family_communications(family_id, channel);
CREATE INDEX IF NOT EXISTS family_comms_category_idx  ON family_communications(family_id, category);
CREATE INDEX IF NOT EXISTS family_comms_contact_idx   ON family_communications(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS family_comms_thread_idx    ON family_communications(thread_id)  WHERE thread_id  IS NOT NULL;

-- ─── Auto-updated_at trigger ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'family_communications_updated_at') THEN
    drop trigger if exists family_communications_updated_at on family_communications;
CREATE TRIGGER family_communications_updated_at
      BEFORE UPDATE ON family_communications
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ─── RLS ─────────────────────────────────────────────────────────────────
ALTER TABLE family_communications ENABLE ROW LEVEL SECURITY;

drop policy if exists "comms_family_select" on family_communications;
CREATE POLICY "comms_family_select" ON family_communications
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM family_members WHERE family_id = family_communications.family_id AND user_id = auth.uid() AND is_active)
  );

drop policy if exists "comms_family_insert" on family_communications;
CREATE POLICY "comms_family_insert" ON family_communications
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM family_members WHERE family_id = family_communications.family_id AND user_id = auth.uid() AND is_active)
  );

drop policy if exists "comms_family_update" on family_communications;
CREATE POLICY "comms_family_update" ON family_communications
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM family_members WHERE family_id = family_communications.family_id AND user_id = auth.uid() AND is_active)
  );

drop policy if exists "comms_family_delete" on family_communications;
CREATE POLICY "comms_family_delete" ON family_communications
  FOR DELETE USING (
    public.can_manage_family(family_communications.family_id)
  );

-- ─── Realtime ─────────────────────────────────────────────────────────────
do $pubguard$ begin alter publication supabase_realtime add table family_communications; exception when others then null; end $pubguard$;



-- ══════════ 0090_stripe_money.sql ══════════
-- ============================================================================
-- Migration 0090: Bubaly Money — Stripe Financial Mode (Connect/Treasury/Issuing)
-- ----------------------------------------------------------------------------
-- Phase 2 of the Family Wallet. Adds the Stripe-backed money layer that plugs
-- INTO the immutable ledger from 0088 — it never replaces it. The ledger remains
-- the single source of truth for balances; Stripe rows here just record the
-- external account/card/authorization identifiers and mirror their lifecycle.
--
-- These tables stay dormant until the matching feature_flags are switched on
-- (stripe_connect_enabled / stripe_treasury_enabled / stripe_issuing_enabled).
-- Until then the app runs in virtual-ledger mode and none of this is touched.
--
-- SECURITY: no card numbers, no bank account numbers, no PII beyond what Stripe
-- requires us to hold by reference. We store Stripe object IDs + status only.
-- Family tables are is_family_member RLS; stripe_webhook_events is service-role
-- only (RLS enabled, no policy) since it is written exclusively by the webhook.
-- ============================================================================

DO $$ BEGIN CREATE TYPE stripe_account_status AS ENUM ('pending','restricted','enabled','disabled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE stripe_card_type AS ENUM ('virtual','physical'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE stripe_card_status AS ENUM ('pending','active','inactive','canceled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE stripe_auth_outcome AS ENUM ('approved','declined'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- Connect: parent/guardian onboarding (KYC) ----------
-- One connected account per family. Required before Treasury/Issuing. We store
-- the account id + the capability/requirement state Stripe reports back.
CREATE TABLE IF NOT EXISTS public.stripe_connected_accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id          uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  stripe_account_id  text NOT NULL,
  status             stripe_account_status NOT NULL DEFAULT 'pending',
  charges_enabled    boolean NOT NULL DEFAULT false,
  payouts_enabled    boolean NOT NULL DEFAULT false,
  details_submitted  boolean NOT NULL DEFAULT false,
  treasury_enabled   boolean NOT NULL DEFAULT false,   -- Treasury capability active
  card_issuing_enabled boolean NOT NULL DEFAULT false, -- Issuing capability active
  requirements_due   jsonb NOT NULL DEFAULT '[]',      -- currently_due / past_due summary
  onboarded_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id),
  UNIQUE (stripe_account_id)
);

-- ---------- Treasury: embedded financial account ----------
CREATE TABLE IF NOT EXISTS public.stripe_financial_accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id            uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  connected_account_id uuid NOT NULL REFERENCES public.stripe_connected_accounts(id) ON DELETE CASCADE,
  stripe_financial_account_id text NOT NULL,
  status               text NOT NULL DEFAULT 'open',
  -- Cached balance for display only; the ledger remains the source of truth.
  cached_balance_cents bigint NOT NULL DEFAULT 0,
  cached_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id),
  UNIQUE (stripe_financial_account_id)
);

-- ---------- Issuing: one cardholder per child member ----------
CREATE TABLE IF NOT EXISTS public.stripe_cardholders (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id            uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id            uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  child_wallet_id      uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  stripe_cardholder_id text NOT NULL,
  status               text NOT NULL DEFAULT 'active',
  created_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, member_id),
  UNIQUE (stripe_cardholder_id)
);

-- ---------- Issuing: the cards (virtual + physical) ----------
-- We never store the PAN. last4/brand/exp are non-sensitive display fields Stripe
-- returns and are safe to cache. Full card details are fetched ephemerally via
-- Stripe.js when a parent reveals them — never persisted.
CREATE TABLE IF NOT EXISTS public.stripe_issuing_cards (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id   uuid NOT NULL REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  cardholder_id     uuid NOT NULL REFERENCES public.stripe_cardholders(id) ON DELETE CASCADE,
  stripe_card_id    text NOT NULL,
  type              stripe_card_type NOT NULL DEFAULT 'virtual',
  status            stripe_card_status NOT NULL DEFAULT 'active',
  last4             text,
  brand             text,
  exp_month         integer,
  exp_year          integer,
  design_id         uuid,                              -- optional custom design
  -- spending controls (parent-set), mirrored to Stripe spending_controls
  spend_limit_cents bigint CHECK (spend_limit_cents IS NULL OR spend_limit_cents >= 0),
  spend_window      text NOT NULL DEFAULT 'per_authorization', -- per_authorization|daily|weekly|monthly|all_time
  blocked_categories text[] NOT NULL DEFAULT '{}',     -- merchant categories the child cannot use
  is_frozen         boolean NOT NULL DEFAULT false,    -- parent "freeze card" toggle
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_card_id)
);
CREATE INDEX IF NOT EXISTS idx_issuing_cards_family ON public.stripe_issuing_cards (family_id, child_wallet_id);

-- ---------- Issuing: real-time authorization log ----------
-- Every authorization request the webhook approves/declines is recorded here for
-- audit + the activity feed. The actual money effect lives in wallet_transactions
-- (a card_spend debit on capture); this table is the Stripe-side record.
CREATE TABLE IF NOT EXISTS public.stripe_authorizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id             uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  card_id               uuid REFERENCES public.stripe_issuing_cards(id) ON DELETE SET NULL,
  child_wallet_id       uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  stripe_authorization_id text NOT NULL,
  amount_cents          bigint NOT NULL DEFAULT 0,
  merchant_name         text,
  merchant_category     text,
  outcome               stripe_auth_outcome NOT NULL,
  decline_reason        text,                          -- why we declined (insufficient_spend, frozen, blocked_category…)
  txn_id                uuid REFERENCES public.wallet_transactions(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_authorization_id)
);
CREATE INDEX IF NOT EXISTS idx_authorizations_family ON public.stripe_authorizations (family_id, created_at DESC);

-- ============================================================================
-- Family-scoped RLS + updated_at triggers (read-only for members; all writes go
-- through service-role server code so card/treasury state can't be forged client
-- side). We grant SELECT to members and restrict INSERT/UPDATE/DELETE to service.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY[
  'stripe_connected_accounts','stripe_financial_accounts','stripe_cardholders',
  'stripe_issuing_cards','stripe_authorizations'
];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    -- Members can READ their family's Stripe state (to render the Money pages).
    EXECUTE format('DROP POLICY IF EXISTS "Members read %1$s" ON public.%1$I', t);
    EXECUTE format(
      'CREATE POLICY "Members read %1$s" ON public.%1$I FOR SELECT TO authenticated USING (public.is_family_member(family_id))',
      t
    );
    -- No INSERT/UPDATE/DELETE policy → only the service role can write. This is
    -- deliberate: financial state is mutated exclusively by trusted server code.
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_updated_at ON public.%1$I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON public.%1$I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      t
    );
  END LOOP;
END $$;

-- ---------- Custom card designs (global catalog, admin-managed) ----------
CREATE TABLE IF NOT EXISTS public.stripe_card_designs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text,
  preview_url   text,
  stripe_personalization_design_id text,  -- Stripe personalization_design id when reviewed/approved
  status        text NOT NULL DEFAULT 'draft', -- draft | review | active | rejected
  is_active     boolean NOT NULL DEFAULT false,
  sort_order    integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.stripe_card_designs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read card designs" ON public.stripe_card_designs;
drop policy if exists "Authenticated read card designs" on public.stripe_card_designs;
CREATE POLICY "Authenticated read card designs" ON public.stripe_card_designs
  FOR SELECT TO authenticated USING (is_active = true);
DROP TRIGGER IF EXISTS trg_stripe_card_designs_updated_at ON public.stripe_card_designs;
drop trigger if exists trg_stripe_card_designs_updated_at on public.stripe_card_designs;
CREATE TRIGGER trg_stripe_card_designs_updated_at BEFORE UPDATE ON public.stripe_card_designs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- Webhook idempotency log (service-role only) ----------
-- Every Stripe event id is recorded here BEFORE processing. A duplicate delivery
-- (Stripe retries) is detected by the unique constraint and skipped. RLS is on
-- with NO policy, so it is invisible to clients and writable only by service role.
CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL,
  type          text NOT NULL,
  status        text NOT NULL DEFAULT 'processed', -- processed | error
  error         text,
  payload_summary jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (stripe_event_id)
);
ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_type ON public.stripe_webhook_events (type, created_at DESC);

-- ============================================================================
-- Done. Stripe Financial Mode schema. Dormant until the stripe_* feature_flags
-- are enabled. See lib/stripe/capabilities.ts for the capability-detection layer
-- that decides ledger vs Stripe mode at runtime.
-- ============================================================================



-- ══════════ 0091_concierge.sql ══════════
-- AI Concierge — stores conversation sessions and saved plans.

CREATE TABLE IF NOT EXISTS concierge_sessions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by  UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  title       TEXT        NOT NULL DEFAULT 'New Request',
  kind        TEXT        NOT NULL DEFAULT 'general'
                CHECK (kind IN ('getaway','restaurant','date_night','activity','party','travel','shopping','service','general')),
  status      TEXT        NOT NULL DEFAULT 'planning'
                CHECK (status IN ('planning','booked','confirmed','completed','cancelled')),
  notes       TEXT,
  ai_summary  TEXT,
  messages    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS concierge_plans (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  session_id    UUID        REFERENCES concierge_sessions(id) ON DELETE SET NULL,
  created_by    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  title         TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  kind          TEXT        NOT NULL DEFAULT 'general'
                  CHECK (kind IN ('getaway','restaurant','date_night','activity','party','travel','shopping','service','general')),
  description   TEXT,
  ai_suggestion TEXT,
  status        TEXT        NOT NULL DEFAULT 'idea'
                  CHECK (status IN ('idea','planning','booked','confirmed','completed','cancelled')),
  planned_for   DATE,
  budget_cents  INTEGER     CHECK (budget_cents >= 0),
  location      TEXT,
  members       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  links         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS concierge_sessions_family_idx ON concierge_sessions(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS concierge_plans_family_idx    ON concierge_plans(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS concierge_plans_kind_idx      ON concierge_plans(family_id, kind);
CREATE INDEX IF NOT EXISTS concierge_plans_status_idx    ON concierge_plans(family_id, status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'concierge_sessions_updated_at') THEN
    drop trigger if exists concierge_sessions_updated_at on concierge_sessions;
CREATE TRIGGER concierge_sessions_updated_at BEFORE UPDATE ON concierge_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'concierge_plans_updated_at') THEN
    drop trigger if exists concierge_plans_updated_at on concierge_plans;
CREATE TRIGGER concierge_plans_updated_at BEFORE UPDATE ON concierge_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE concierge_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE concierge_plans    ENABLE ROW LEVEL SECURITY;

drop policy if exists "concierge_sessions_family" on concierge_sessions;
CREATE POLICY "concierge_sessions_family" ON concierge_sessions FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = concierge_sessions.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = concierge_sessions.family_id AND user_id = auth.uid() AND is_active)
);

drop policy if exists "concierge_plans_family" on concierge_plans;
CREATE POLICY "concierge_plans_family" ON concierge_plans FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = concierge_plans.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = concierge_plans.family_id AND user_id = auth.uid() AND is_active)
);

do $pubguard$ begin alter publication supabase_realtime add table concierge_sessions; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table concierge_plans; exception when others then null; end $pubguard$;



-- ══════════ 0092_front_desk.sql ══════════
-- AI Front Desk — Call Guardian (screening) + Receptionist (answering).
-- Tables: front_desk_settings (per-family config) + call_logs (call history).

-- ─── Front Desk Settings ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS front_desk_settings (
  family_id        UUID        PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
  enabled          BOOLEAN     NOT NULL DEFAULT false,
  greeting         TEXT        NOT NULL DEFAULT 'Hi! You''ve reached the family. I''m their AI assistant — how can I help?'
                     CHECK (char_length(greeting) <= 1000),
  screening_mode   TEXT        NOT NULL DEFAULT 'smart'
                     CHECK (screening_mode IN ('off','smart','strict','allowlist')),
  voicemail_enabled BOOLEAN    NOT NULL DEFAULT true,
  forward_number   TEXT        CHECK (char_length(forward_number) <= 30),
  quiet_hours_start SMALLINT   CHECK (quiet_hours_start BETWEEN 0 AND 23),
  quiet_hours_end   SMALLINT   CHECK (quiet_hours_end BETWEEN 0 AND 23),
  block_spam       BOOLEAN     NOT NULL DEFAULT true,
  block_unknown    BOOLEAN     NOT NULL DEFAULT false,
  blocked_numbers  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  allowed_numbers  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Call Logs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS call_logs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  contact_id    UUID        REFERENCES family_contacts(id) ON DELETE SET NULL,
  caller_name   TEXT        CHECK (char_length(caller_name) <= 120),
  caller_number TEXT        CHECK (char_length(caller_number) <= 30),
  direction     TEXT        NOT NULL DEFAULT 'inbound'
                  CHECK (direction IN ('inbound','outbound')),
  status        TEXT        NOT NULL DEFAULT 'screened'
                  CHECK (status IN ('screened','answered','voicemail','blocked','missed','forwarded')),
  classification TEXT       NOT NULL DEFAULT 'unknown'
                  CHECK (classification IN ('important','known','unknown','spam','robocall','telemarketer')),
  priority      TEXT        NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low','normal','high','urgent')),
  transcript    TEXT        CHECK (char_length(transcript) <= 20000),
  ai_summary    TEXT        CHECK (char_length(ai_summary) <= 2000),
  action_items  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  voicemail_url TEXT        CHECK (char_length(voicemail_url) <= 500),
  duration_secs INTEGER     CHECK (duration_secs >= 0),
  is_read       BOOLEAN     NOT NULL DEFAULT false,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS call_logs_family_idx     ON call_logs(family_id, received_at DESC);
CREATE INDEX IF NOT EXISTS call_logs_status_idx     ON call_logs(family_id, status);
CREATE INDEX IF NOT EXISTS call_logs_class_idx      ON call_logs(family_id, classification);
CREATE INDEX IF NOT EXISTS call_logs_unread_idx     ON call_logs(family_id, is_read) WHERE is_read = false;
CREATE INDEX IF NOT EXISTS call_logs_contact_idx    ON call_logs(contact_id) WHERE contact_id IS NOT NULL;

-- ─── Triggers ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'front_desk_settings_updated_at') THEN
    drop trigger if exists front_desk_settings_updated_at on front_desk_settings;
CREATE TRIGGER front_desk_settings_updated_at BEFORE UPDATE ON front_desk_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'call_logs_updated_at') THEN
    drop trigger if exists call_logs_updated_at on call_logs;
CREATE TRIGGER call_logs_updated_at BEFORE UPDATE ON call_logs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

-- ─── RLS ───────────────────────────────────────────────────────────────────
ALTER TABLE front_desk_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_logs           ENABLE ROW LEVEL SECURITY;

-- Settings: any active member can read; only owner/admin can write.
drop policy if exists "front_desk_select" on front_desk_settings;
CREATE POLICY "front_desk_select" ON front_desk_settings FOR SELECT USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = front_desk_settings.family_id AND user_id = auth.uid() AND is_active)
);
drop policy if exists "front_desk_insert" on front_desk_settings;
CREATE POLICY "front_desk_insert" ON front_desk_settings FOR INSERT WITH CHECK (
  public.can_manage_family(front_desk_settings.family_id)
);
drop policy if exists "front_desk_update" on front_desk_settings;
CREATE POLICY "front_desk_update" ON front_desk_settings FOR UPDATE USING (
  public.can_manage_family(front_desk_settings.family_id)
);

-- Call logs: any active member can read/write their family's calls.
drop policy if exists "call_logs_select" on call_logs;
CREATE POLICY "call_logs_select" ON call_logs FOR SELECT USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = call_logs.family_id AND user_id = auth.uid() AND is_active)
);
drop policy if exists "call_logs_insert" on call_logs;
CREATE POLICY "call_logs_insert" ON call_logs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = call_logs.family_id AND user_id = auth.uid() AND is_active)
);
drop policy if exists "call_logs_update" on call_logs;
CREATE POLICY "call_logs_update" ON call_logs FOR UPDATE USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = call_logs.family_id AND user_id = auth.uid() AND is_active)
);
drop policy if exists "call_logs_delete" on call_logs;
CREATE POLICY "call_logs_delete" ON call_logs FOR DELETE USING (
  public.can_manage_family(call_logs.family_id)
);

-- ─── Realtime ──────────────────────────────────────────────────────────────
do $pubguard$ begin alter publication supabase_realtime add table front_desk_settings; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table call_logs; exception when others then null; end $pubguard$;



-- ══════════ 0093_trust_engine.sql ══════════
-- ════════════════════════════════════════════════════════════════════════════
-- Family Trust & Permissions Engine — a core platform layer.
-- Governs every AI action, member capability, delegation, and approval workflow.
--
-- Tables:
--   trust_policies      — the Household Policy Engine (declarative allow/deny/approve rules)
--   permission_grants   — fine-grained per-member domain/capability overrides
--   trust_delegations   — temporary, auto-expiring authority transfers
--   approval_requests   — the approval inbox + workflow state
--   trust_scores        — dynamic, continuously-updated trust per actor
--   emergency_sessions  — Emergency Operations Mode (time-boxed elevation)
--   trust_audit_logs    — explainability + complete decision audit trail
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Household Policy Engine ────────────────────────────────────────────────
-- A declarative rule: "for {domain}/{capability}, when {conditions}, {effect}".
-- The engine evaluates the highest-priority matching policy for every action.
CREATE TABLE IF NOT EXISTS public.trust_policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name          text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  description   text CHECK (char_length(description) <= 1000),
  domain        text NOT NULL DEFAULT 'all',          -- e.g. medical, finances, calendar, 'all'
  capability    text NOT NULL DEFAULT 'automate'      -- view|create|edit|delete|approve|delegate|automate|share|archive|export|all
                  CHECK (capability IN ('view','create','edit','delete','approve','delegate','automate','share','archive','export','all')),
  -- Who this policy applies to: a role, a specific member, or everyone.
  subject_kind  text NOT NULL DEFAULT 'role'
                  CHECK (subject_kind IN ('role','member','ai','everyone')),
  subject_role  text,                                 -- when subject_kind='role'
  subject_member_id uuid REFERENCES public.family_members(id) ON DELETE CASCADE,
  effect        text NOT NULL DEFAULT 'require_approval'
                  CHECK (effect IN ('allow','deny','require_approval','auto_approve')),
  -- Structured conditions, e.g. {"maxAmountCents":5000,"minConfidence":0.95,"timeStart":"16:00","timeEnd":"22:00"}.
  conditions    jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- For require_approval: how many approvers + which model.
  approval_model text NOT NULL DEFAULT 'single'
                  CHECK (approval_model IN ('single','two_parent','first_available','consensus','sequential')),
  required_approvals smallint NOT NULL DEFAULT 1 CHECK (required_approvals BETWEEN 1 AND 5),
  priority      smallint NOT NULL DEFAULT 100,        -- higher wins on conflict
  enabled       boolean NOT NULL DEFAULT true,
  is_system     boolean NOT NULL DEFAULT false,       -- seeded default policies
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trust_policies_family ON public.trust_policies(family_id, enabled);
CREATE INDEX IF NOT EXISTS idx_trust_policies_domain ON public.trust_policies(family_id, domain, capability);

-- ─── Fine-grained permission grants ─────────────────────────────────────────
-- Per-member override of the role-default capability matrix.
CREATE TABLE IF NOT EXISTS public.permission_grants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  domain        text NOT NULL,
  capability    text NOT NULL
                  CHECK (capability IN ('view','create','edit','delete','approve','delegate','automate','share','archive','export')),
  effect        text NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, member_id, domain, capability)
);
CREATE INDEX IF NOT EXISTS idx_permission_grants_member ON public.permission_grants(family_id, member_id);

-- ─── Temporary delegation ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trust_delegations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  from_member_id uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  to_member_id  uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  domains       text[] NOT NULL DEFAULT '{}',         -- empty = all delegable domains
  reason        text CHECK (char_length(reason) <= 500),
  starts_at     timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,                 -- delegation MUST expire
  revoked_at    timestamptz,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > starts_at),
  CHECK (from_member_id <> to_member_id)
);
CREATE INDEX IF NOT EXISTS idx_trust_delegations_active ON public.trust_delegations(family_id, to_member_id, expires_at) WHERE revoked_at IS NULL;

-- ─── Approval requests (inbox + workflow) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.approval_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  domain        text NOT NULL,
  capability    text NOT NULL DEFAULT 'automate',
  -- Who/what is requesting: an AI agent or a member.
  requested_by_kind text NOT NULL DEFAULT 'ai' CHECK (requested_by_kind IN ('ai','member')),
  requested_by_member_id uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  agent         text,                                  -- the AI agent name, when requested_by_kind='ai'
  title         text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  summary       text CHECK (char_length(summary) <= 2000),
  -- The proposed action payload (so it can be executed on approval).
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  amount_cents  bigint,                                -- when the action has a cost
  confidence    numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  policy_id     uuid REFERENCES public.trust_policies(id) ON DELETE SET NULL,
  reasoning     text,                                  -- why approval was required (explainability)
  approval_model text NOT NULL DEFAULT 'single'
                  CHECK (approval_model IN ('single','two_parent','first_available','consensus','sequential')),
  required_approvals smallint NOT NULL DEFAULT 1,
  approvals     jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [{member_id, decision, note, at}]
  status        text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','modified','expired','cancelled')),
  priority      text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  decided_by    uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  expires_at    timestamptz,
  executed_at   timestamptz,
  execution_result text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON public.approval_requests(family_id, status, created_at DESC);

-- ─── Dynamic trust scores ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.trust_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('member','ai_agent','contact','organization','automation','integration')),
  actor_id      text NOT NULL,                         -- member uuid, agent name, contact id, etc.
  score         numeric(5,2) NOT NULL DEFAULT 50 CHECK (score >= 0 AND score <= 100),
  factors       jsonb NOT NULL DEFAULT '{}'::jsonb,    -- {history, reliability, verified, ...}
  verified      boolean NOT NULL DEFAULT false,
  interactions  integer NOT NULL DEFAULT 0,
  successes     integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, actor_kind, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_trust_scores_family ON public.trust_scores(family_id, actor_kind);

-- ─── Emergency Operations Mode ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.emergency_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT 'general'
                  CHECK (kind IN ('medical','missing_person','severe_weather','natural_disaster','vehicle_accident','general')),
  reason        text CHECK (char_length(reason) <= 1000),
  activated_by  uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  activated_at  timestamptz NOT NULL DEFAULT now(),
  ended_by      uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  ended_at      timestamptz,
  -- Which domains get elevated to 'allow' while active.
  elevated_domains text[] NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_emergency_sessions_active ON public.emergency_sessions(family_id, ended_at) WHERE ended_at IS NULL;

-- ─── Trust audit log (explainability + complete trail) ──────────────────────
CREATE TABLE IF NOT EXISTS public.trust_audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  actor_kind    text NOT NULL DEFAULT 'ai_agent',
  actor_id      text,                                  -- member uuid or agent name
  domain        text,
  capability    text,
  decision      text NOT NULL CHECK (decision IN ('allow','deny','require_approval','auto_approve','executed','approved','rejected','emergency_override')),
  reason        text,                                  -- human-readable explanation
  policy_id     uuid REFERENCES public.trust_policies(id) ON DELETE SET NULL,
  confidence    numeric(4,3),
  approval_id   uuid REFERENCES public.approval_requests(id) ON DELETE SET NULL,
  context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  device        text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trust_audit_family ON public.trust_audit_logs(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_audit_domain ON public.trust_audit_logs(family_id, domain);

-- ─── updated_at triggers ────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trust_policies','permission_grants','trust_delegations','approval_requests','trust_scores','emergency_sessions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_updated_at') THEN
      EXECUTE format('CREATE TRIGGER %I_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()', t, t);
    END IF;
  END LOOP;
END $$;

-- ─── RLS ────────────────────────────────────────────────────────────────────
ALTER TABLE public.trust_policies     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_grants  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trust_delegations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_requests  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trust_scores       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.emergency_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trust_audit_logs   ENABLE ROW LEVEL SECURITY;

-- Helper predicates inline. Members of the family can read; managers (parent/adult) write.
-- trust_policies
drop policy if exists "trust_policies_read" on public.trust_policies;
CREATE POLICY "trust_policies_read" ON public.trust_policies FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_policies.family_id AND fm.user_id = auth.uid() AND fm.is_active));
drop policy if exists "trust_policies_write" on public.trust_policies;
CREATE POLICY "trust_policies_write" ON public.trust_policies FOR ALL USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_policies.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_policies.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active));

-- permission_grants
drop policy if exists "permission_grants_read" on public.permission_grants;
CREATE POLICY "permission_grants_read" ON public.permission_grants FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = permission_grants.family_id AND fm.user_id = auth.uid() AND fm.is_active));
drop policy if exists "permission_grants_write" on public.permission_grants;
CREATE POLICY "permission_grants_write" ON public.permission_grants FOR ALL USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = permission_grants.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = permission_grants.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active));

-- trust_delegations
drop policy if exists "trust_delegations_read" on public.trust_delegations;
CREATE POLICY "trust_delegations_read" ON public.trust_delegations FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_delegations.family_id AND fm.user_id = auth.uid() AND fm.is_active));
drop policy if exists "trust_delegations_write" on public.trust_delegations;
CREATE POLICY "trust_delegations_write" ON public.trust_delegations FOR ALL USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_delegations.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_delegations.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active));

-- approval_requests: members read; managers decide; anyone in family can be a requester (insert).
drop policy if exists "approval_requests_read" on public.approval_requests;
CREATE POLICY "approval_requests_read" ON public.approval_requests FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = approval_requests.family_id AND fm.user_id = auth.uid() AND fm.is_active));
drop policy if exists "approval_requests_insert" on public.approval_requests;
CREATE POLICY "approval_requests_insert" ON public.approval_requests FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = approval_requests.family_id AND fm.user_id = auth.uid() AND fm.is_active));
drop policy if exists "approval_requests_update" on public.approval_requests;
CREATE POLICY "approval_requests_update" ON public.approval_requests FOR UPDATE USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = approval_requests.family_id AND fm.user_id = auth.uid() AND fm.is_active));

-- trust_scores: read by members, write by managers.
drop policy if exists "trust_scores_read" on public.trust_scores;
CREATE POLICY "trust_scores_read" ON public.trust_scores FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_scores.family_id AND fm.user_id = auth.uid() AND fm.is_active));
drop policy if exists "trust_scores_write" on public.trust_scores;
CREATE POLICY "trust_scores_write" ON public.trust_scores FOR ALL USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_scores.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_scores.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active));

-- emergency_sessions: members read; managers activate/end.
drop policy if exists "emergency_sessions_read" on public.emergency_sessions;
CREATE POLICY "emergency_sessions_read" ON public.emergency_sessions FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = emergency_sessions.family_id AND fm.user_id = auth.uid() AND fm.is_active));
drop policy if exists "emergency_sessions_write" on public.emergency_sessions;
CREATE POLICY "emergency_sessions_write" ON public.emergency_sessions FOR ALL USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = emergency_sessions.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = emergency_sessions.family_id AND fm.user_id = auth.uid() AND fm.role IN ('parent','adult') AND fm.is_active));

-- trust_audit_logs: read by members, insert by family members (append-only — no update/delete policy).
drop policy if exists "trust_audit_read" on public.trust_audit_logs;
CREATE POLICY "trust_audit_read" ON public.trust_audit_logs FOR SELECT USING (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_audit_logs.family_id AND fm.user_id = auth.uid() AND fm.is_active));
drop policy if exists "trust_audit_insert" on public.trust_audit_logs;
CREATE POLICY "trust_audit_insert" ON public.trust_audit_logs FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM public.family_members fm WHERE fm.family_id = trust_audit_logs.family_id AND fm.user_id = auth.uid() AND fm.is_active));

-- ─── Realtime ───────────────────────────────────────────────────────────────
do $pubguard$ begin alter publication supabase_realtime add table public.trust_policies; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table public.permission_grants; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table public.trust_delegations; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table public.approval_requests; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table public.trust_scores; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table public.emergency_sessions; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table public.trust_audit_logs; exception when others then null; end $pubguard$;



-- ══════════ 0094_family_dashboard_settings.sql ══════════
-- ============================================================================
-- Migration 0093: Family dashboard settings (child-customization permissions)
-- ----------------------------------------------------------------------------
-- Per-family controls for the customizable dashboard: whether children may
-- personalize their own layout, and whether everyone is locked to the family
-- default. One row per family. Writes are parent/admin-only (enforced in the
-- server action); RLS provides family isolation.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.family_dashboard_settings (
  family_id                  uuid PRIMARY KEY REFERENCES public.families(id) ON DELETE CASCADE,
  allow_child_customization  boolean NOT NULL DEFAULT true,
  lock_to_family_default     boolean NOT NULL DEFAULT false,
  updated_by                 uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.family_dashboard_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage family_dashboard_settings" ON public.family_dashboard_settings;
drop policy if exists "Members manage family_dashboard_settings" on public.family_dashboard_settings;
CREATE POLICY "Members manage family_dashboard_settings" ON public.family_dashboard_settings
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));
DROP TRIGGER IF EXISTS trg_family_dashboard_settings_updated_at ON public.family_dashboard_settings;
drop trigger if exists trg_family_dashboard_settings_updated_at on public.family_dashboard_settings;
CREATE TRIGGER trg_family_dashboard_settings_updated_at BEFORE UPDATE ON public.family_dashboard_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Done!
-- ============================================================================



-- ══════════ 0095_pay_handles.sql ══════════
-- ============================================================================
-- Migration 0095: Pay-ID handles — memorable gifting links (e.g. bubaly.com/pay/mia)
-- ----------------------------------------------------------------------------
-- A Pay-ID is a short, human-friendly handle a family claims for a child (or the
-- whole family). Visiting /pay/<handle> resolves to that child's active gift link
-- so relatives don't have to copy a long random token. Handles are stored already
-- normalized (lowercase, [a-z0-9_]) and are globally UNIQUE.
--
-- No money lives here — this is just a friendly alias that redirects to the
-- existing gift_links flow. Family-scoped RLS for management; the public resolver
-- route reads via the service role.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.pay_handles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid REFERENCES public.child_wallets(id) ON DELETE CASCADE,  -- null = family-level handle
  handle          text NOT NULL,                                              -- normalized: lowercase [a-z0-9_], 3-20
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pay_handles_format CHECK (handle ~ '^[a-z0-9_]{3,20}$')
);

-- Globally unique handle (the whole point of a Pay-ID).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_handles_handle ON public.pay_handles (handle);
CREATE INDEX IF NOT EXISTS idx_pay_handles_family ON public.pay_handles (family_id, is_active);

ALTER TABLE public.pay_handles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members manage pay_handles" ON public.pay_handles;
drop policy if exists "Members manage pay_handles" on public.pay_handles;
CREATE POLICY "Members manage pay_handles" ON public.pay_handles
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

DROP TRIGGER IF EXISTS trg_pay_handles_updated_at ON public.pay_handles;
drop trigger if exists trg_pay_handles_updated_at on public.pay_handles;
CREATE TRIGGER trg_pay_handles_updated_at BEFORE UPDATE ON public.pay_handles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- Done. Pay-ID handles. The public /pay/<handle> route resolves via the service
-- role and redirects to the child's newest active gift link.
-- ============================================================================



-- ══════════ 0095_wallet_transfers.sql ══════════
-- ============================================================================
-- Migration 0095: Wallet peer-to-peer transfers + spend requests
-- ----------------------------------------------------------------------------
-- Adds the `transfer` ledger type so money can move between family wallets
-- (parent → child, child → child) as a distinct, reportable event — separate
-- from within-wallet `bucket_transfer`. Spend requests reuse the existing
-- `card_spend` type with the `requires_parent_approval` status and a
-- `parent_approvals` row, so no new table is needed.
--
-- ALTER TYPE ... ADD VALUE is safe here: this migration only adds the value and
-- never uses it in the same transaction.
-- ============================================================================
ALTER TYPE wallet_txn_type ADD VALUE IF NOT EXISTS 'transfer';

-- Speed up the parent-approval inbox lookup by ref (spend requests link a
-- parent_approvals row to its pending wallet_transactions row).
CREATE INDEX IF NOT EXISTS idx_parent_approvals_ref
  ON public.parent_approvals (family_id, ref_type, ref_id);



-- ══════════ 0096_family_economy.sql ══════════
-- ============================================================================
-- Migration 0096: Family Economy — custom currencies (non-cash points/tokens)
-- ----------------------------------------------------------------------------
-- A parallel, NON-CASH economy: parents define their own currencies (e.g.
-- "Stars ⭐", "Screen-time minutes ⏰") that kids EARN (chores, manual awards)
-- and SPEND on family-defined rewards ("movie night pick", "30 min screen time").
-- Completely separate from the cash Family Wallet (0088) — no real money here.
--
-- Money model mirrors the wallet: an IMMUTABLE LEDGER. A member's balance in a
-- currency = sum of `currency_transactions` (credits − debits). Corrections are
-- new rows, never edits. All amounts are whole integers (tokens), >= 0.
-- Every table is family-scoped with is_family_member RLS.
-- ============================================================================

DO $$ BEGIN CREATE TYPE economy_direction AS ENUM ('credit','debit'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- redemption_status already exists from 0028 with ('requested','approved',
-- 'fulfilled','rejected'); the swallowed CREATE TYPE here silently left it
-- without the economy values, so DEFAULT 'pending' below could never apply.
-- Extend the existing enum idempotently instead (additive, non-breaking).
DO $$ BEGIN CREATE TYPE redemption_status AS ENUM ('pending','approved','fulfilled','rejected','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TYPE redemption_status ADD VALUE IF NOT EXISTS 'pending';
ALTER TYPE redemption_status ADD VALUE IF NOT EXISTS 'cancelled';

-- ---------- the custom currencies ----------
CREATE TABLE IF NOT EXISTS public.family_currencies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name        text NOT NULL,                 -- "Stars", "Screen-time minutes"
  emoji       text NOT NULL DEFAULT '⭐',     -- a single emoji shown as the token icon
  unit_label  text,                          -- optional singular unit, e.g. "minute"
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_family_currencies_family ON public.family_currencies (family_id, is_active, sort_order);

-- ---------- the immutable token ledger ----------
CREATE TABLE IF NOT EXISTS public.currency_transactions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  currency_id   uuid NOT NULL REFERENCES public.family_currencies(id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  direction     economy_direction NOT NULL,
  amount        bigint NOT NULL CHECK (amount > 0),   -- whole tokens, always positive; direction signs it
  reason        text,
  related_type  text,                                 -- chore_assignment | redemption | manual | reversal
  related_id    uuid,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_currency_txn_member ON public.currency_transactions (family_id, member_id, currency_id, created_at DESC);

-- ---------- the reward catalog (what tokens buy) ----------
CREATE TABLE IF NOT EXISTS public.economy_rewards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  currency_id uuid NOT NULL REFERENCES public.family_currencies(id) ON DELETE CASCADE,
  title       text NOT NULL,
  emoji       text NOT NULL DEFAULT '🎁',
  cost        bigint NOT NULL CHECK (cost > 0),
  stock       integer,                                -- null = unlimited
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_economy_rewards_family ON public.economy_rewards (family_id, is_active, sort_order);

-- ---------- redemptions (a child spends tokens on a reward) ----------
CREATE TABLE IF NOT EXISTS public.economy_redemptions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  reward_id    uuid REFERENCES public.economy_rewards(id) ON DELETE SET NULL,
  currency_id  uuid NOT NULL REFERENCES public.family_currencies(id) ON DELETE CASCADE,
  member_id    uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  title        text NOT NULL,                         -- snapshot of the reward title
  cost         bigint NOT NULL CHECK (cost > 0),      -- snapshot of the cost
  status       redemption_status NOT NULL DEFAULT 'pending',
  txn_id       uuid REFERENCES public.currency_transactions(id) ON DELETE SET NULL, -- the debit, on approval
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at   timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_economy_redemptions_family ON public.economy_redemptions (family_id, status, created_at DESC);

-- ============================================================================
-- Family-scoped RLS + updated_at triggers.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY[
  'family_currencies','currency_transactions','economy_rewards','economy_redemptions'
];
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
-- Done. Family Economy (custom non-cash currencies). Earn via credits, spend via
-- redemptions that debit on parent approval. Balances derived from the ledger.
-- ============================================================================



-- ══════════ 0097_kid_investing.sql ══════════
-- ============================================================================
-- Migration 0097: AI Investing for kids — EDUCATIONAL, SIMULATED investing
-- ----------------------------------------------------------------------------
-- A teaching tool, NOT a brokerage. Kids "invest" the cash in their wallet's
-- INVEST bucket (0088) into simulated educational assets to learn how markets,
-- diversification and compound growth work. There is NO real trading, NO real
-- securities, NO guaranteed returns. Prices are simulated/educational.
--
-- Money discipline: a "buy" moves cash OUT of the child's invest bucket (a
-- wallet_transactions debit) and records shares in invest_holdings; a "sell"
-- moves cash back IN. The wallet ledger stays the source of truth for cash.
-- Orders require parent approval. Family-scoped RLS; the asset catalog is global.
-- ============================================================================

DO $$ BEGIN CREATE TYPE invest_order_side AS ENUM ('buy','sell'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE invest_order_status AS ENUM ('pending','filled','rejected','cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- educational asset catalog (global, simulated prices) ----------
CREATE TABLE IF NOT EXISTS public.invest_assets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol       text NOT NULL,                 -- short code, e.g. "MARKET", "TECH"
  name         text NOT NULL,                 -- "US Stock Market (Index)"
  kind         text NOT NULL DEFAULT 'fund',  -- fund | stocks | bonds | basket
  emoji        text NOT NULL DEFAULT '📈',
  description  text,
  price_cents  bigint NOT NULL CHECK (price_cents > 0),  -- simulated current price / share
  risk_level   text NOT NULL DEFAULT 'medium',           -- low | medium | high (educational)
  is_active    boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (symbol)
);
ALTER TABLE public.invest_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Authenticated read invest_assets" ON public.invest_assets;
drop policy if exists "Authenticated read invest_assets" on public.invest_assets;
CREATE POLICY "Authenticated read invest_assets" ON public.invest_assets FOR SELECT TO authenticated USING (is_active = true);
DROP TRIGGER IF EXISTS trg_invest_assets_updated_at ON public.invest_assets;
drop trigger if exists trg_invest_assets_updated_at on public.invest_assets;
CREATE TRIGGER trg_invest_assets_updated_at BEFORE UPDATE ON public.invest_assets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- A small starter set of EDUCATIONAL, non-real assets (generic baskets, not
-- tradeable securities) so the experience works out of the box.
INSERT INTO public.invest_assets (symbol, name, kind, emoji, description, price_cents, risk_level, sort_order) VALUES
  ('MARKET', 'US Stock Market (Index)', 'fund',   '🏦', 'A simulated basket of the whole stock market — the classic “buy a little of everything” idea.', 5000, 'medium', 1),
  ('TECH',   'Technology Companies',    'basket', '💻', 'A simulated basket of tech companies. Higher ups and downs.', 8000, 'high', 2),
  ('GREEN',  'Clean Energy',            'basket', '🌱', 'A simulated basket of clean-energy companies.', 3000, 'high', 3),
  ('BONDS',  'Government Bonds',        'bonds',  '🛡️', 'A simulated safe, steady saver. Lower risk, lower growth.', 2000, 'low', 4),
  ('GOLD',   'Gold',                    'basket', '🪙', 'A simulated store of value that moves differently from stocks.', 6000, 'medium', 5)
ON CONFLICT (symbol) DO NOTHING;

-- ---------- a child's simulated holdings ----------
CREATE TABLE IF NOT EXISTS public.invest_holdings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid NOT NULL REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  asset_id        uuid NOT NULL REFERENCES public.invest_assets(id) ON DELETE CASCADE,
  shares          numeric(16,4) NOT NULL DEFAULT 0 CHECK (shares >= 0),
  avg_cost_cents  bigint NOT NULL DEFAULT 0 CHECK (avg_cost_cents >= 0),  -- avg paid per share
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (child_wallet_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_invest_holdings_family ON public.invest_holdings (family_id, child_wallet_id);

-- ---------- orders (buy/sell), parent-approved ----------
CREATE TABLE IF NOT EXISTS public.invest_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  child_wallet_id uuid NOT NULL REFERENCES public.child_wallets(id) ON DELETE CASCADE,
  asset_id        uuid NOT NULL REFERENCES public.invest_assets(id) ON DELETE CASCADE,
  side            invest_order_side NOT NULL,
  shares          numeric(16,4) NOT NULL CHECK (shares > 0),
  price_cents     bigint NOT NULL CHECK (price_cents > 0),   -- snapshot at order time
  amount_cents    bigint NOT NULL CHECK (amount_cents > 0),  -- shares * price (rounded)
  status          invest_order_status NOT NULL DEFAULT 'pending',
  txn_id          uuid REFERENCES public.wallet_transactions(id) ON DELETE SET NULL,
  requested_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_invest_orders_family ON public.invest_orders (family_id, status, created_at DESC);

-- ============================================================================
-- Family-scoped RLS + updated_at triggers for holdings + orders.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['invest_holdings','invest_orders'];
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
-- Done. Educational, simulated kid investing. Buys/sells move cash through the
-- wallet's INVEST bucket; holdings track shares. Parent-approved. No real money
-- leaves the wallet — this is a learning tool only.
-- ============================================================================



-- ══════════ 0098_relationship_helper.sql ══════════
-- Relationship Helper — track anniversaries, birthdays, and date nights;
-- store partner preferences for AI gift suggestions; and a saved gift-idea list
-- (manual, AI-suggested, or pulled from a partner's wishlist).

-- One preferences row per family (the couple's shared space).
CREATE TABLE IF NOT EXISTS relationship_profile (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         UUID        NOT NULL UNIQUE REFERENCES families(id) ON DELETE CASCADE,
  created_by        UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  partner_name      TEXT,
  partner_member_id UUID        REFERENCES family_members(id) ON DELETE SET NULL,
  interests         TEXT[]      NOT NULL DEFAULT '{}',
  love_languages    TEXT[]      NOT NULL DEFAULT '{}',
  gift_budget_cents INTEGER     CHECK (gift_budget_cents IS NULL OR gift_budget_cents >= 0),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Important dates + planned date nights.
CREATE TABLE IF NOT EXISTS relationship_dates (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id            UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by           UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  kind                 TEXT        NOT NULL DEFAULT 'custom'
                         CHECK (kind IN ('anniversary','birthday','first_date','date_night','milestone','custom')),
  title                TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  event_date           DATE        NOT NULL,
  recurs_annually      BOOLEAN     NOT NULL DEFAULT true,
  reminder_days_before INTEGER     NOT NULL DEFAULT 14 CHECK (reminder_days_before BETWEEN 0 AND 365),
  member_id            UUID        REFERENCES family_members(id) ON DELETE SET NULL,
  partner_name         TEXT,
  location             TEXT,
  notes                TEXT,
  calendar_event_id    UUID        REFERENCES calendar_events(id) ON DELETE SET NULL,
  status               TEXT        NOT NULL DEFAULT 'upcoming'
                         CHECK (status IN ('idea','planned','booked','upcoming','completed','cancelled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Saved gift ideas.
CREATE TABLE IF NOT EXISTS relationship_gift_ideas (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id        UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  for_member_id    UUID        REFERENCES family_members(id) ON DELETE SET NULL,
  for_name         TEXT,
  title            TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  url              TEXT,
  price_cents      INTEGER     CHECK (price_cents IS NULL OR price_cents >= 0),
  occasion         TEXT,
  reason           TEXT,
  source           TEXT        NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual','ai','wishlist')),
  wishlist_item_id UUID        REFERENCES wishlist_items(id) ON DELETE SET NULL,
  status           TEXT        NOT NULL DEFAULT 'idea'
                     CHECK (status IN ('idea','saved','ordered','purchased','given')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS relationship_dates_family_idx     ON relationship_dates(family_id, event_date);
CREATE INDEX IF NOT EXISTS relationship_dates_status_idx     ON relationship_dates(family_id, status);
CREATE INDEX IF NOT EXISTS relationship_gift_ideas_family_idx ON relationship_gift_ideas(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS relationship_gift_ideas_status_idx ON relationship_gift_ideas(family_id, status);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'relationship_profile_updated_at') THEN
    drop trigger if exists relationship_profile_updated_at on relationship_profile;
CREATE TRIGGER relationship_profile_updated_at BEFORE UPDATE ON relationship_profile FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'relationship_dates_updated_at') THEN
    drop trigger if exists relationship_dates_updated_at on relationship_dates;
CREATE TRIGGER relationship_dates_updated_at BEFORE UPDATE ON relationship_dates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'relationship_gift_ideas_updated_at') THEN
    drop trigger if exists relationship_gift_ideas_updated_at on relationship_gift_ideas;
CREATE TRIGGER relationship_gift_ideas_updated_at BEFORE UPDATE ON relationship_gift_ideas FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE relationship_profile    ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_dates      ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationship_gift_ideas ENABLE ROW LEVEL SECURITY;

drop policy if exists "relationship_profile_family" on relationship_profile;
CREATE POLICY "relationship_profile_family" ON relationship_profile FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_profile.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_profile.family_id AND user_id = auth.uid() AND is_active)
);

drop policy if exists "relationship_dates_family" on relationship_dates;
CREATE POLICY "relationship_dates_family" ON relationship_dates FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_dates.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_dates.family_id AND user_id = auth.uid() AND is_active)
);

drop policy if exists "relationship_gift_ideas_family" on relationship_gift_ideas;
CREATE POLICY "relationship_gift_ideas_family" ON relationship_gift_ideas FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_gift_ideas.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = relationship_gift_ideas.family_id AND user_id = auth.uid() AND is_active)
);

do $pubguard$ begin alter publication supabase_realtime add table relationship_profile; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table relationship_dates; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table relationship_gift_ideas; exception when others then null; end $pubguard$;



-- ══════════ 0098_trip_intelligence.sql ══════════
-- Trip Intelligence — AI destination research + Smart Departure planning.
--
-- trip_plans:      a researched destination (restaurants/activities/tips) tied
--                  to an optional calendar event or vacation, scoped to a date
--                  range and the members going. AI recommendations cached as JSON.
-- departure_plans: a "when do we leave?" plan for one located calendar event.
--                  Stores the inputs (prep/park buffers, origin/destination) and
--                  the computed leave_by, plus the latest live snapshot (drive
--                  time, traffic factor, weather) and the linked "Head out"
--                  calendar event so we can keep it in sync.

CREATE TABLE IF NOT EXISTS trip_plans (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id       UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  event_id        UUID        REFERENCES calendar_events(id) ON DELETE SET NULL,
  title           TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  destination     TEXT        NOT NULL CHECK (char_length(destination) BETWEEN 1 AND 200),
  dest_lat        DOUBLE PRECISION,
  dest_lng        DOUBLE PRECISION,
  start_date      DATE,
  end_date        DATE,
  members         JSONB       NOT NULL DEFAULT '[]'::jsonb,   -- member display names going
  interests       TEXT,                                       -- free-text "what we like"
  recommendations JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- { restaurants:[], activities:[], tips:[] }
  weather_summary TEXT,
  status          TEXT        NOT NULL DEFAULT 'researched'
                    CHECK (status IN ('researched','planning','booked','completed','archived')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS departure_plans (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id            UUID        NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  created_by           UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  event_id             UUID        REFERENCES calendar_events(id) ON DELETE CASCADE,
  reminder_event_id    UUID        REFERENCES calendar_events(id) ON DELETE SET NULL,
  title                TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  origin               TEXT,
  origin_lat           DOUBLE PRECISION,
  origin_lng           DOUBLE PRECISION,
  destination          TEXT,
  dest_lat             DOUBLE PRECISION,
  dest_lng             DOUBLE PRECISION,
  event_start          TIMESTAMPTZ NOT NULL,
  prep_minutes         INTEGER     NOT NULL DEFAULT 30 CHECK (prep_minutes BETWEEN 0 AND 240),
  park_minutes         INTEGER     NOT NULL DEFAULT 10 CHECK (park_minutes BETWEEN 0 AND 120),
  buffer_minutes       INTEGER     NOT NULL DEFAULT 5  CHECK (buffer_minutes BETWEEN 0 AND 120),
  drive_seconds        INTEGER     NOT NULL DEFAULT 0  CHECK (drive_seconds >= 0),
  traffic_factor       DOUBLE PRECISION NOT NULL DEFAULT 1,
  weather_delay_minutes INTEGER    NOT NULL DEFAULT 0  CHECK (weather_delay_minutes >= 0),
  weather_summary      TEXT,
  leave_by             TIMESTAMPTZ,
  last_checked_at      TIMESTAMPTZ,
  status               TEXT        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','done','cancelled')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_plans_family_idx      ON trip_plans(family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trip_plans_event_idx       ON trip_plans(event_id);
CREATE INDEX IF NOT EXISTS departure_plans_family_idx ON departure_plans(family_id, event_start);
CREATE INDEX IF NOT EXISTS departure_plans_event_idx  ON departure_plans(event_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trip_plans_updated_at') THEN
    drop trigger if exists trip_plans_updated_at on trip_plans;
CREATE TRIGGER trip_plans_updated_at BEFORE UPDATE ON trip_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'departure_plans_updated_at') THEN
    drop trigger if exists departure_plans_updated_at on departure_plans;
CREATE TRIGGER departure_plans_updated_at BEFORE UPDATE ON departure_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE trip_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE departure_plans ENABLE ROW LEVEL SECURITY;

drop policy if exists "trip_plans_family" on trip_plans;
CREATE POLICY "trip_plans_family" ON trip_plans FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = trip_plans.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = trip_plans.family_id AND user_id = auth.uid() AND is_active)
);

drop policy if exists "departure_plans_family" on departure_plans;
CREATE POLICY "departure_plans_family" ON departure_plans FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = departure_plans.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = departure_plans.family_id AND user_id = auth.uid() AND is_active)
);

do $pubguard$ begin alter publication supabase_realtime add table trip_plans; exception when others then null; end $pubguard$;
do $pubguard$ begin alter publication supabase_realtime add table departure_plans; exception when others then null; end $pubguard$;



-- ══════════ 0099_stripe_settings.sql ══════════
-- Stripe Setup — a single, super-admin-configurable home for the Bubaly Stripe
-- account and the per-transaction service fee paid to Bubaly. One row
-- ('singleton'). Locked down: RLS on with NO policies, so only the service role
-- (the super-admin server actions) can read/write it — secrets never reach the
-- browser via PostgREST.

CREATE TABLE IF NOT EXISTS stripe_settings (
  id                   TEXT        PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  enabled              BOOLEAN     NOT NULL DEFAULT false,
  publishable_key      TEXT,
  secret_key           TEXT,
  webhook_secret       TEXT,
  connect_account_id   TEXT,
  -- The Bubaly service fee added to transactions (cents). Default $0.90.
  service_fee_cents    INTEGER     NOT NULL DEFAULT 90 CHECK (service_fee_cents >= 0),
  -- A one-time Stripe Price (in the Bubaly account) for the service fee, added
  -- to subscription checkouts via add_invoice_items so the fee lands on Bubaly.
  service_fee_price_id TEXT,
  updated_by           UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'stripe_settings_updated_at') THEN
    drop trigger if exists stripe_settings_updated_at on stripe_settings;
CREATE TRIGGER stripe_settings_updated_at BEFORE UPDATE ON stripe_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE stripe_settings ENABLE ROW LEVEL SECURITY;
-- (No policies on purpose: service-role only.)

INSERT INTO stripe_settings (id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;



-- ══════════ 0100_reminder_details.sql ══════════
-- Reminder details — bring family reminders to parity with best-in-class apps:
-- named lists, a URL, an early (lead-time) reminder, a flag, subtasks, and an
-- image attachment.

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

CREATE INDEX IF NOT EXISTS reminder_lists_family_idx ON reminder_lists(family_id, sort_order);
CREATE INDEX IF NOT EXISTS family_reminders_list_idx ON family_reminders(list_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'reminder_lists_updated_at') THEN
    drop trigger if exists reminder_lists_updated_at on reminder_lists;
CREATE TRIGGER reminder_lists_updated_at BEFORE UPDATE ON reminder_lists FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

ALTER TABLE reminder_lists ENABLE ROW LEVEL SECURITY;
drop policy if exists "reminder_lists_family" on reminder_lists;
CREATE POLICY "reminder_lists_family" ON reminder_lists FOR ALL USING (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = reminder_lists.family_id AND user_id = auth.uid() AND is_active)
) WITH CHECK (
  EXISTS (SELECT 1 FROM family_members WHERE family_id = reminder_lists.family_id AND user_id = auth.uid() AND is_active)
);

do $pubguard$ begin alter publication supabase_realtime add table reminder_lists; exception when others then null; end $pubguard$;



-- ══════════ 0101_social_feed.sql ══════════
-- ============================================================================
-- Migration 0101: Social Feed — "All your social feeds. One place."
-- ----------------------------------------------------------------------------
-- A calm, ad-free CONSUMPTION feed (distinct from the existing Social Command
-- publishing suite at /dashboard/social). Families connect SOURCES (Instagram,
-- YouTube, TikTok, X, etc.) and their posts land as ITEMS in one organized feed
-- the family can favorite, mark read, and filter.
--
-- Live ingestion from each platform needs per-platform OAuth/API keys (handled in
-- a later integration phase, like Stripe). This schema + UI store and render the
-- items; an ingestion worker / manual add populates them. Family-scoped RLS.
-- ============================================================================

DO $$ BEGIN CREATE TYPE social_item_kind AS ENUM ('post','video','photo','link'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE social_category AS ENUM ('family','friends','groups','other'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------- connected sources ("Your Sources") ----------
CREATE TABLE IF NOT EXISTS public.social_reader_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  platform      text NOT NULL,                       -- instagram | facebook | youtube | tiktok | x | linkedin | reddit | whatsapp | pinterest
  display_name  text NOT NULL,                       -- "Instagram", or a specific account/handle
  handle        text,                                -- optional @handle / channel / community
  account_count integer NOT NULL DEFAULT 1 CHECK (account_count >= 0),
  category      social_category NOT NULL DEFAULT 'other',
  is_active     boolean NOT NULL DEFAULT true,
  sort_order    integer NOT NULL DEFAULT 0,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_reader_sources_family ON public.social_reader_sources (family_id, is_active, sort_order);

-- ---------- the feed items ----------
CREATE TABLE IF NOT EXISTS public.social_reader_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  source_id     uuid REFERENCES public.social_reader_sources(id) ON DELETE SET NULL,
  platform      text NOT NULL,
  author_name   text NOT NULL,
  author_handle text,
  avatar_url    text,
  content       text,
  media_urls    text[] NOT NULL DEFAULT '{}',
  thumbnail_url text,
  permalink     text,
  kind          social_item_kind NOT NULL DEFAULT 'post',
  duration_label text,                               -- e.g. "12:45" for video, "0:15" for short
  category      social_category NOT NULL DEFAULT 'other',
  verified      boolean NOT NULL DEFAULT false,
  is_favorite   boolean NOT NULL DEFAULT false,
  is_read       boolean NOT NULL DEFAULT false,
  external_id   text,                                -- platform's id, for idempotent ingestion
  posted_at     timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_social_reader_items_family ON public.social_reader_items (family_id, posted_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_reader_items_source ON public.social_reader_items (source_id);
-- Idempotent ingestion: one row per platform item per family.
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_reader_items_external ON public.social_reader_items (family_id, platform, external_id) WHERE external_id IS NOT NULL;

-- ============================================================================
-- Family-scoped RLS + updated_at triggers.
-- ============================================================================
DO $$
DECLARE t text;
DECLARE tbls text[] := ARRAY['social_reader_sources','social_reader_items'];
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
-- Done. Social Feed (consumption). Live per-platform ingestion is integration-
-- gated (OAuth/API keys); the store + UI are complete. See AGENT_HANDOFF.md.
-- ============================================================================



-- ══════════ 0102_food_os.sql ══════════
-- Family Food Operating System — two new tables that close the loop on the
-- existing food stack (meals, recipes, pantry, grocery, nutrition):
--   leftover_inventory  — track leftovers so the AI Chef reuses them first
--                         (an industry-first waste-cutting differentiator).
--   family_food_scores  — daily snapshots of the Family Food Health Score so the
--                         Smart Kitchen Dashboard can show a trend over time.

-- ── Leftover inventory ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.leftover_inventory (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id    uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
  source_meal  text,                      -- e.g. "Sunday roast chicken"
  quantity     text,                      -- free-text portion ("2 servings")
  stored_on    date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  use_by       date,                      -- eat-before date
  location     text NOT NULL DEFAULT 'fridge'
                 CHECK (location IN ('fridge','freezer','counter','other')),
  status       text NOT NULL DEFAULT 'fresh'
                 CHECK (status IN ('fresh','eaten','frozen','tossed','donated')),
  notes        text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leftover_family   ON public.leftover_inventory(family_id, status);
CREATE INDEX IF NOT EXISTS idx_leftover_use_by   ON public.leftover_inventory(family_id, use_by);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.leftover_inventory;
drop trigger if exists trg_set_updated_at on public.leftover_inventory;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.leftover_inventory
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.leftover_inventory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage leftover_inventory" ON public.leftover_inventory;
drop policy if exists "Members can manage leftover_inventory" on public.leftover_inventory;
CREATE POLICY "Members can manage leftover_inventory" ON public.leftover_inventory
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));

-- ── Family Food Health Score snapshots ─────────────────────────
CREATE TABLE IF NOT EXISTS public.family_food_scores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  snapshot_date date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  overall       integer NOT NULL CHECK (overall BETWEEN 0 AND 100),
  grade         text NOT NULL,
  sub_scores    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{ key, label, score, detail }]
  coaching      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- string[]
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (family_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_food_scores_family ON public.family_food_scores(family_id, snapshot_date DESC);

DROP TRIGGER IF EXISTS trg_set_updated_at ON public.family_food_scores;
drop trigger if exists trg_set_updated_at on public.family_food_scores;
CREATE TRIGGER trg_set_updated_at BEFORE UPDATE ON public.family_food_scores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.family_food_scores ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Members can manage family_food_scores" ON public.family_food_scores;
drop policy if exists "Members can manage family_food_scores" on public.family_food_scores;
CREATE POLICY "Members can manage family_food_scores" ON public.family_food_scores
  FOR ALL TO authenticated
  USING (public.is_family_member(family_id))
  WITH CHECK (public.is_family_member(family_id));



-- ══════════ 0103_enum_backfill.sql ══════════
-- FamilyOS :: 0103 — backfill enum values that drifted on long-lived databases.
--
-- Root cause: 0001 defines each enum with `create type … exception when
-- duplicate_object then null`. On a database that already had an OLDER version
-- of an enum, the CREATE is skipped entirely, so values added to the canonical
-- definition later were NEVER applied. The app and seeds then fail with, e.g.:
--   ERROR 22P02: invalid input value for enum event_category: "appointment"
--
-- This migration reconciles every drift-prone enum to its canonical value set.
-- `ALTER TYPE … ADD VALUE IF NOT EXISTS` is idempotent and safe to re-run; it
-- only appends values that are missing and never removes or reorders anything.
-- (ADD VALUE is transaction-safe on PG 12+; we only add values here, we don't
-- use them, so running inside the migration transaction is fine.)

-- ── event_category (the reported failure) ──
alter type public.event_category add value if not exists 'general';
alter type public.event_category add value if not exists 'school';
alter type public.event_category add value if not exists 'sports';
alter type public.event_category add value if not exists 'appointment';
alter type public.event_category add value if not exists 'medication';
alter type public.event_category add value if not exists 'maintenance';
alter type public.event_category add value if not exists 'birthday';
alter type public.event_category add value if not exists 'holiday';
alter type public.event_category add value if not exists 'other';

-- ── task_status (gained 'done' after 0001) ──
alter type public.task_status add value if not exists 'todo';
alter type public.task_status add value if not exists 'in_progress';
alter type public.task_status add value if not exists 'submitted';
alter type public.task_status add value if not exists 'done';
alter type public.task_status add value if not exists 'approved';
alter type public.task_status add value if not exists 'rejected';

-- ── meal_type ──
alter type public.meal_type add value if not exists 'breakfast';
alter type public.meal_type add value if not exists 'lunch';
alter type public.meal_type add value if not exists 'dinner';
alter type public.meal_type add value if not exists 'snack';

-- ── recurrence_freq ──
alter type public.recurrence_freq add value if not exists 'none';
alter type public.recurrence_freq add value if not exists 'daily';
alter type public.recurrence_freq add value if not exists 'weekly';
alter type public.recurrence_freq add value if not exists 'monthly';
alter type public.recurrence_freq add value if not exists 'yearly';

-- ── priority ──
alter type public.priority add value if not exists 'low';
alter type public.priority add value if not exists 'medium';
alter type public.priority add value if not exists 'high';

-- ── member_role ──
alter type public.member_role add value if not exists 'parent';
alter type public.member_role add value if not exists 'adult';
alter type public.member_role add value if not exists 'teen';
alter type public.member_role add value if not exists 'child';
alter type public.member_role add value if not exists 'caregiver';
alter type public.member_role add value if not exists 'guest';

-- ── transaction_type ──
alter type public.transaction_type add value if not exists 'income';
alter type public.transaction_type add value if not exists 'expense';
alter type public.transaction_type add value if not exists 'transfer';



-- ══════════ 0104_dining_out.sql ══════════
-- FamilyOS :: 0104 — Dining Out
-- Backs the "Dining Out" surface of the Food & Nutrition hub: saved restaurants
-- the family wants to try / loves, plus a log of recent dining-out visits.
-- Follows the food-OS conventions (0102): is_family_member RLS + set_updated_at.

create table if not exists public.dining_out (
  id           uuid        primary key default gen_random_uuid(),
  family_id    uuid        not null references public.families(id) on delete cascade,
  name         text        not null,
  kind         text        not null default 'restaurant' check (kind in ('restaurant','visit')),
  cuisine      text,
  category     text,                                   -- e.g. Healthy, Sushi, American
  price_level  int         check (price_level between 1 and 4),
  rating       numeric(2,1) check (rating >= 0 and rating <= 5),
  address      text,
  distance_km  numeric(5,1),
  amount_cents int         check (amount_cents >= 0), -- spend on a logged visit
  item_count   int         check (item_count >= 0),   -- items ordered on a visit
  notes        text,
  is_favorite  boolean     not null default false,
  visited_at   timestamptz,                            -- set for kind='visit'
  metadata     jsonb       not null default '{}',
  created_by   uuid        references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_dining_out_family          on public.dining_out(family_id);
create index if not exists idx_dining_out_family_kind      on public.dining_out(family_id, kind);
create index if not exists idx_dining_out_family_visited   on public.dining_out(family_id, visited_at desc);
create index if not exists idx_dining_out_family_favorite  on public.dining_out(family_id, is_favorite);

drop trigger if exists trg_set_updated_at on public.dining_out;
drop trigger if exists trg_set_updated_at on public.dining_out;
create trigger trg_set_updated_at before update on public.dining_out
  for each row execute function public.set_updated_at();

alter table public.dining_out enable row level security;

drop policy if exists "Members can manage dining_out" on public.dining_out;
drop policy if exists "Members can manage dining_out" on public.dining_out;
create policy "Members can manage dining_out" on public.dining_out
  for all to authenticated
  using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));



-- ══════════ 0105_calendar_events_rls_repair.sql ══════════
-- FamilyOS :: 0105 calendar_events RLS repair
-- ----------------------------------------------------------------------------
-- Production drift fix: some environments ended up with RLS enabled on
-- public.calendar_events but WITHOUT the standard family-scoped SELECT policy
-- (or with a stale one), so authenticated reads returned zero rows even for
-- valid family members — the Calendar page rendered empty despite data being
-- present. This re-asserts the exact policies 0004_rls.sql intends, idempotently.
--
-- Safe to run anywhere: DROP ... IF EXISTS + CREATE recreates the canonical
-- is_family_member(family_id) policy for every CRUD verb.

alter table public.calendar_events enable row level security;

drop policy if exists calendar_events_select on public.calendar_events;
drop policy if exists calendar_events_select on public.calendar_events;
create policy calendar_events_select on public.calendar_events
  for select using (public.is_family_member(family_id));

drop policy if exists calendar_events_insert on public.calendar_events;
drop policy if exists calendar_events_insert on public.calendar_events;
create policy calendar_events_insert on public.calendar_events
  for insert with check (public.is_family_member(family_id));

drop policy if exists calendar_events_update on public.calendar_events;
drop policy if exists calendar_events_update on public.calendar_events;
create policy calendar_events_update on public.calendar_events
  for update using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

drop policy if exists calendar_events_delete on public.calendar_events;
drop policy if exists calendar_events_delete on public.calendar_events;
create policy calendar_events_delete on public.calendar_events
  for delete using (public.is_family_member(family_id));



-- ══════════ 0105_child_logins.sql ══════════
-- FamilyOS :: 0105 — Child logins (no email required)
--
-- Lets a parent give a child (who has no email) a real account they can sign
-- into with a simple username + 4-digit PIN. The child gets a Supabase Auth user
-- created under a synthetic, never-emailed address; this table maps the public
-- login username → that auth user + family member so sign-in can resolve it.
--
-- The child's family_members row is linked to the auth user via family_members.user_id
-- (set by the create action), so once they sign in they ARE their member — chores,
-- rewards, the /kids surface, everything already works.

create table if not exists public.child_logins (
  id          uuid        primary key default gen_random_uuid(),
  family_id   uuid        not null references public.families(id) on delete cascade,
  member_id   uuid        not null references public.family_members(id) on delete cascade,
  user_id     uuid        not null references auth.users(id) on delete cascade,  -- child's synthetic auth user
  username    text        not null,
  created_by  uuid        references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (member_id),
  unique (user_id)
);

-- Case-insensitive unique username (the public login handle).
create unique index if not exists idx_child_logins_username_lower on public.child_logins (lower(username));
create index if not exists idx_child_logins_family on public.child_logins (family_id);

drop trigger if exists trg_set_updated_at on public.child_logins;
drop trigger if exists trg_set_updated_at on public.child_logins;
create trigger trg_set_updated_at before update on public.child_logins
  for each row execute function public.set_updated_at();

alter table public.child_logins enable row level security;

-- Family members can SEE their family's child logins (managers manage them via
-- service-role server actions that assert the manager role; anonymous username→
-- email resolution at sign-in also runs through the service role). No public read.
drop policy if exists "Members can view child_logins" on public.child_logins;
drop policy if exists "Members can view child_logins" on public.child_logins;
create policy "Members can view child_logins" on public.child_logins
  for select to authenticated
  using (public.is_family_member(family_id));

drop policy if exists "Managers manage child_logins" on public.child_logins;
drop policy if exists "Managers manage child_logins" on public.child_logins;
create policy "Managers manage child_logins" on public.child_logins
  for all to authenticated
  using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));



-- ══════════ 0106_todo_rls_repair.sql ══════════
-- FamilyOS :: 0106 todo_lists / todo_items RLS repair
-- ----------------------------------------------------------------------------
-- Same production-drift safeguard as 0105 (calendar_events): re-assert the
-- canonical family-scoped policies for the Tasks page's tables so authenticated
-- family members can actually read/write their tasks. Idempotent.

do $$
declare t text;
begin
  foreach t in array array['todo_lists','todo_items'] loop
    execute format('alter table public.%I enable row level security;', t);

    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);

    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);

    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);

    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0107_meals_media_rls.sql ══════════
-- FamilyOS :: 0107 meals media + RLS repair
-- ----------------------------------------------------------------------------
-- 1) Add a photo to planner meals so the Meal Plan grid can show dish images
--    (family_recipes already has photo_url; meals did not).
-- 2) Re-assert the family-scoped RLS policies on the meals-domain tables (same
--    drift safeguard as 0105/0106) so authenticated members can read/write the
--    planner, recipes, grocery list, and votes. Idempotent.

alter table public.meals add column if not exists image_url text;

do $$
declare t text;
begin
  foreach t in array array[
    'meals','meal_plans','grocery_lists','grocery_items',
    'family_recipes','meal_votes','meal_vote_options','meal_vote_ballots','meal_nutrition'
  ] loop
    -- Only touch tables that actually exist + carry family_id.
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'family_id'
    ) then
      execute format('alter table public.%I enable row level security;', t);
      execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
      execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
      execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
      execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
      execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
    end if;
  end loop;
end $$;



-- ══════════ 0108_album_highlight_kind.sql ══════════
-- FamilyOS :: 0108 family_albums 'highlight' kind + RLS safeguard
-- ----------------------------------------------------------------------------
-- The redesigned Memories page distinguishes "Recent Highlights" (curated,
-- front-and-center albums) from ordinary "Albums". Highlights are stored as
-- family_albums rows with kind = 'highlight', but the original CHECK constraint
-- from 0014_core_platform.sql did not allow that value, so those inserts would
-- fail. This migration widens the allowed kinds to include 'highlight'.
--
-- It also re-asserts the canonical family-scoped RLS policies on family_albums
-- and family_photos (idempotently) as a guard against the kind of production
-- policy drift that previously left family pages silently empty (see 0105-0107).
--
-- Safe to run anywhere: additive + idempotent.

-- ── Widen the album kind CHECK to include 'highlight' ────────────────────────
alter table public.family_albums drop constraint if exists family_albums_kind_check;
alter table public.family_albums
  add constraint family_albums_kind_check
  check (kind in (
    'general', 'vacation', 'school', 'sports', 'milestones',
    'holiday', 'birthday', 'highlight', 'other'
  ));

-- Fast lookups of an album's highlights within a family, newest first.
create index if not exists idx_family_albums_family_kind
  on public.family_albums (family_id, kind, created_at desc);

-- ── Re-assert canonical RLS (family-scoped, all verbs) ───────────────────────
alter table public.family_albums enable row level security;
drop policy if exists "family members can manage albums" on public.family_albums;
create policy "family members can manage albums"
  on public.family_albums for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()))
  with check (family_id in (select family_id from public.family_members where user_id = auth.uid()));

alter table public.family_photos enable row level security;
drop policy if exists "family members can manage photos" on public.family_photos;
create policy "family members can manage photos"
  on public.family_photos for all
  using (family_id in (select family_id from public.family_members where user_id = auth.uid()))
  with check (family_id in (select family_id from public.family_members where user_id = auth.uid()));



-- ══════════ 0108_messages_enhance.sql ══════════
-- ============================================================================
-- 0108_messages_enhance.sql — additive enhancements for the redesigned
-- Messages page (conversation tabs, archive, and the "About this chat" panel).
--
-- Safe & idempotent. No data loss. Touches only public.family_conversations.
--   • description   — free text shown in the "About this chat" panel.
--   • is_archived   — powers the "View archived conversations" filter.
--   • kind check    — widen to allow 'announcement' + 'channel' so the
--                     Announcements tab has a first-class conversation kind.
--   • index         — (family_id, is_archived, last_message_at desc) for the
--                     conversation-list query.
-- RLS is already enabled on this table (migration 0014) and unchanged here.
-- ============================================================================

alter table public.family_conversations
  add column if not exists description text;

alter table public.family_conversations
  add column if not exists is_archived boolean not null default false;

-- Widen the kind check constraint to include announcement/channel. The
-- constraint name from 0014 is the table-default; drop whatever exists and
-- recreate with the full allowed set.
do $$
declare
  c_name text;
begin
  select con.conname into c_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'family_conversations'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%kind%';
  if c_name is not null then
    execute format('alter table public.family_conversations drop constraint %I', c_name);
  end if;
end $$;

alter table public.family_conversations
  add constraint family_conversations_kind_check
  check (kind in ('group', 'direct', 'announcement', 'channel'));

create index if not exists idx_family_conversations_list
  on public.family_conversations (family_id, is_archived, last_message_at desc);

-- Helps the unread-count / last-preview scan filter out soft-deleted rows.
create index if not exists idx_family_messages_family_active
  on public.family_messages (family_id, created_at desc)
  where deleted_at is null;



-- ══════════ 0109_documents_favorite.sql ══════════
-- FamilyOS :: 0109 documents.is_favorite + Files indexes + RLS safeguard
-- ----------------------------------------------------------------------------
-- The redesigned Files page (/dashboard/documents) adds a per-file favorite
-- ("star") toggle and richer sorting/filtering. This migration:
--   1. Adds documents.is_favorite (additive, defaults false) so starring works.
--   2. Adds indexes for the page's common query patterns (family + recency,
--      family + favorite).
--   3. Re-asserts the canonical family-scoped RLS on public.documents for all
--      four verbs, as a guard against the production policy drift that has
--      silently emptied family pages before (see 0105-0108).
--
-- Safe to run anywhere: additive + idempotent.

alter table public.documents add column if not exists is_favorite boolean not null default false;

create index if not exists idx_documents_family_created  on public.documents (family_id, created_at desc);
create index if not exists idx_documents_family_favorite on public.documents (family_id, is_favorite);
create index if not exists idx_documents_family_category on public.documents (family_id, category);

alter table public.documents enable row level security;

drop policy if exists documents_select on public.documents;
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select using (public.is_family_member(family_id));

drop policy if exists documents_insert on public.documents;
drop policy if exists documents_insert on public.documents;
create policy documents_insert on public.documents
  for insert with check (public.is_family_member(family_id));

drop policy if exists documents_update on public.documents;
drop policy if exists documents_update on public.documents;
create policy documents_update on public.documents
  for update using (public.is_family_member(family_id))
  with check (public.is_family_member(family_id));

drop policy if exists documents_delete on public.documents;
drop policy if exists documents_delete on public.documents;
create policy documents_delete on public.documents
  for delete using (public.is_family_member(family_id));



-- ══════════ 0109_finance_rls_repair.sql ══════════
-- FamilyOS :: 0109 finance RLS repair
-- ----------------------------------------------------------------------------
-- Same production-drift safeguard as 0105/0106/0107 for the Finances page's
-- tables: re-assert the canonical family-scoped policies so authenticated
-- members can read/write their money data. Idempotent.

do $$
declare t text;
begin
  foreach t in array array['financial_accounts','transactions','budgets','bills','savings_goals'] loop
    if exists (select 1 from information_schema.columns where table_schema='public' and table_name=t and column_name='family_id') then
      execute format('alter table public.%I enable row level security;', t);
      execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
      execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
      execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
      execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
      execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
      execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
    end if;
  end loop;
end $$;



-- ══════════ 0109_user_preferences_rls_repair.sql ══════════
-- FamilyOS :: 0109 user_preferences RLS repair
-- ----------------------------------------------------------------------------
-- Production-drift safeguard (same class as 0105/0106/0107). The canonical
-- policy from 0004 (`prefs_all` FOR ALL, own-row) drifted in production, leaving
-- no valid INSERT policy — so upserting a member's own preferences (e.g. saving
-- Capture shortcuts) failed with:
--   "new row violates row-level security policy for table user_preferences".
--
-- Re-assert own-row policies for SELECT/INSERT/UPDATE/DELETE keyed on
-- `user_id = auth.uid()`. Granular (not just FOR ALL) so the INSERT path is
-- always covered. Idempotent; no data change.

alter table public.user_preferences enable row level security;

-- Replace the (possibly drifted) blanket policy.
drop policy if exists prefs_all on public.user_preferences;

drop policy if exists user_preferences_select on public.user_preferences;
drop policy if exists user_preferences_select on public.user_preferences;
create policy user_preferences_select on public.user_preferences
  for select using (user_id = auth.uid());

drop policy if exists user_preferences_insert on public.user_preferences;
drop policy if exists user_preferences_insert on public.user_preferences;
create policy user_preferences_insert on public.user_preferences
  for insert with check (user_id = auth.uid());

drop policy if exists user_preferences_update on public.user_preferences;
drop policy if exists user_preferences_update on public.user_preferences;
create policy user_preferences_update on public.user_preferences
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists user_preferences_delete on public.user_preferences;
drop policy if exists user_preferences_delete on public.user_preferences;
create policy user_preferences_delete on public.user_preferences
  for delete using (user_id = auth.uid());



-- ══════════ 0110_family_profile.sql ══════════
-- FamilyOS :: 0110 family profile fields + member contact fields + RLS safeguard
-- ----------------------------------------------------------------------------
-- The new Family hub page (/dashboard/family) shows a richer family profile
-- (cover photo, mailing address, a shareable family code) and per-member
-- contact details (email, phone, avatar). This migration adds those columns to
-- the existing tables — no new tables, no duplicate domains.
--
--   families:        + cover_url, + address, + family_code (unique)
--   family_members:  + email, + phone, + avatar_url
--
-- It backfills a stable family_code for existing families and re-asserts the
-- canonical RLS on families + family_members (drift guard, see 0105-0109).
--
-- Safe to run anywhere: additive + idempotent.

-- ── families: profile fields ────────────────────────────────────────────────
alter table public.families add column if not exists cover_url   text;
alter table public.families add column if not exists address     text;
alter table public.families add column if not exists family_code text;

-- Backfill a human-friendly share code for families that lack one:
-- three letters from the name + a 4-char hash suffix, e.g. "PAR-7X9M".
update public.families
   set family_code = upper(
         coalesce(nullif(regexp_replace(left(name, 3), '[^A-Za-z]', '', 'g'), ''), 'FAM')
       ) || '-' || upper(substr(md5(id::text), 1, 4))
 where family_code is null;

-- The derived code can collide (short hash + shared name prefixes). De-dup by
-- suffixing a counter to every duplicate so the unique index below can build.
with dupes as (
  select id, family_code,
         row_number() over (partition by family_code order by created_at, id) as rn
    from public.families
   where family_code is not null
)
update public.families f
   set family_code = f.family_code || '-' || dupes.rn
  from dupes
 where dupes.id = f.id and dupes.rn > 1;

create unique index if not exists idx_families_family_code on public.families (family_code);

-- ── family_members: contact fields ──────────────────────────────────────────
alter table public.family_members add column if not exists email      text;
alter table public.family_members add column if not exists phone      text;
alter table public.family_members add column if not exists avatar_url text;

create index if not exists idx_family_members_family_active
  on public.family_members (family_id, is_active);

-- ── Re-assert canonical RLS (drift guard) ───────────────────────────────────
alter table public.families enable row level security;
drop policy if exists families_select on public.families;
drop policy if exists families_select on public.families;
create policy families_select on public.families for select using (public.is_family_member(id));
drop policy if exists families_update on public.families;
drop policy if exists families_update on public.families;
create policy families_update on public.families for update using (public.can_manage_family(id)) with check (public.can_manage_family(id));

alter table public.family_members enable row level security;
drop policy if exists fm_manage on public.family_members;
drop policy if exists fm_select on public.family_members;
drop policy if exists fm_select on public.family_members;
create policy fm_select on public.family_members for select using (public.is_family_member(family_id));
drop policy if exists fm_insert on public.family_members;
drop policy if exists fm_insert on public.family_members;
create policy fm_insert on public.family_members for insert with check (public.can_manage_family(family_id));
drop policy if exists fm_update on public.family_members;
drop policy if exists fm_update on public.family_members;
create policy fm_update on public.family_members for update using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id));
drop policy if exists fm_delete on public.family_members;
drop policy if exists fm_delete on public.family_members;
create policy fm_delete on public.family_members for delete using (public.can_manage_family(family_id));



-- ══════════ 0110_transactions_member.sql ══════════
-- FamilyOS :: 0110 transactions.member_id
-- ----------------------------------------------------------------------------
-- Adds a nullable per-member attribution to transactions so the Finances
-- dashboard's "Spending by Person" card can group real spend by family member.
-- Additive + idempotent; RLS unchanged (still family-scoped via 0109).

alter table public.transactions
  add column if not exists member_id uuid references public.family_members(id) on delete set null;

create index if not exists idx_transactions_family_member on public.transactions(family_id, member_id);



-- ══════════ 0111_location_geofence_address.sql ══════════
-- 0111_location_geofence_address.sql
-- Additive columns for the redesigned /dashboard/locator (Location) page:
--   • family_places.geofence_enabled — powers the "Geofences" on/off toggles.
--   • member_locations.address        — the human address shown in "Live Locations".
-- Both are backward-compatible (nullable / defaulted) and change no existing rows.
-- RLS is unchanged: both tables already carry family-scoped "Members can manage"
-- FOR ALL policies (migration 0042).

ALTER TABLE public.family_places
  ADD COLUMN IF NOT EXISTS geofence_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE public.member_locations
  ADD COLUMN IF NOT EXISTS address text;

-- Location History / Place Alerts read events newest-first per family.
CREATE INDEX IF NOT EXISTS idx_location_events_family_time
  ON public.location_events(family_id, occurred_at DESC);



-- ══════════ 0112_location_realtime.sql ══════════
-- 0112_location_realtime.sql
-- Enable Supabase Realtime for the Location (/dashboard/locator) tables so the
-- family map updates live across devices — when one member shares/moves or a
-- parent adds/edits/removes a place or geofence, everyone else sees it without
-- a manual refresh. The locator uses useRealtimeQuery (postgres_changes), which
-- only receives events for tables in the supabase_realtime publication.
--
-- Idempotent: each ADD TABLE is guarded so re-running is safe.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'member_locations'
  ) then
do $pubguard$ begin alter publication supabase_realtime add table public.member_locations; exception when others then null; end $pubguard$;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'family_places'
  ) then
do $pubguard$ begin alter publication supabase_realtime add table public.family_places; exception when others then null; end $pubguard$;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'location_events'
  ) then
do $pubguard$ begin alter publication supabase_realtime add table public.location_events; exception when others then null; end $pubguard$;
  end if;
end $$;



-- ══════════ 0113_wallet_hub.sql ══════════
-- FamilyOS :: 0113 Wallet Hub ("My Wallet")
-- ----------------------------------------------------------------------------
-- Powers the /wallet "My Wallet" hub: one place for the family's money, cards,
-- passes/memberships and rewards. Reuses the existing finance domain for
-- accounts (financial_accounts) and transactions, and adds three new
-- family-scoped tables for cards, passes and reward programs.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

-- ── transactions: posted/pending status + merchant label ────────────────────
alter table public.transactions
  add column if not exists status text not null default 'posted';
alter table public.transactions
  add column if not exists merchant text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_status_check'
  ) then
    alter table public.transactions
      add constraint transactions_status_check
      check (status in ('posted', 'pending', 'cleared', 'failed', 'scheduled'));
  end if;
end $$;

create index if not exists idx_transactions_family_date on public.transactions(family_id, date desc);
create index if not exists idx_transactions_family_status on public.transactions(family_id, status);

-- ── wallet_cards ────────────────────────────────────────────────────────────
create table if not exists public.wallet_cards (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  member_id       uuid references public.family_members(id) on delete set null,
  name            text not null,
  brand           text not null default 'other' check (brand in ('visa','mastercard','amex','discover','other')),
  kind            text not null default 'credit' check (kind in ('credit','debit','gas','store','prepaid','other')),
  last_four       text,
  available_cents bigint not null default 0,
  limit_cents     bigint,
  color           text,
  is_active       boolean not null default true,
  sort_order      int not null default 0,
  metadata        jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_wallet_cards_family on public.wallet_cards(family_id, is_active, sort_order);

-- ── wallet_passes (memberships / loyalty / tickets) ─────────────────────────
create table if not exists public.wallet_passes (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  name        text not null,
  kind        text not null default 'membership' check (kind in ('membership','loyalty','ticket','insurance','transit','other')),
  status      text,                 -- e.g. 'Member', 'Premium Plan'
  detail      text,                 -- e.g. 'Expires Dec 31, 2025', '5,240 points'
  member_no   text,
  points      integer,
  expires_on  date,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  metadata    jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_wallet_passes_family on public.wallet_passes(family_id, is_active, sort_order);

-- ── wallet_rewards (points / miles / cashback programs) ─────────────────────
create table if not exists public.wallet_rewards (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  member_id    uuid references public.family_members(id) on delete set null,
  name         text not null,
  kind         text not null default 'points' check (kind in ('points','miles','cashback')),
  balance      numeric(14,2) not null default 0,
  unit         text not null default 'points',      -- 'points' | 'miles' | '$'
  value_cents  bigint not null default 0,           -- estimated cash value
  program      text,
  is_active    boolean not null default true,
  sort_order   int not null default 0,
  metadata     jsonb not null default '{}'::jsonb,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_wallet_rewards_family on public.wallet_rewards(family_id, is_active, sort_order);

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['wallet_cards','wallet_passes','wallet_rewards'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS: family-scoped for all four operations ──────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['wallet_cards','wallet_passes','wallet_rewards'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0114_family_safety.sql ══════════
-- FamilyOS :: 0114 Family safety & play dates
-- ----------------------------------------------------------------------------
-- Backs the new expandable "Family" nav group:
--   • safety_check_ins — lightweight "I'm safe / on my way / need help" posts
--   • driving_trips     — per-driver trip log with a safety score
--   • play_dates        — kids' play-date scheduling
-- (Find Phone reuses the existing member_locations + family_places tables.)
--
-- Family-scoped RLS via public.is_family_member. Idempotent.

-- ── safety_check_ins ────────────────────────────────────────────────────────
create table if not exists public.safety_check_ins (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  status      text not null default 'safe' check (status in ('safe','on_my_way','arrived','need_help')),
  place_id    uuid references public.family_places(id) on delete set null,
  place_label text,
  note        text,
  latitude    double precision,
  longitude   double precision,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_safety_check_ins_family on public.safety_check_ins(family_id, created_at desc);

-- ── driving_trips ───────────────────────────────────────────────────────────
create table if not exists public.driving_trips (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  member_id     uuid references public.family_members(id) on delete set null,
  label         text,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  distance_miles numeric(8,1) not null default 0,
  max_mph       int not null default 0,
  hard_brakes   int not null default 0,
  rapid_accels  int not null default 0,
  phone_use_seconds int not null default 0,
  score         int not null default 100 check (score between 0 and 100),
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_driving_trips_family on public.driving_trips(family_id, started_at desc);
create index if not exists idx_driving_trips_member on public.driving_trips(family_id, member_id);

-- ── play_dates ──────────────────────────────────────────────────────────────
create table if not exists public.play_dates (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  member_id     uuid references public.family_members(id) on delete set null,
  title         text not null,
  with_kids     text,
  location      text,
  place_id      uuid references public.family_places(id) on delete set null,
  starts_at     timestamptz not null,
  ends_at       timestamptz,
  status        text not null default 'planned' check (status in ('planned','confirmed','completed','cancelled')),
  contact_name  text,
  contact_phone text,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_play_dates_family on public.play_dates(family_id, starts_at desc);

-- ── updated_at triggers (tables that have updated_at) ───────────────────────
do $$
declare t text;
begin
  foreach t in array array['driving_trips','play_dates'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['safety_check_ins','driving_trips','play_dates'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0115_meals_hub.sql ══════════
-- FamilyOS :: 0115 Meals hub extras (Family Favorites + Nutrition Tracker)
-- ----------------------------------------------------------------------------
-- Backs two new pages under the expandable "Meals" nav group:
--   • family_favorites — the family's favorite recipes / restaurants / meals
--   • nutrition_logs    — per-member daily food logging (calories + macros)
-- Family-scoped RLS via public.is_family_member. Idempotent.

-- ── family_favorites ────────────────────────────────────────────────────────
create table if not exists public.family_favorites (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  kind        text not null default 'recipe' check (kind in ('recipe','restaurant','meal','snack','drink','other')),
  name        text not null,
  notes       text,
  rating      int check (rating between 1 and 5),
  ref_url     text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_family_favorites_family on public.family_favorites(family_id, kind);

-- ── nutrition_logs ──────────────────────────────────────────────────────────
create table if not exists public.nutrition_logs (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  logged_on   date not null default (now()::date),
  meal        text not null default 'breakfast' check (meal in ('breakfast','lunch','dinner','snack')),
  item        text not null,
  calories    int not null default 0,
  protein_g   numeric(6,1) not null default 0,
  carbs_g     numeric(6,1) not null default 0,
  fat_g       numeric(6,1) not null default 0,
  water_ml    int not null default 0,
  notes       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_nutrition_logs_family_date on public.nutrition_logs(family_id, logged_on desc);
create index if not exists idx_nutrition_logs_member on public.nutrition_logs(family_id, member_id, logged_on desc);

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_favorites','nutrition_logs'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS ─────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_favorites','nutrition_logs'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0116_bills_autopay.sql ══════════
-- FamilyOS :: 0116 bills.autopay
-- ----------------------------------------------------------------------------
-- Adds an autopay flag to bills so the new Finances "Auto Pay" page can list and
-- toggle which bills are set to pay automatically. Additive + idempotent; the
-- bills table already has family-scoped RLS.

alter table public.bills
  add column if not exists autopay boolean not null default false;

create index if not exists idx_bills_family_due on public.bills(family_id, due_date);
create index if not exists idx_bills_family_autopay on public.bills(family_id, autopay) where autopay;



-- ══════════ 0117_documents_secure.sql ══════════
-- 0117_documents_secure.sql
-- Adds a "Secure Vault" flag to documents so the Files hub can split storage into
-- Cloud Storage (everything) / Secure Vault (is_secure) / Shared Files (the rest).
-- Additive + backward-compatible: nullable-safe boolean default false, existing
-- rows unchanged. RLS is unchanged — `documents` already carries a family-scoped
-- policy (migration 0004) that governs this column.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS is_secure boolean NOT NULL DEFAULT false;

-- The Files sub-pages filter by (family_id, is_secure); index that access path.
CREATE INDEX IF NOT EXISTS idx_documents_family_secure
  ON public.documents(family_id, is_secure);



-- ══════════ 0118_rls_drift_repair.sql ══════════
-- 0118_rls_drift_repair.sql
-- Consolidated repair for the systemic production RLS drift found on 2026-06-30:
-- tables had RLS ENABLED but their family-scoped policies were missing in prod,
-- so every authenticated read silently returned 0 rows ("seeded but page is
-- empty"). Piecemeal repairs shipped as 0105 (calendar_events), 0106 (todos),
-- 0107 (meals domain), 0109 (finance domain); this migration closes the TODO by
-- auditing EVERY table and healing whatever is still broken — including tables
-- added since — in one idempotent pass.
--
-- Safety model (cannot weaken anything):
--   A. RLS is (re-)enabled on every public base table — same as 0004.
--   B. The special-case tables from 0004 (profiles, families, family_members,
--      invites, notifications, audit_logs, billing_customers, subscriptions,
--      user_preferences) get their ORIGINAL, stricter policy shapes re-asserted
--      verbatim (drop-if-exists + create — a faithful re-run of 0004).
--   C. Every OTHER table with a family_id column is healed ONLY IF it currently
--      has NO SELECT policy at all (the drift symptom). Tables that already
--      carry any select policy — including intentionally stricter custom ones —
--      are left completely untouched.
-- Re-running is a no-op wherever policies exist. Postgres-only; no data change.

-- A) Enable RLS everywhere (idempotent) ---------------------------------------
do $$
declare t text;
begin
  for t in
    select table_name from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- B) Re-assert 0004's special-case policies verbatim ---------------------------
-- profiles: self + family visibility; self-only writes.
drop policy if exists profiles_select_self on public.profiles;
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles for select
  using (
    id = auth.uid()
    or exists (
      select 1 from public.family_members me
      join public.family_members them on them.family_id = me.family_id
      where me.user_id = auth.uid() and them.user_id = public.profiles.id
    )
  );
drop policy if exists profiles_insert_self on public.profiles;
drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self on public.profiles for insert with check (id = auth.uid());
drop policy if exists profiles_update_self on public.profiles;
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update using (id = auth.uid());

-- families
drop policy if exists families_select on public.families;
drop policy if exists families_select on public.families;
create policy families_select on public.families for select
  using (public.is_family_member(id));
drop policy if exists families_insert on public.families;
drop policy if exists families_insert on public.families;
create policy families_insert on public.families for insert
  with check (created_by = auth.uid());
drop policy if exists families_update on public.families;
drop policy if exists families_update on public.families;
create policy families_update on public.families for update
  using (public.can_manage_family(id));
drop policy if exists families_delete on public.families;
drop policy if exists families_delete on public.families;
create policy families_delete on public.families for delete
  using (public.is_family_admin(id));

-- family_members
drop policy if exists fm_select on public.family_members;
drop policy if exists fm_select on public.family_members;
create policy fm_select on public.family_members for select
  using (public.is_family_member(family_id));
drop policy if exists fm_insert on public.family_members;
drop policy if exists fm_insert on public.family_members;
create policy fm_insert on public.family_members for insert
  with check (public.can_manage_family(family_id));
drop policy if exists fm_update on public.family_members;
drop policy if exists fm_update on public.family_members;
create policy fm_update on public.family_members for update
  using (public.can_manage_family(family_id) or user_id = auth.uid());
drop policy if exists fm_delete on public.family_members;
drop policy if exists fm_delete on public.family_members;
create policy fm_delete on public.family_members for delete
  using (public.can_manage_family(family_id));

-- invites
drop policy if exists invites_select on public.invites;
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select
  using (
    public.is_family_member(family_id)
    or lower(email) = lower(coalesce(auth.jwt()->>'email',''))
  );
drop policy if exists invites_insert on public.invites;
drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites for insert
  with check (public.can_manage_family(family_id));
drop policy if exists invites_update on public.invites;
drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites for update
  using (public.can_manage_family(family_id)
         or lower(email) = lower(coalesce(auth.jwt()->>'email','')));
drop policy if exists invites_delete on public.invites;
drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites for delete
  using (public.can_manage_family(family_id));

-- notifications (recipient-scoped or family broadcast)
drop policy if exists notif_select on public.notifications;
drop policy if exists notif_select on public.notifications;
create policy notif_select on public.notifications for select
  using (user_id = auth.uid() or (user_id is null and public.is_family_member(family_id)));
drop policy if exists notif_insert on public.notifications;
drop policy if exists notif_insert on public.notifications;
create policy notif_insert on public.notifications for insert
  with check (public.is_family_member(family_id));
drop policy if exists notif_update on public.notifications;
drop policy if exists notif_update on public.notifications;
create policy notif_update on public.notifications for update
  using (user_id = auth.uid() or (user_id is null and public.is_family_member(family_id)));
drop policy if exists notif_delete on public.notifications;
drop policy if exists notif_delete on public.notifications;
create policy notif_delete on public.notifications for delete
  using (user_id = auth.uid() or public.can_manage_family(family_id));

-- audit_logs (members append; managers read)
drop policy if exists audit_select on public.audit_logs;
drop policy if exists audit_select on public.audit_logs;
create policy audit_select on public.audit_logs for select
  using (public.can_manage_family(family_id));
drop policy if exists audit_insert on public.audit_logs;
drop policy if exists audit_insert on public.audit_logs;
create policy audit_insert on public.audit_logs for insert
  with check (family_id is null or public.is_family_member(family_id));

-- billing + subscriptions (members read, admin manages)
drop policy if exists billing_select on public.billing_customers;
drop policy if exists billing_select on public.billing_customers;
create policy billing_select on public.billing_customers for select
  using (public.is_family_member(family_id));
drop policy if exists billing_manage on public.billing_customers;
drop policy if exists billing_manage on public.billing_customers;
create policy billing_manage on public.billing_customers for all
  using (public.is_family_admin(family_id))
  with check (public.is_family_admin(family_id));

drop policy if exists subs_select on public.subscriptions;
drop policy if exists subs_select on public.subscriptions;
create policy subs_select on public.subscriptions for select
  using (public.is_family_member(family_id));
drop policy if exists subs_manage on public.subscriptions;
drop policy if exists subs_manage on public.subscriptions;
create policy subs_manage on public.subscriptions for all
  using (public.is_family_admin(family_id))
  with check (public.is_family_admin(family_id));

-- user_preferences (own only)
drop policy if exists prefs_all on public.user_preferences;
drop policy if exists prefs_all on public.user_preferences;
create policy prefs_all on public.user_preferences for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- C) Heal every other family_id table that has NO select policy ----------------
-- Only tables exhibiting the drift symptom (RLS on, zero select policies) get
-- the generic family CRUD set; anything with an existing select policy is
-- skipped so custom/stricter shapes are never overwritten.
do $$
declare t text;
declare healed text[] := '{}';
begin
  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'family_id'
      and tb.table_type = 'BASE TABLE'
      and c.table_name not in (
        'families','family_members','invites','notifications','audit_logs',
        'billing_customers','subscriptions'
      )
      and not exists (
        select 1 from pg_policies p
        where p.schemaname = 'public'
          and p.tablename = c.table_name
          and p.cmd in ('SELECT','ALL')
      )
  loop
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
    healed := array_append(healed, t);
  end loop;
  raise notice 'RLS drift repair healed % table(s): %', coalesce(array_length(healed,1),0), healed;
end $$;

-- D) Post-repair audit (informational): any family_id table still lacking a
-- select policy after this migration indicates a NEW kind of drift — investigate.
do $$
declare remaining text[];
begin
  select array_agg(c.table_name) into remaining
  from information_schema.columns c
  join information_schema.tables tb
    on tb.table_schema = c.table_schema and tb.table_name = c.table_name
  where c.table_schema = 'public'
    and c.column_name = 'family_id'
    and tb.table_type = 'BASE TABLE'
    and not exists (
      select 1 from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = c.table_name
        and p.cmd in ('SELECT','ALL')
    );
  if remaining is not null then
    raise warning 'Tables STILL missing a select policy after repair: %', remaining;
  else
    raise notice 'RLS audit clean: every family_id table has a select policy.';
  end if;
end $$;



-- ══════════ 0119_family_credentials.sql ══════════
-- FamilyOS :: 0119 family_credentials (Wi-Fi & Passwords vault)
-- ----------------------------------------------------------------------------
-- Backs the Family hub's "Wi-Fi & Passwords" card with a real store: shared
-- family credentials (Wi-Fi networks, streaming/website/app logins, door PINs,
-- membership numbers, cards). Family-scoped RLS via public.is_family_member;
-- soft-deletable; updated_at trigger. Additive + idempotent.
--
-- NOTE: secrets are stored as text behind RLS (family-only). The UI masks them
-- by default (reveal on demand). Client-side/at-rest encryption is a documented
-- future hardening — see docs/family-vault.md.

create table if not exists public.family_credentials (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  category    text not null default 'other'
              check (category in ('wifi','website','app','streaming','email','card','pin','membership','other')),
  label       text not null,
  username    text,
  secret      text not null default '',
  url         text,
  notes       text,
  member_id   uuid references public.family_members(id) on delete set null,
  is_favorite boolean not null default false,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index if not exists idx_family_credentials_family    on public.family_credentials(family_id, category);
create index if not exists idx_family_credentials_active    on public.family_credentials(family_id, created_at desc) where deleted_at is null;
create index if not exists idx_family_credentials_favorite  on public.family_credentials(family_id, is_favorite) where is_favorite and deleted_at is null;

-- updated_at trigger
drop trigger if exists set_family_credentials_updated on public.family_credentials;
drop trigger if exists set_family_credentials_updated on public.family_credentials;
create trigger set_family_credentials_updated
  before update on public.family_credentials
  for each row execute function public.set_updated_at();

-- RLS: family-scoped for all operations
alter table public.family_credentials enable row level security;
drop policy if exists family_credentials_select on public.family_credentials;
drop policy if exists family_credentials_select on public.family_credentials;
create policy family_credentials_select on public.family_credentials
  for select using (public.is_family_member(family_id));
drop policy if exists family_credentials_insert on public.family_credentials;
drop policy if exists family_credentials_insert on public.family_credentials;
create policy family_credentials_insert on public.family_credentials
  for insert with check (public.is_family_member(family_id));
drop policy if exists family_credentials_update on public.family_credentials;
drop policy if exists family_credentials_update on public.family_credentials;
create policy family_credentials_update on public.family_credentials
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));
drop policy if exists family_credentials_delete on public.family_credentials;
drop policy if exists family_credentials_delete on public.family_credentials;
create policy family_credentials_delete on public.family_credentials
  for delete using (public.is_family_member(family_id));



-- ══════════ 0120_marketplace.sql ══════════
-- FamilyOS :: 0120 Marketplace ("Buy, sell, rent, borrow within the platform")
-- ----------------------------------------------------------------------------
-- A family-scoped marketplace / lending board: post items to sell, rent out,
-- lend ("borrow"), give away free, or request ("wanted"). Other members express
-- interest or claim an item; the poster accepts an offer to hand it off.
--
--   • marketplace_listings — the items on the board
--   • marketplace_offers    — interest / claim requests against a listing
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

-- ── marketplace_listings ────────────────────────────────────────────────────
create table if not exists public.marketplace_listings (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  member_id    uuid references public.family_members(id) on delete set null,
  title        text not null,
  description  text,
  kind         text not null default 'sell'
                 check (kind in ('sell','rent','borrow','free','wanted')),
  category     text not null default 'other'
                 check (category in ('toys','clothing','books','electronics','furniture',
                                     'sports','tools','baby','games','other')),
  condition    text check (condition in ('new','like_new','good','fair','worn')),
  price_cents  bigint not null default 0,           -- sale price, or rate for rent
  rent_period  text check (rent_period in ('hour','day','week','month')),
  photo_url    text,
  location     text,
  status       text not null default 'available'
                 check (status in ('available','pending','claimed','completed','withdrawn')),
  claimed_by   uuid references public.family_members(id) on delete set null,
  claimed_at   timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_marketplace_listings_family
  on public.marketplace_listings(family_id, status, created_at desc);
create index if not exists idx_marketplace_listings_member
  on public.marketplace_listings(family_id, member_id);

-- ── marketplace_offers ──────────────────────────────────────────────────────
create table if not exists public.marketplace_offers (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,
  kind        text not null default 'interest'
                check (kind in ('interest','claim','offer')),
  amount_cents bigint,                              -- optional counter-offer for 'offer'
  message     text,
  status      text not null default 'open'
                check (status in ('open','accepted','declined','withdrawn')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_marketplace_offers_listing
  on public.marketplace_offers(listing_id, status);
create index if not exists idx_marketplace_offers_family
  on public.marketplace_offers(family_id, created_at desc);

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['marketplace_listings','marketplace_offers'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['marketplace_listings','marketplace_offers'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0121_voice_commands.sql ══════════
-- FamilyOS :: 0121 Voice commands ("Full conversational interface")
-- ----------------------------------------------------------------------------
-- Backs the Voice Control command center (/dashboard/voice): a family-scoped log
-- of every spoken command, how it was routed (task/note/event/shopping), what it
-- created, and its outcome. The transcript log powers the "recent commands"
-- history + one-tap re-run, and gives the conversational interface a memory.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.voice_commands (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  member_id     uuid references public.family_members(id) on delete set null,
  transcript    text not null,
  resolved_kind text check (resolved_kind in ('task','note','event','shopping')),
  action_table  text,                    -- e.g. 'todo_items', 'calendar_events'
  action_count  int not null default 0,  -- rows created by this command
  status        text not null default 'routed'
                  check (status in ('routed','failed','dismissed')),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists idx_voice_commands_family
  on public.voice_commands(family_id, created_at desc);
create index if not exists idx_voice_commands_member
  on public.voice_commands(family_id, member_id);

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['voice_commands'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0122_routine_templates.sql ══════════
-- FamilyOS :: 0122 recurring-routine templates
-- ----------------------------------------------------------------------------
-- A "routine" is a reusable bundle of related calendar events that repeats on a
-- set of weekdays — e.g. "School Morning" = wake 7:00 → breakfast 7:30 →
-- drop-off 8:00, every Mon–Fri. The per-event calendar_events.recurrence field
-- only models a single event repeating at one frequency, so routines get their
-- own tables. Applying a routine materializes concrete calendar_events.
--
-- weekday_mask: bit i set = active on that weekday, bit 0 = Monday … bit 6 =
-- Sunday (Monday-first, matching the app's week). e.g. Mon–Fri = 0b0011111 = 31.

create table if not exists public.routine_templates (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  name         text not null,
  icon         text,                       -- emoji
  color        text,                       -- token key (violet/blue/…)
  weekday_mask int  not null default 31 check (weekday_mask between 0 and 127),
  is_active    boolean not null default true,
  source       text not null default 'manual' check (source in ('manual','detected')),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_routine_templates_family on public.routine_templates(family_id);

create table if not exists public.routine_template_items (
  id             uuid primary key default gen_random_uuid(),
  template_id    uuid not null references public.routine_templates(id) on delete cascade,
  family_id      uuid not null references public.families(id) on delete cascade,
  title          text not null,
  category       public.event_category not null default 'general',
  start_minutes  int  not null default 0 check (start_minutes between 0 and 1439), -- from midnight
  duration_minutes int not null default 30 check (duration_minutes between 0 and 1440),
  assignee_id    uuid references public.family_members(id) on delete set null,
  sort_order     int  not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_routine_items_template on public.routine_template_items(template_id);
create index if not exists idx_routine_items_family on public.routine_template_items(family_id);

-- updated_at triggers
drop trigger if exists trg_set_updated_at on public.routine_templates;
drop trigger if exists trg_set_updated_at on public.routine_templates;
create trigger trg_set_updated_at before update on public.routine_templates
  for each row execute function public.set_updated_at();
drop trigger if exists trg_set_updated_at on public.routine_template_items;
drop trigger if exists trg_set_updated_at on public.routine_template_items;
create trigger trg_set_updated_at before update on public.routine_template_items
  for each row execute function public.set_updated_at();

-- RLS — family-scoped CRUD, same pattern as every other household table.
do $$
declare t text;
begin
  foreach t in array array['routine_templates','routine_template_items'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0123_family_facts.sql ══════════
-- FamilyOS :: 0123 Family facts ("Build a persistent family knowledge graph")
-- ----------------------------------------------------------------------------
-- The persistent store behind Family Memory: durable facts the family looks up
-- again and again — sizes, allergies, preferences, key contacts, account
-- numbers, "important to know" notes. Each fact optionally hangs off a member
-- (the knowledge-graph edge) or is family-level. Powers /dashboard/knowledge.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.family_facts (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,  -- who it's about (null = whole family)
  category    text not null default 'other'
                check (category in ('about','preference','medical','contact','sizes','important','account','date','other')),
  label       text not null,               -- e.g. "Shoe size", "Allergy", "Pediatrician"
  value       text not null,               -- e.g. "US 2", "Peanuts", "Dr. Lee 555-0100"
  notes       text,
  is_pinned   boolean not null default false,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_family_facts_family on public.family_facts(family_id, is_pinned desc, updated_at desc);
create index if not exists idx_family_facts_member on public.family_facts(family_id, member_id);
create index if not exists idx_family_facts_category on public.family_facts(family_id, category);

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists set_family_facts_updated on public.family_facts;
drop trigger if exists set_family_facts_updated on public.family_facts;
create trigger set_family_facts_updated before update on public.family_facts
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_facts'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0124_journey_events.sql ══════════
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



-- ══════════ 0125_family_operating_index.sql ══════════
-- FamilyOS :: 0125 Family Operating Index (the measurable core of the Operating Layer)
-- ----------------------------------------------------------------------------
-- The Operating Layer's north-star metric is "how well is this household
-- functioning" measured over time. This table stores one append-only SNAPSHOT
-- per family per day: a weighted composite (0-100), the per-dimension scores
-- that produced it, and the ranked practical suggestions the engine surfaced.
--
-- Persisting daily lets us (a) show a trend / "what changed since yesterday",
-- (b) feed "schedule stability" from real variance over time, and (c) power the
-- Command Center's evening "what changed" summary. The score is always RECOMPUTED
-- from live data; this table is the durable ledger of those computations, never
-- the source of truth for the underlying facts.
--
-- Family-scoped RLS. Additive + idempotent (safe to re-run).

create table if not exists public.family_operating_index (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  as_of_date    date not null default current_date,      -- the local day this snapshot represents
  composite     int  not null check (composite between 0 and 100),
  band          text not null default 'steady'
                  check (band in ('thriving','steady','stretched','overloaded')),
  -- Per-dimension scores (0-100) as {key: score}; keys are the engine's dimension ids.
  dimensions    jsonb not null default '{}'::jsonb,
  -- Ranked practical suggestions [{id,title,detail,href,dimension,impact}] captured at snapshot time.
  suggestions   jsonb not null default '[]'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- One row per family per day; the server upserts on this to stay idempotent.
  unique (family_id, as_of_date)
);
create index if not exists idx_family_operating_index_family
  on public.family_operating_index(family_id, as_of_date desc);

-- Keep updated_at honest on re-computation within the same day.
create or replace function public.touch_family_operating_index() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_family_operating_index_touch on public.family_operating_index;
drop trigger if exists trg_family_operating_index_touch on public.family_operating_index;
create trigger trg_family_operating_index_touch
  before update on public.family_operating_index
  for each row execute function public.touch_family_operating_index();

-- ── RLS: family-scoped ──────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_operating_index'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0126_family_playbook.sql ══════════
-- FamilyOS :: 0126 Family Playbook ("Family Intelligence Layer / Playbook")
-- ----------------------------------------------------------------------------
-- North-star pillar #3: every interaction improves understanding. Bubaly learns
-- durable preferences/traditions from real household usage (favorite meals,
-- grocery staples, family favorites, annual traditions) and proposes them as
-- SUGGESTIONS the family confirms — the confirmed ones become real
-- `family_facts` rows (the persistent Knowledge Base, migration 0123). This
-- table is the learning inbox: candidate facts with provenance + confidence +
-- an accept/dismiss lifecycle. The family stays in control (nothing is saved
-- until confirmed).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.family_playbook_suggestions (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,  -- who it's about (null = whole family)
  -- Mirrors the family_facts category set so an accepted suggestion maps 1:1.
  category    text not null default 'preference'
                check (category in ('about','preference','medical','contact','sizes','important','account','date','other')),
  label       text not null,               -- e.g. "Go-to dinner", "Grocery staple"
  value       text not null,               -- e.g. "Taco night", "Oat milk"
  evidence    text,                        -- why Bubaly inferred it ("Planned 5 times recently")
  confidence  int not null default 50 check (confidence between 0 and 100),
  signature   text not null,               -- stable dedupe key (source:slug:member)
  status      text not null default 'suggested' check (status in ('suggested','accepted','dismissed')),
  fact_id     uuid references public.family_facts(id) on delete set null,     -- the confirmed fact, once accepted
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (family_id, signature)
);
create index if not exists idx_playbook_family_status
  on public.family_playbook_suggestions(family_id, status, confidence desc);
create index if not exists idx_playbook_member
  on public.family_playbook_suggestions(family_id, member_id);

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists set_family_playbook_updated on public.family_playbook_suggestions;
drop trigger if exists set_family_playbook_updated on public.family_playbook_suggestions;
create trigger set_family_playbook_updated before update on public.family_playbook_suggestions
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_playbook_suggestions'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0127_agent_activity.sql ══════════
-- FamilyOS :: 0127 Agent activity (North Star pillar #6 — specialized agents)
-- ----------------------------------------------------------------------------
-- The family sees one assistant; behind it a roster of domain agents (Chief of
-- Staff, Scheduler, Meal Planner, Budget Coach, …). This table is the persistent
-- record of what each agent surfaces or does — an auditable "system of
-- execution" log the /dashboard/agents surface reads (live briefings are
-- computed; this is the durable history the family can act on / dismiss).
--
-- Family-scoped RLS. Additive + idempotent.

create table if not exists public.agent_activity (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,   -- who it's about (null = whole family)
  agent       text not null,                     -- AgentId, e.g. 'scheduler'
  kind        text not null default 'insight'
                check (kind in ('insight','recommendation','action','handoff')),
  title       text not null,
  detail      text,
  href        text,
  severity    text not null default 'info' check (severity in ('info','attention','action')),
  status      text not null default 'active' check (status in ('active','done','dismissed')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_agent_activity_family on public.agent_activity(family_id, status, created_at desc);
create index if not exists idx_agent_activity_agent  on public.agent_activity(family_id, agent, created_at desc);

-- updated_at trigger
drop trigger if exists set_agent_activity_updated on public.agent_activity;
drop trigger if exists set_agent_activity_updated on public.agent_activity;
create trigger set_agent_activity_updated before update on public.agent_activity
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['agent_activity'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0128_family_connections.sql ══════════
-- FamilyOS :: 0128 Family connections (North Star pillar #9 — Family API)
-- ----------------------------------------------------------------------------
-- The orchestration hub: a durable, family-scoped record of the external
-- services a family connects (calendars, email, banking, grocery, smart home).
-- This is the data model the OAuth/token flows populate as each provider is
-- enabled server-side; the /dashboard/connections surface reads + manages it.
-- Tokens themselves are NOT stored here (they belong in a secret store) — this
-- tracks the connection, account label, status, and last sync.
--
-- Family-scoped RLS. Additive + idempotent.

create table if not exists public.family_connections (
  id                  uuid primary key default gen_random_uuid(),
  family_id           uuid not null references public.families(id) on delete cascade,
  provider            text not null,                 -- e.g. 'google_calendar'
  category            text not null default 'other'
                        check (category in ('calendar','email','banking','grocery','smart_home','other')),
  status              text not null default 'connected'
                        check (status in ('connected','syncing','error','disconnected')),
  account_label       text,                          -- e.g. 'mom@gmail.com'
  external_account_id text,
  last_synced_at      timestamptz,
  error_message       text,
  metadata            jsonb not null default '{}'::jsonb,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- One live row per family+provider+account (re-connecting the same account is an upsert).
  unique (family_id, provider, external_account_id)
);
create index if not exists idx_family_connections_family on public.family_connections(family_id, status, category);

-- updated_at trigger
drop trigger if exists set_family_connections_updated on public.family_connections;
drop trigger if exists set_family_connections_updated on public.family_connections;
create trigger set_family_connections_updated before update on public.family_connections
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_connections'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0129_family_graph.sql ══════════
-- FamilyOS :: 0129 Family Knowledge Graph (the reasoning substrate)
-- ----------------------------------------------------------------------------
-- The moat: instead of isolated tables, model the household as a graph of typed
-- ENTITIES (people, activities, places, orgs, items, events, pets…) linked by
-- typed EDGES (child --plays--> activity --at--> place --coached_by--> person).
-- Once relationships are first-class, the AI can *reason across* the household
-- (traverse, find dependencies, propagate impact: weather -> field -> game ->
-- travel -> dinner) rather than just retrieve rows. This is what makes autonomous
-- planning, the decision engine, and the Chief of Staff possible.
--
-- graph_entities  — typed nodes. `ref_table`/`ref_id` optionally link a node to
--                   an existing row (a family_member, calendar_event, place…) so
--                   the graph augments the app instead of duplicating it.
-- graph_edges     — directed, typed relationships between two entities, with an
--                   optional weight (edge strength) + metadata.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.graph_entities (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  kind        text not null default 'other'
                check (kind in ('person','activity','place','org','event','item','pet','topic','other')),
  name        text not null,
  ref_table   text,                          -- e.g. 'family_members', 'calendar_events' (nullable)
  ref_id      uuid,                          -- row it mirrors, if any
  attributes  jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_graph_entities_family on public.graph_entities(family_id, kind);
create index if not exists idx_graph_entities_ref on public.graph_entities(family_id, ref_table, ref_id);
-- One graph node per underlying row, so the twin projector can upsert idempotently
-- (a family_member/vehicle/team is mirrored exactly once). Plain (non-partial) so
-- PostgREST .upsert(onConflict) can target it; NULL ref rows (manual/seeded nodes)
-- are treated as distinct by Postgres, so they're unconstrained.
create unique index if not exists uq_graph_entities_ref
  on public.graph_entities(family_id, ref_table, ref_id);

create table if not exists public.graph_edges (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  source_id   uuid not null references public.graph_entities(id) on delete cascade,
  target_id   uuid not null references public.graph_entities(id) on delete cascade,
  relation    text not null,                 -- e.g. 'plays','at','coached_by','member_of','affects','needs','parent_of'
  weight      numeric not null default 1     check (weight >= 0 and weight <= 1),
  attributes  jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- one edge of a given relation between the same two nodes
  unique (family_id, source_id, target_id, relation),
  check (source_id <> target_id)
);
create index if not exists idx_graph_edges_family on public.graph_edges(family_id);
create index if not exists idx_graph_edges_source on public.graph_edges(family_id, source_id, relation);
create index if not exists idx_graph_edges_target on public.graph_edges(family_id, target_id, relation);

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists set_graph_entities_updated on public.graph_entities;
drop trigger if exists set_graph_entities_updated on public.graph_entities;
create trigger set_graph_entities_updated before update on public.graph_entities
  for each row execute function public.set_updated_at();
drop trigger if exists set_graph_edges_updated on public.graph_edges;
drop trigger if exists set_graph_edges_updated on public.graph_edges;
create trigger set_graph_edges_updated before update on public.graph_edges
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['graph_entities','graph_edges'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0130_family_decisions.sql ══════════
-- FamilyOS :: 0130 Family Decision Engine
-- ----------------------------------------------------------------------------
-- Persists family trade-off decisions so they can be revisited + learned from.
-- A decision ("Which vacation?") holds a set of options, each with the metrics
-- the pure engine scores (cost / time / travel / load / benefit) plus the
-- engine's computed score + rationale. The family picks the winner (decided_
-- option_id) — the AI recommends, the family decides.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.family_decisions (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  question           text not null,
  detail             text,
  status             text not null default 'open'
                       check (status in ('open','decided','archived')),
  budget_cents       bigint,              -- optional hard cap
  max_travel_minutes integer,             -- optional hard cap
  weights            jsonb not null default '{}'::jsonb,  -- per-criterion overrides
  decided_option_id  uuid,                -- set when status='decided' (FK added after options table)
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_family_decisions_family on public.family_decisions(family_id, status, updated_at desc);

create table if not exists public.decision_options (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  decision_id    uuid not null references public.family_decisions(id) on delete cascade,
  label          text not null,
  cost_cents     bigint,
  time_minutes   integer,
  travel_minutes integer,
  load_delta     integer,       -- 0..100 added family burden
  benefit        integer,       -- 0..100 upside
  score          numeric,       -- last engine score 0..100 (cached)
  rationale      text,          -- last engine rationale
  feasible       boolean not null default true,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_decision_options_decision on public.decision_options(family_id, decision_id);

-- decided_option_id references decision_options (added here to avoid a cycle at create time).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'family_decisions_decided_option_fk'
  ) then
    alter table public.family_decisions
      add constraint family_decisions_decided_option_fk
      foreign key (decided_option_id) references public.decision_options(id) on delete set null;
  end if;
end $$;

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists set_family_decisions_updated on public.family_decisions;
drop trigger if exists set_family_decisions_updated on public.family_decisions;
create trigger set_family_decisions_updated before update on public.family_decisions
  for each row execute function public.set_updated_at();
drop trigger if exists set_decision_options_updated on public.decision_options;
drop trigger if exists set_decision_options_updated on public.decision_options;
create trigger set_decision_options_updated before update on public.decision_options
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_decisions','decision_options'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0131_prep_plans.sql ══════════
-- FamilyOS :: 0131 Autonomous prep plans
-- ----------------------------------------------------------------------------
-- "Prepare, don't notify": a coordinated preparation plan for something on the
-- horizon (a trip, a birthday, an expiring document, school start), with ordered,
-- timed steps. The server generates plans from real upcoming signals (pure engine
-- in lib/planning/prep.ts) and upserts them here; the family checks steps off.
--
-- Idempotent per source signal via unique(family_id, signal_kind, signal_id).
-- Additive + family-scoped RLS via public.is_family_member.

create table if not exists public.prep_plans (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  signal_kind  text not null
                 check (signal_kind in ('trip','birthday','doc_expiry','school_start','event')),
  signal_id    text not null,          -- the source row this plan tracks
  title        text not null,
  target_date  date not null,
  urgency      text not null default 'later'
                 check (urgency in ('now','soon','later')),
  status       text not null default 'active'
                 check (status in ('active','done','dismissed')),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (family_id, signal_kind, signal_id)
);
create index if not exists idx_prep_plans_family on public.prep_plans(family_id, status, target_date);

create table if not exists public.prep_plan_steps (
  id         uuid primary key default gen_random_uuid(),
  family_id  uuid not null references public.families(id) on delete cascade,
  plan_id    uuid not null references public.prep_plans(id) on delete cascade,
  label      text not null,
  href       text,
  due_date   date,
  lead_days  integer not null default 0,
  is_done    boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (family_id, plan_id, label)
);
create index if not exists idx_prep_plan_steps_plan on public.prep_plan_steps(family_id, plan_id, sort_order);

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists set_prep_plans_updated on public.prep_plans;
drop trigger if exists set_prep_plans_updated on public.prep_plans;
create trigger set_prep_plans_updated before update on public.prep_plans
  for each row execute function public.set_updated_at();
drop trigger if exists set_prep_plan_steps_updated on public.prep_plan_steps;
drop trigger if exists set_prep_plan_steps_updated on public.prep_plan_steps;
create trigger set_prep_plan_steps_updated before update on public.prep_plan_steps
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['prep_plans','prep_plan_steps'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0132_network_consent.sql ══════════
-- FamilyOS :: 0132 Family Intelligence Network — consent (foundation only)
-- ----------------------------------------------------------------------------
-- The opt-in privacy foundation for anonymized, aggregate cross-family insights
-- ("families with kids this age often start passport renewals ~6 months ahead").
-- This migration ships ONLY the consent record — default OFF, explicit, granular,
-- and revocable. NO cross-family data is read or aggregated by anything yet; that
-- pipeline is intentionally deferred until the sharing model is signed off. A
-- family sees nothing and contributes nothing unless it turns this on.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.network_consent (
  family_id   uuid primary key references public.families(id) on delete cascade,
  enabled     boolean not null default false,     -- master opt-in (default OFF)
  scopes      jsonb not null default '{}'::jsonb, -- granular per-category opt-ins
  consented_by uuid references auth.users(id) on delete set null,
  consented_at timestamptz,                        -- when it was turned on
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- updated_at trigger
drop trigger if exists set_network_consent_updated on public.network_consent;
drop trigger if exists set_network_consent_updated on public.network_consent;
create trigger set_network_consent_updated before update on public.network_consent
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['network_consent'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0133_onboarding_events.sql ══════════
-- FamilyOS :: 0133 Onboarding telemetry (pre-family funnel)
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
drop policy if exists onboarding_events_insert on public.onboarding_events;
create policy onboarding_events_insert on public.onboarding_events
  for insert with check (user_id is null or user_id = auth.uid());

-- A user can read only their own rows. Admin analytics uses the service role.
drop policy if exists onboarding_events_select on public.onboarding_events;
drop policy if exists onboarding_events_select on public.onboarding_events;
create policy onboarding_events_select on public.onboarding_events
  for select using (user_id is not null and user_id = auth.uid());



-- ══════════ 0134_model_dirty.sql ══════════
-- FamilyOS :: 0134 Model staleness flag (event-driven twin refresh)
-- ----------------------------------------------------------------------------
-- Makes the Household Twin graph + Prep Plans refresh EVENT-DRIVEN, not just on a
-- schedule. When any cross-domain source row changes (members, pets, vehicles,
-- schools, teams, routines, places, accounts, trips, documents), a trigger stamps
-- the family's row in `family_model_dirty`. The model-refresh cron then prioritizes
-- dirty families and clears the flag after a successful refresh, so a change is
-- reflected on the next tick instead of waiting a full cycle.
--
-- Additive + idempotent. Family-scoped RLS (read-only to members; writes happen
-- via SECURITY DEFINER trigger, never directly from clients).

create table if not exists public.family_model_dirty (
  family_id   uuid primary key references public.families(id) on delete cascade,
  dirty       boolean not null default true,
  reason      text,                    -- last table that dirtied it
  marked_at   timestamptz not null default now(),
  refreshed_at timestamptz
);

alter table public.family_model_dirty enable row level security;
drop policy if exists family_model_dirty_select on public.family_model_dirty;
drop policy if exists family_model_dirty_select on public.family_model_dirty;
create policy family_model_dirty_select on public.family_model_dirty
  for select using (public.is_family_member(family_id));
-- No client insert/update/delete policies: only the trigger (definer) + service role write.

-- Trigger function: mark the changed row's family dirty. SECURITY DEFINER so it can
-- write regardless of the caller's RLS. Resolves family_id from the affected row.
create or replace function public.mark_model_dirty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_family uuid;
begin
  v_family := coalesce((case when tg_op = 'DELETE' then old.family_id else new.family_id end), null);
  if v_family is not null then
    insert into public.family_model_dirty (family_id, dirty, reason, marked_at)
    values (v_family, true, tg_table_name, now())
    on conflict (family_id) do update set dirty = true, reason = excluded.reason, marked_at = now();
  end if;
  return null; -- AFTER trigger, result ignored
end $$;

-- Attach the trigger to every cross-domain source table the twin projector reads.
do $$
declare
  t text;
  tables text[] := array[
    'family_members','pets','vehicles','school_classes','teams',
    'family_routines','family_places','financial_accounts','vacations','documents'
  ];
begin
  foreach t in array tables loop
    -- Skip gracefully if a table doesn't exist in this environment.
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists trg_mark_model_dirty on public.%I', t);
      execute format(
        'create trigger trg_mark_model_dirty after insert or update or delete on public.%I '
        'for each row execute function public.mark_model_dirty()', t);
    end if;
  end loop;
end $$;



-- ══════════ 0135_network_aggregates.sql ══════════
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
drop trigger if exists set_network_contributions_updated on public.network_contributions;
create trigger set_network_contributions_updated before update on public.network_contributions
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.network_contributions enable row level security;
-- A family may see/delete only its own contribution row (transparency + right to be
-- forgotten). Writes happen via the service-role cron only (no client write policy).
drop policy if exists network_contributions_select on public.network_contributions;
drop policy if exists network_contributions_select on public.network_contributions;
create policy network_contributions_select on public.network_contributions
  for select using (public.is_family_member(family_id));
drop policy if exists network_contributions_delete on public.network_contributions;
drop policy if exists network_contributions_delete on public.network_contributions;
create policy network_contributions_delete on public.network_contributions
  for delete using (public.is_family_member(family_id));

alter table public.network_aggregates enable row level security;
-- Published aggregates are readable by any family that has opted into the Network
-- and the matching scope. (They're already >= K + noised, so this is safe.)
drop policy if exists network_aggregates_select on public.network_aggregates;
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



-- ══════════ 0136_accept_invite_idempotent.sql ══════════
-- FamilyOS :: 0136 accept_invite made idempotent
-- ----------------------------------------------------------------------------
-- Found in a real browser smoke test of the invite journey: accepting an invite
-- twice — a double-click, React strict-mode double-effect, or simply revisiting
-- the emailed /join link after already joining — raised "Invite is invalid or
-- expired" even though the member WAS in the family, so the UI showed a scary
-- error on a successful join. Re-accepting your own already-accepted invite now
-- returns the family id (success). All other guards are unchanged: unknown/
-- expired tokens still fail, and an invite accepted by a DIFFERENT user still
-- fails with the original message.

create or replace function public.accept_invite(p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_invite public.invites;
  v_name   text;
begin
  select * into v_invite from public.invites
  where token = p_token
  for update;

  if not found then
    raise exception 'Invite is invalid or expired';
  end if;

  -- Idempotent success: this user already accepted this invite.
  if v_invite.status = 'accepted' and v_invite.accepted_by = auth.uid() then
    return v_invite.family_id;
  end if;

  if v_invite.status <> 'pending' or v_invite.expires_at <= now() then
    raise exception 'Invite is invalid or expired';
  end if;

  if lower(v_invite.email) <> lower(coalesce(auth.jwt()->>'email','')) then
    raise exception 'This invite was issued to a different email';
  end if;

  select coalesce(full_name, display_name, email) into v_name
  from public.profiles where id = auth.uid();

  insert into public.family_members (family_id, user_id, role, display_name)
  values (v_invite.family_id, auth.uid(), v_invite.role, coalesce(v_name,'Member'))
  on conflict (family_id, user_id) do update set is_active = true;

  update public.invites
    set status = 'accepted', accepted_by = auth.uid(), updated_at = now()
  where id = v_invite.id;

  update public.user_preferences
    set active_family_id = v_invite.family_id
  where user_id = auth.uid() and active_family_id is null;

  return v_invite.family_id;
end; $$;



-- ══════════ 0137_ai_call_guardian.sql ══════════
-- 0091_ai_call_guardian.sql
-- AI Call Guardian™ — intelligent communication protection and routing.
-- Covers: Family Trust Graph, routing profiles per member, rules engine,
-- full communications log, AI screening sessions, adaptive suggestions,
-- and emergency escalation tracking.
-- All tables are family-scoped with RLS via is_family_member().

-- ─────────────────────────────────────────────────
-- TRUST LEVELS ENUM
-- ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.guardian_trust_level AS ENUM (
    'immediate_family',   -- ★★★★★ ring immediately
    'close_family',       -- ★★★★  ring immediately
    'trusted_friend',     -- ★★★   ring immediately
    'known_contact',      -- ★★    AI screens first
    'unknown',            -- ★     AI handles, notifies
    'suspected_spam',     -- ⚠     AI deflects
    'blocked'             -- ❌    hang up / delete
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────
-- ROUTING MODE ENUM
-- ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.guardian_routing_mode AS ENUM (
    'immediate_ring',       -- ring family member now
    'immediate_ai_summary', -- ring + live AI transcript
    'ai_handle_first',      -- AI screens, escalates if urgent
    'voicemail_first',      -- voicemail, AI transcribes
    'silent_handling',      -- AI handles entirely, summary later
    'blocked'               -- hang up / block
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────
-- COMMUNICATION TYPE ENUM
-- ─────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE public.guardian_comm_type AS ENUM (
    'call_inbound',
    'call_outbound',
    'sms_inbound',
    'sms_outbound',
    'whatsapp_inbound',
    'whatsapp_outbound',
    'email_inbound'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────────
-- GUARDIAN CONTACTS (Family Trust Graph™)
-- One row per unique phone/email the family has seen or added.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_contacts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  -- Contact identity
  name                text,
  phone               text,                         -- E.164 format e.g. +15551234567
  email               text,
  notes               text,
  avatar_url          text,
  -- Trust
  trust_level         public.guardian_trust_level NOT NULL DEFAULT 'unknown',
  trust_override      boolean NOT NULL DEFAULT false, -- true = parent set manually; false = AI inferred
  -- Linked family member this contact is associated with (optional)
  member_id           uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  -- Scam intelligence
  spam_score          integer NOT NULL DEFAULT 0 CHECK (spam_score >= 0 AND spam_score <= 100),
  is_verified         boolean NOT NULL DEFAULT false,
  verified_at         timestamptz,
  -- Stats
  total_calls         integer NOT NULL DEFAULT 0,
  total_sms           integer NOT NULL DEFAULT 0,
  last_contact_at     timestamptz,
  -- Meta
  created_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_contacts" ON public.guardian_contacts;
drop policy if exists "Family member can view guardian_contacts" on public.guardian_contacts;
CREATE POLICY "Family member can view guardian_contacts" ON public.guardian_contacts
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Family member can manage guardian_contacts" ON public.guardian_contacts;
drop policy if exists "Family member can manage guardian_contacts" on public.guardian_contacts;
CREATE POLICY "Family member can manage guardian_contacts" ON public.guardian_contacts
  FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id));

DROP TRIGGER IF EXISTS trg_guardian_contacts_updated_at ON public.guardian_contacts;
drop trigger if exists trg_guardian_contacts_updated_at on public.guardian_contacts;
CREATE TRIGGER trg_guardian_contacts_updated_at
  BEFORE UPDATE ON public.guardian_contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE INDEX IF NOT EXISTS guardian_contacts_family_phone ON public.guardian_contacts(family_id, phone);
CREATE INDEX IF NOT EXISTS guardian_contacts_family_email ON public.guardian_contacts(family_id, email);
CREATE UNIQUE INDEX IF NOT EXISTS guardian_contacts_family_phone_unique
  ON public.guardian_contacts(family_id, phone) WHERE phone IS NOT NULL;

-- ─────────────────────────────────────────────────
-- GUARDIAN MEMBER PROFILES
-- Per-family-member routing configuration.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_member_profiles (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id                   uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id                   uuid NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  -- The Bubaly phone number assigned to this member (Twilio number)
  guardian_phone              text,
  -- Default routing per trust level
  default_mode_immediate      public.guardian_routing_mode NOT NULL DEFAULT 'immediate_ring',
  default_mode_close          public.guardian_routing_mode NOT NULL DEFAULT 'immediate_ring',
  default_mode_trusted        public.guardian_routing_mode NOT NULL DEFAULT 'immediate_ring',
  default_mode_known          public.guardian_routing_mode NOT NULL DEFAULT 'ai_handle_first',
  default_mode_unknown        public.guardian_routing_mode NOT NULL DEFAULT 'ai_handle_first',
  default_mode_suspected_spam public.guardian_routing_mode NOT NULL DEFAULT 'silent_handling',
  default_mode_blocked        public.guardian_routing_mode NOT NULL DEFAULT 'blocked',
  -- Context-aware overrides (JSONB map of context → routing_mode)
  -- e.g. {"driving":"voicemail_first","meeting":"ai_handle_first","sleeping":"silent_handling"}
  context_overrides           jsonb NOT NULL DEFAULT '{}',
  -- AI persona name (defaults to "Bubaly")
  ai_persona_name             text NOT NULL DEFAULT 'Bubaly',
  -- AI screening greeting template
  ai_greeting_template        text,
  -- Emergency contacts — always ring through regardless of mode
  emergency_always_ring       boolean NOT NULL DEFAULT true,
  -- Voicemail greeting (TTS text)
  voicemail_greeting          text,
  -- Active context (updated by app when user changes state)
  current_context             text CHECK (current_context IN ('normal','driving','meeting','sleeping','vacation','do_not_disturb')) DEFAULT 'normal',
  is_active                   boolean NOT NULL DEFAULT true,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(family_id, member_id)
);

ALTER TABLE public.guardian_member_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_member_profiles" ON public.guardian_member_profiles;
drop policy if exists "Family member can view guardian_member_profiles" on public.guardian_member_profiles;
CREATE POLICY "Family member can view guardian_member_profiles" ON public.guardian_member_profiles
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Family member can manage guardian_member_profiles" ON public.guardian_member_profiles;
drop policy if exists "Family member can manage guardian_member_profiles" on public.guardian_member_profiles;
CREATE POLICY "Family member can manage guardian_member_profiles" ON public.guardian_member_profiles
  FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id));

DROP TRIGGER IF EXISTS trg_guardian_member_profiles_updated_at ON public.guardian_member_profiles;
drop trigger if exists trg_guardian_member_profiles_updated_at on public.guardian_member_profiles;
CREATE TRIGGER trg_guardian_member_profiles_updated_at
  BEFORE UPDATE ON public.guardian_member_profiles
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- GUARDIAN ROUTING RULES
-- Deterministic rules that sit beneath AI decisions.
-- Parents approve all changes; AI can only suggest.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_routing_rules (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id         uuid REFERENCES public.family_members(id) ON DELETE CASCADE, -- null = family-wide
  -- Rule metadata
  name              text NOT NULL,
  description       text,
  is_active         boolean NOT NULL DEFAULT true,
  priority          integer NOT NULL DEFAULT 100,   -- lower = higher priority
  -- Conditions (all must match — AND logic)
  condition_contact_id     uuid REFERENCES public.guardian_contacts(id) ON DELETE CASCADE,
  condition_trust_levels   text[],   -- array of trust_level values
  condition_time_start     time,     -- e.g. '22:00' (local family time)
  condition_time_end       time,     -- e.g. '07:00'
  condition_days_of_week   integer[], -- 0=Sun, 1=Mon...6=Sat
  condition_contexts       text[],   -- ['driving','meeting']
  condition_caller_pattern text,     -- regex on caller phone/name
  -- Action
  action_routing_mode      public.guardian_routing_mode NOT NULL DEFAULT 'ai_handle_first',
  action_notify_members    uuid[],   -- member IDs to notify
  -- Audit
  created_by        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ai_suggested      boolean NOT NULL DEFAULT false,
  approved_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_routing_rules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_routing_rules" ON public.guardian_routing_rules;
drop policy if exists "Family member can view guardian_routing_rules" on public.guardian_routing_rules;
CREATE POLICY "Family member can view guardian_routing_rules" ON public.guardian_routing_rules
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Family member can manage guardian_routing_rules" ON public.guardian_routing_rules;
drop policy if exists "Family member can manage guardian_routing_rules" on public.guardian_routing_rules;
CREATE POLICY "Family member can manage guardian_routing_rules" ON public.guardian_routing_rules
  FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id));

DROP TRIGGER IF EXISTS trg_guardian_routing_rules_updated_at ON public.guardian_routing_rules;
drop trigger if exists trg_guardian_routing_rules_updated_at on public.guardian_routing_rules;
CREATE TRIGGER trg_guardian_routing_rules_updated_at
  BEFORE UPDATE ON public.guardian_routing_rules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- GUARDIAN COMMUNICATIONS
-- Immutable log of every call/SMS/email handled.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_communications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id           uuid REFERENCES public.family_members(id) ON DELETE SET NULL,
  contact_id          uuid REFERENCES public.guardian_contacts(id) ON DELETE SET NULL,
  -- Communication details
  comm_type           public.guardian_comm_type NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('inbound','outbound')),
  from_number         text,
  to_number           text,
  from_name           text,
  -- Content
  body                text,        -- SMS/email body or call transcript
  summary             text,        -- AI-generated 1-2 sentence summary
  sentiment           text CHECK (sentiment IN ('positive','neutral','negative','urgent','suspicious')),
  -- Decision
  trust_level_at_time public.guardian_trust_level,
  routing_mode_used   public.guardian_routing_mode,
  routing_rule_id     uuid REFERENCES public.guardian_routing_rules(id) ON DELETE SET NULL,
  ai_decision_reason  text,        -- explainable AI: why this routing was chosen
  scam_detected       boolean NOT NULL DEFAULT false,
  scam_type           text,        -- 'robocall','warranty','irs','grandparent', etc.
  scam_confidence     integer CHECK (scam_confidence >= 0 AND scam_confidence <= 100),
  -- Call-specific
  call_duration_secs  integer,
  call_recording_url  text,        -- Twilio recording URL (if enabled)
  twilio_call_sid     text UNIQUE,
  twilio_sms_sid      text UNIQUE,
  -- Status
  status              text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','screening','handled','escalated','blocked','missed','failed')),
  -- Timestamps
  started_at          timestamptz NOT NULL DEFAULT now(),
  ended_at            timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_communications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_communications" ON public.guardian_communications;
drop policy if exists "Family member can view guardian_communications" on public.guardian_communications;
CREATE POLICY "Family member can view guardian_communications" ON public.guardian_communications
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Service can insert guardian_communications" ON public.guardian_communications;
drop policy if exists "Service can insert guardian_communications" on public.guardian_communications;
CREATE POLICY "Service can insert guardian_communications" ON public.guardian_communications
  FOR INSERT TO authenticated WITH CHECK (is_family_member(family_id));

CREATE INDEX IF NOT EXISTS guardian_communications_family_started ON public.guardian_communications(family_id, started_at DESC);
CREATE INDEX IF NOT EXISTS guardian_communications_member ON public.guardian_communications(member_id, started_at DESC);
CREATE INDEX IF NOT EXISTS guardian_communications_twilio_call ON public.guardian_communications(twilio_call_sid) WHERE twilio_call_sid IS NOT NULL;

-- ─────────────────────────────────────────────────
-- GUARDIAN SCREENING SESSIONS
-- Active AI-screening conversation state (persisted across Twilio gather callbacks).
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_screening_sessions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  communication_id  uuid REFERENCES public.guardian_communications(id) ON DELETE CASCADE,
  twilio_call_sid   text NOT NULL UNIQUE,
  -- Session state
  caller_number     text,
  caller_name_stated text,         -- what the caller said their name was
  turn              integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','escalated','resolved','timed_out')),
  -- Conversation history (array of {role, content} objects)
  messages          jsonb NOT NULL DEFAULT '[]',
  -- AI verdicts
  ai_intent         text,          -- 'appointment','sales','scam','emergency','personal', etc.
  ai_urgency        text CHECK (ai_urgency IN ('low','medium','high','emergency')),
  ai_risk           text CHECK (ai_risk IN ('safe','suspicious','likely_scam','definite_scam')),
  final_action      text CHECK (final_action IN ('transfer','voicemail','hang_up','notify')),
  resolution_summary text,
  -- Timestamps
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_screening_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_screening_sessions" ON public.guardian_screening_sessions;
drop policy if exists "Family member can view guardian_screening_sessions" on public.guardian_screening_sessions;
CREATE POLICY "Family member can view guardian_screening_sessions" ON public.guardian_screening_sessions
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP TRIGGER IF EXISTS trg_guardian_screening_sessions_updated_at ON public.guardian_screening_sessions;
drop trigger if exists trg_guardian_screening_sessions_updated_at on public.guardian_screening_sessions;
CREATE TRIGGER trg_guardian_screening_sessions_updated_at
  BEFORE UPDATE ON public.guardian_screening_sessions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─────────────────────────────────────────────────
-- GUARDIAN SUGGESTIONS
-- AI-proposed rule changes that require parent approval before taking effect.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_suggestions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id         uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  -- What the AI wants to change
  suggestion_type   text NOT NULL CHECK (suggestion_type IN ('new_rule','update_trust','update_routing','block_contact','flag_scam')),
  title             text NOT NULL,
  reasoning         text NOT NULL,  -- explainable AI: why this is suggested
  evidence          jsonb,          -- communication IDs, patterns that triggered suggestion
  -- Proposed values
  proposed_contact_id  uuid REFERENCES public.guardian_contacts(id) ON DELETE CASCADE,
  proposed_trust_level public.guardian_trust_level,
  proposed_rule_data   jsonb,       -- full rule object for new_rule type
  -- Review
  status            text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','dismissed','auto_dismissed')),
  reviewed_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at       timestamptz,
  review_note       text,
  -- Expiry (auto-dismiss old suggestions)
  expires_at        timestamptz NOT NULL DEFAULT now() + interval '30 days',
  created_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_suggestions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_suggestions" ON public.guardian_suggestions;
drop policy if exists "Family member can view guardian_suggestions" on public.guardian_suggestions;
CREATE POLICY "Family member can view guardian_suggestions" ON public.guardian_suggestions
  FOR SELECT TO authenticated USING (is_family_member(family_id));

DROP POLICY IF EXISTS "Family member can manage guardian_suggestions" ON public.guardian_suggestions;
drop policy if exists "Family member can manage guardian_suggestions" on public.guardian_suggestions;
CREATE POLICY "Family member can manage guardian_suggestions" ON public.guardian_suggestions
  FOR ALL TO authenticated USING (is_family_member(family_id)) WITH CHECK (is_family_member(family_id));

CREATE INDEX IF NOT EXISTS guardian_suggestions_family_status ON public.guardian_suggestions(family_id, status, created_at DESC);

-- ─────────────────────────────────────────────────
-- GUARDIAN ESCALATIONS
-- Emergency calls that required immediate family alerting.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_escalations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id           uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  communication_id    uuid REFERENCES public.guardian_communications(id) ON DELETE SET NULL,
  -- Escalation details
  escalation_type     text NOT NULL CHECK (escalation_type IN ('emergency_call','medical','police','fire','child_safety','urgent_personal')),
  severity            text NOT NULL CHECK (severity IN ('high','critical')) DEFAULT 'high',
  description         text NOT NULL,
  caller_number       text,
  -- Notification tracking
  notified_member_ids uuid[],
  push_sent           boolean NOT NULL DEFAULT false,
  sms_sent            boolean NOT NULL DEFAULT false,
  call_attempted      boolean NOT NULL DEFAULT false,
  -- Acknowledgement
  acknowledged_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  acknowledged_at     timestamptz,
  -- Timing
  escalated_at        timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_escalations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_escalations" ON public.guardian_escalations;
drop policy if exists "Family member can view guardian_escalations" on public.guardian_escalations;
CREATE POLICY "Family member can view guardian_escalations" ON public.guardian_escalations
  FOR SELECT TO authenticated USING (is_family_member(family_id));

CREATE INDEX IF NOT EXISTS guardian_escalations_family ON public.guardian_escalations(family_id, escalated_at DESC);

-- ─────────────────────────────────────────────────
-- GUARDIAN AUDIT LOG
-- Immutable record of every Guardian action for trust and compliance.
-- ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.guardian_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id     uuid NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- 'ai' means the AI system did it; user_id links to who when a human did it
  actor         text NOT NULL CHECK (actor IN ('ai','parent','system')),
  action        text NOT NULL,   -- e.g. 'contact.trust_updated', 'rule.created', 'call.screened'
  entity_type   text,            -- table name
  entity_id     uuid,
  detail        jsonb,           -- before/after for updates
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.guardian_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Family member can view guardian_audit_log" ON public.guardian_audit_log;
drop policy if exists "Family member can view guardian_audit_log" on public.guardian_audit_log;
CREATE POLICY "Family member can view guardian_audit_log" ON public.guardian_audit_log
  FOR SELECT TO authenticated USING (is_family_member(family_id));

CREATE INDEX IF NOT EXISTS guardian_audit_log_family ON public.guardian_audit_log(family_id, created_at DESC);



-- ══════════ 0137_child_login_throttle.sql ══════════
-- FamilyOS :: 0137 — Child login throttle (brute-force protection)
--
-- A child signs in with a guessable username + a 4-digit PIN (only 10,000
-- combinations). Without a durable, cross-instance limiter, a serverless
-- deployment can't stop an attacker brute-forcing a specific child's PIN. This
-- table persists per-username failure counts + lockouts so the sign-in server
-- action (which runs under the service role) can reject flooded attempts.
--
-- Keyed by the normalized (lowercase) username — the same value child_logins
-- stores — so a lock protects one child's account. Written ONLY by the
-- service-role sign-in / reset actions; there is no family-scoped access and no
-- public read (RLS on, no policies → deny-all to normal clients).

create table if not exists public.child_login_throttle (
  username     text        primary key,           -- normalized login handle
  fails        int         not null default 0,     -- failures in the current window
  window_start timestamptz not null default now(), -- when the window began
  locked_until timestamptz,                        -- locked out until this instant
  updated_at   timestamptz not null default now()
);

create index if not exists idx_child_login_throttle_locked
  on public.child_login_throttle (locked_until)
  where locked_until is not null;

drop trigger if exists trg_set_updated_at on public.child_login_throttle;
drop trigger if exists trg_set_updated_at on public.child_login_throttle;
create trigger trg_set_updated_at before update on public.child_login_throttle
  for each row execute function public.set_updated_at();

-- RLS on, no policies: only the service role (which bypasses RLS) may touch it.
-- Normal authenticated/anon clients get deny-all, which is exactly right — the
-- throttle is server-enforced, never client-visible.
alter table public.child_login_throttle enable row level security;



-- ══════════ 0138_onboarding_imports.sql ══════════
-- FamilyOS :: 0138 Onboarding calendar imports — the "value-first" first-run record
-- ----------------------------------------------------------------------------
-- T1 (TIME-TO-FIRST-VALUE): the value step imports the family's existing calendar
-- (paste .ics or a sample week), computes an instant "first brief" (today's
-- timeline · conflicts · action list · time-saved opportunities), and persists the
-- imported events into calendar_events at finalize. THIS table is the durable
-- record of that first-value moment: one row per import, with the computed brief
-- summary. It is the seed of the TTFV metric (T10) — "did the family reach a first
-- outcome, and how big was it" — and gives Support a trail when an import looks off.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.onboarding_imports (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  source             text not null default 'ics'
                       check (source in ('ics', 'paste', 'url', 'demo')),
  event_count        integer not null default 0 check (event_count >= 0),
  today_count        integer not null default 0 check (today_count >= 0),
  conflict_count     integer not null default 0 check (conflict_count >= 0),
  action_count       integer not null default 0 check (action_count >= 0),
  time_saved_minutes integer not null default 0 check (time_saved_minutes >= 0),
  brief              jsonb   not null default '{}'::jsonb,   -- the computed FirstBrief summary
  created_by         uuid,
  created_at         timestamptz not null default now()
);

create index if not exists idx_onboarding_imports_family on public.onboarding_imports(family_id, created_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.onboarding_imports enable row level security;

drop policy if exists onboarding_imports_select on public.onboarding_imports;
drop policy if exists onboarding_imports_select on public.onboarding_imports;
create policy onboarding_imports_select on public.onboarding_imports
  for select using (public.is_family_member(family_id));

drop policy if exists onboarding_imports_insert on public.onboarding_imports;
drop policy if exists onboarding_imports_insert on public.onboarding_imports;
create policy onboarding_imports_insert on public.onboarding_imports
  for insert with check (public.is_family_member(family_id));

drop policy if exists onboarding_imports_delete on public.onboarding_imports;
drop policy if exists onboarding_imports_delete on public.onboarding_imports;
create policy onboarding_imports_delete on public.onboarding_imports
  for delete using (public.is_family_member(family_id));



-- ══════════ 0139_meal_ideas.sql ══════════
-- FamilyOS :: 0139 Meal ideas — curated dinner catalog for the first-run briefing
-- ----------------------------------------------------------------------------
-- T2 (first-run instant briefing): a brand-new family has no recipes of its own,
-- so the "3 dinner ideas" in the onboarding brief can't come from the meal planner
-- (which reads the family's meals/recipes). This is a small, family-AGNOSTIC
-- reference catalog the briefing draws from — effort-tagged so we can suggest
-- quick meals on busy nights and more involved ones on the weekend.
--
-- Reference data, not family data: readable by anyone signed in; written only by
-- the seed / service role. Additive + idempotent.

create table if not exists public.meal_ideas (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  cuisine      text not null default 'Comfort',
  effort       text not null default 'standard' check (effort in ('quick', 'standard', 'involved')),
  prep_minutes integer not null default 30 check (prep_minutes >= 0),
  tags         text[] not null default '{}',
  description  text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create index if not exists idx_meal_ideas_active on public.meal_ideas(is_active, effort);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Non-sensitive catalog: any authenticated session may read it. No client writes
-- (the seed / service role populates it).
alter table public.meal_ideas enable row level security;

drop policy if exists meal_ideas_select on public.meal_ideas;
drop policy if exists meal_ideas_select on public.meal_ideas;
create policy meal_ideas_select on public.meal_ideas
  for select using (true);



-- ══════════ 0140_home_briefs.sql ══════════
-- FamilyOS :: 0140 Home briefs — "outcome, never empty" daily home snapshot
-- ----------------------------------------------------------------------------
-- T3 (TIME-TO-FIRST-VALUE): a brand-new or quiet family should land on an OUTCOME,
-- not empty widgets. The AI home now computes a first-run outcome brief — how ready
-- the week is, the next best getting-started steps, and 3 dinner ideas — and this
-- table is the durable daily snapshot of it (one row per family per day). It makes
-- the home render instantly from the last snapshot, gives a readiness trend, and is
-- the home-side signal for the TTFV metric (T10): did the family reach an outcome.
--
-- Mirrors the family_operating_index daily-snapshot pattern (0125). Additive +
-- idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.home_briefs (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  as_of_date         date not null default current_date,
  is_sparse          boolean not null default false,
  readiness_pct      integer not null default 0 check (readiness_pct between 0 and 100),
  week_count         integer not null default 0 check (week_count >= 0),
  conflict_count     integer not null default 0 check (conflict_count >= 0),
  dinner_count       integer not null default 0 check (dinner_count >= 0),
  time_saved_minutes integer not null default 0 check (time_saved_minutes >= 0),
  headline           text,
  brief              jsonb not null default '{}'::jsonb,   -- the computed HomeBrief summary
  created_by         uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (family_id, as_of_date)
);

create index if not exists idx_home_briefs_family on public.home_briefs(family_id, as_of_date desc);

drop trigger if exists set_home_briefs_updated on public.home_briefs;
drop trigger if exists set_home_briefs_updated on public.home_briefs;
create trigger set_home_briefs_updated before update on public.home_briefs
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.home_briefs enable row level security;

drop policy if exists home_briefs_select on public.home_briefs;
drop policy if exists home_briefs_select on public.home_briefs;
create policy home_briefs_select on public.home_briefs
  for select using (public.is_family_member(family_id));

drop policy if exists home_briefs_insert on public.home_briefs;
drop policy if exists home_briefs_insert on public.home_briefs;
create policy home_briefs_insert on public.home_briefs
  for insert with check (public.is_family_member(family_id));

drop policy if exists home_briefs_update on public.home_briefs;
drop policy if exists home_briefs_update on public.home_briefs;
create policy home_briefs_update on public.home_briefs
  for update using (public.is_family_member(family_id));



-- ══════════ 0141_daily_insights.sql ══════════
-- FamilyOS :: 0141 Daily insights — the one proactive "insight of the day" (T4)
-- ----------------------------------------------------------------------------
-- T4 (TIME-TO-FIRST-VALUE): instead of many small reminders, the home surfaces ONE
-- ranked, proactive insight above the fold ("leave 20 min earlier", "2 assignments
-- due tomorrow aren't acknowledged", "these groceries together save money"). Every
-- render recomputes candidate insights from the family's live data and upserts them
-- here (one row per family per day per kind); the home shows the highest-impact
-- ACTIVE one. Dismissing marks that row dismissed so the NEXT-best insight surfaces
-- — and we keep a record of which insights drove action (engagement / TTFV signal).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.daily_insights (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  as_of_date  date not null default current_date,
  kind        text not null,
  title       text not null,
  detail      text,
  href        text,
  impact      integer not null default 0 check (impact >= 0),
  status      text not null default 'active' check (status in ('active', 'dismissed', 'acted')),
  member_id   uuid references public.family_members(id) on delete set null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (family_id, as_of_date, kind)
);

create index if not exists idx_daily_insights_family_day on public.daily_insights(family_id, as_of_date, status);

drop trigger if exists set_daily_insights_updated on public.daily_insights;
drop trigger if exists set_daily_insights_updated on public.daily_insights;
create trigger set_daily_insights_updated before update on public.daily_insights
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.daily_insights enable row level security;

drop policy if exists daily_insights_select on public.daily_insights;
drop policy if exists daily_insights_select on public.daily_insights;
create policy daily_insights_select on public.daily_insights
  for select using (public.is_family_member(family_id));

drop policy if exists daily_insights_insert on public.daily_insights;
drop policy if exists daily_insights_insert on public.daily_insights;
create policy daily_insights_insert on public.daily_insights
  for insert with check (public.is_family_member(family_id));

drop policy if exists daily_insights_update on public.daily_insights;
drop policy if exists daily_insights_update on public.daily_insights;
create policy daily_insights_update on public.daily_insights
  for update using (public.is_family_member(family_id));



-- ══════════ 0142_family_signals.sql ══════════
-- FamilyOS :: 0142 Family signals — the "hard signal" family-intelligence store (R10)
-- ----------------------------------------------------------------------------
-- R10 (MOATS / Family Intelligence): the harder-to-copy behavioral signals the
-- strategy calls out — which reminders keep getting ignored, when the family is
-- most stressed, which chores create friction, which routines don't stick. The
-- detection engines (lib/intelligence/hard-signals.ts) recompute these from the
-- family's real data; this table is the durable, TRANSPARENT + EDITABLE record:
-- each signal carries its evidence and is acknowledged / dismissed by the family
-- (so a dismissed pattern doesn't nag), and the reasoning layer + Playbook can read
-- it. One row per (family, kind, subject) — recompute upserts in place.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.family_signals (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  kind          text not null
                  check (kind in ('ignored_reminder', 'stress_window', 'chore_conflict', 'routine_adherence')),
  subject_key   text not null,
  title         text not null,
  detail        text,
  score         integer not null default 0 check (score between 0 and 100),
  evidence      jsonb not null default '{}'::jsonb,
  status        text not null default 'active'
                  check (status in ('active', 'acknowledged', 'dismissed')),
  member_id     uuid references public.family_members(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (family_id, kind, subject_key)
);

create index if not exists idx_family_signals_family on public.family_signals(family_id, status, score desc);

drop trigger if exists set_family_signals_updated on public.family_signals;
drop trigger if exists set_family_signals_updated on public.family_signals;
create trigger set_family_signals_updated before update on public.family_signals
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.family_signals enable row level security;

drop policy if exists family_signals_select on public.family_signals;
drop policy if exists family_signals_select on public.family_signals;
create policy family_signals_select on public.family_signals
  for select using (public.is_family_member(family_id));

drop policy if exists family_signals_insert on public.family_signals;
drop policy if exists family_signals_insert on public.family_signals;
create policy family_signals_insert on public.family_signals
  for insert with check (public.is_family_member(family_id));

drop policy if exists family_signals_update on public.family_signals;
drop policy if exists family_signals_update on public.family_signals;
create policy family_signals_update on public.family_signals
  for update using (public.is_family_member(family_id));

drop policy if exists family_signals_delete on public.family_signals;
drop policy if exists family_signals_delete on public.family_signals;
create policy family_signals_delete on public.family_signals
  for delete using (public.is_family_member(family_id));



-- ══════════ 0142_poll_facilitation.sql ══════════
-- FamilyOS :: 0142 AI-facilitated group decisions (T6)
-- ----------------------------------------------------------------------------
-- Turns Group Voting (family_polls) into AI-facilitated consensus: a poll can
-- now carry a decision CATEGORY (meal / vacation / shopping / activity), an
-- optional BUDGET cap, and REQUIRED tags (e.g. dietary needs every option must
-- satisfy). Each option gains objective metrics — cost and travel — plus free
-- tags (e.g. 'vegetarian', 'gluten-free'). The pure consensus engine
-- (lib/voting/consensus.ts) blends the democratic signal (votes) with the
-- decision engine's objective fit (cost/travel + hard budget/dietary
-- constraints) and surfaces a recommendation + vote-vs-fit conflicts.
--
-- Additive + idempotent. No new tables → the existing family-scoped RLS on
-- family_polls / family_poll_options (migration 0078, FOR ALL is_family_member)
-- already governs every new column. Validated on PG16.

-- ── family_polls: category + budget + required tags ─────────────────────────
alter table public.family_polls
  add column if not exists decision_category text not null default 'general';
alter table public.family_polls
  add column if not exists budget_cents bigint;
alter table public.family_polls
  add column if not exists required_tags text[] not null default '{}';

-- Constrain the category to the supported set (idempotent: drop + re-add).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'family_polls_decision_category_check'
  ) then
    alter table public.family_polls
      add constraint family_polls_decision_category_check
      check (decision_category in ('general','meal','vacation','shopping','activity'));
  end if;
end $$;

-- ── family_poll_options: objective metrics + tags ───────────────────────────
alter table public.family_poll_options
  add column if not exists cost_cents bigint;
alter table public.family_poll_options
  add column if not exists travel_minutes integer;
alter table public.family_poll_options
  add column if not exists tags text[] not null default '{}';



-- ══════════ 0143_ai_feedback.sql ══════════
-- FamilyOS :: 0143 AI feedback — the "Why this?" learning loop (T7)
-- ----------------------------------------------------------------------------
-- The "Why this?" affordance shows a recommendation's reason + inputs and lets
-- the family respond: Helpful / Not helpful, dismiss, undo, or adjust. Those
-- responses are captured here as an append-only, family-scoped signal log so
-- the AI surfaces can learn what lands (and a future model-refresh can weigh it).
--
-- One table, append-only (no updates → no updated_at). Family-scoped RLS via
-- public.is_family_member. Additive + idempotent. Validated on PG16.

create table if not exists public.ai_feedback (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,  -- who responded
  surface     text not null
                check (surface in ('insight','autopilot','agent','voting','decision','briefing')),
  ref_kind    text,           -- the recommendation's sub-type (e.g. 'groceries', 'conflict')
  ref_id      text,           -- stable id of the specific recommendation
  signal      text not null
                check (signal in ('helpful','not_helpful','dismissed','undo','adjusted')),
  reason      text,           -- snapshot of the rationale shown at feedback time
  note        text,           -- optional free-text (for 'adjusted')
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_ai_feedback_family on public.ai_feedback(family_id, created_at desc);
create index if not exists idx_ai_feedback_ref    on public.ai_feedback(family_id, surface, ref_id);

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
begin
  execute 'alter table public.ai_feedback enable row level security';
  execute 'drop policy if exists ai_feedback_select on public.ai_feedback';
  execute 'create policy ai_feedback_select on public.ai_feedback for select using (public.is_family_member(family_id))';
  execute 'drop policy if exists ai_feedback_insert on public.ai_feedback';
  execute 'create policy ai_feedback_insert on public.ai_feedback for insert with check (public.is_family_member(family_id))';
  execute 'drop policy if exists ai_feedback_update on public.ai_feedback';
  execute 'create policy ai_feedback_update on public.ai_feedback for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))';
  execute 'drop policy if exists ai_feedback_delete on public.ai_feedback';
  execute 'create policy ai_feedback_delete on public.ai_feedback for delete using (public.is_family_member(family_id))';
end $$;



-- ══════════ 0144_experience_audits.sql ══════════
-- FamilyOS :: 0144 Experience Scorecard — measurable premium-consistency (T8)
-- ----------------------------------------------------------------------------
-- The premium-consistency sweep is only real if it's measured. This persists a
-- dated audit per surface (a module or a journey) across the six dimensions that
-- make an experience feel premium — empty state, error recovery, transitions,
-- performance, accessibility, consistency (each 0..100) — so the scorecard can
-- roll them up live and track the trend over time (dated rows → trend lines).
--
-- Family-scoped RLS via public.is_family_member; the scoring/rollup lives in the
-- pure lib/experience/scorecard.ts. Additive + idempotent. Validated on PG16.

create table if not exists public.experience_audits (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  surface_key    text not null,                    -- stable id, e.g. 'calendar'
  surface_label  text not null,                    -- display name, e.g. 'Calendar'
  category       text not null default 'module'
                   check (category in ('module','journey')),
  audited_on     date not null default current_date,
  empty_state    integer check (empty_state    between 0 and 100),
  error_recovery integer check (error_recovery between 0 and 100),
  transitions    integer check (transitions    between 0 and 100),
  performance    integer check (performance    between 0 and 100),
  accessibility  integer check (accessibility  between 0 and 100),
  consistency    integer check (consistency    between 0 and 100),
  score          integer check (score between 0 and 100),   -- cached composite
  grade          text    check (grade in ('A','B','C','D','F')),
  notes          text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (family_id, surface_key, audited_on)       -- one audit per surface per day
);
create index if not exists idx_experience_audits_family on public.experience_audits(family_id, audited_on desc);
create index if not exists idx_experience_audits_surface on public.experience_audits(family_id, surface_key, audited_on desc);

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists set_experience_audits_updated on public.experience_audits;
drop trigger if exists set_experience_audits_updated on public.experience_audits;
create trigger set_experience_audits_updated before update on public.experience_audits
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
begin
  execute 'alter table public.experience_audits enable row level security';
  execute 'drop policy if exists experience_audits_select on public.experience_audits';
  execute 'create policy experience_audits_select on public.experience_audits for select using (public.is_family_member(family_id))';
  execute 'drop policy if exists experience_audits_insert on public.experience_audits';
  execute 'create policy experience_audits_insert on public.experience_audits for insert with check (public.is_family_member(family_id))';
  execute 'drop policy if exists experience_audits_update on public.experience_audits';
  execute 'create policy experience_audits_update on public.experience_audits for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))';
  execute 'drop policy if exists experience_audits_delete on public.experience_audits';
  execute 'create policy experience_audits_delete on public.experience_audits for delete using (public.is_family_member(family_id))';
end $$;



-- ══════════ 0145_life_event_plans.sql ══════════
-- FamilyOS :: 0145 Life-event playbooks (T9)
-- ----------------------------------------------------------------------------
-- A one-tap "Start" on a life-event template (New Baby, Moving, School Start,
-- Vacation, New Pet, New Job) materializes a real, dated plan: a family_scoped
-- plan row + a checklist of items with due dates derived from the event date.
-- The family checks items off; progress rolls up live. The catalog + date math
-- live in the pure lib/life-events/templates.ts.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.
-- Validated on PG16.

create table if not exists public.life_event_plans (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  template_key text not null,                 -- e.g. 'new_baby'
  title        text not null,                 -- e.g. 'New Baby'
  event_date   date,                          -- the anchor date items hang off
  status       text not null default 'active'
                 check (status in ('active','completed','archived')),
  notes        text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_life_event_plans_family on public.life_event_plans(family_id, status, event_date);

create table if not exists public.life_event_plan_items (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  plan_id     uuid not null references public.life_event_plans(id) on delete cascade,
  title       text not null,
  category    text not null default 'plan',
  due_on      date,
  is_done     boolean not null default false,
  sort        integer not null default 0,
  note        text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_life_event_items_plan on public.life_event_plan_items(family_id, plan_id, sort);

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists set_life_event_plans_updated on public.life_event_plans;
drop trigger if exists set_life_event_plans_updated on public.life_event_plans;
create trigger set_life_event_plans_updated before update on public.life_event_plans
  for each row execute function public.set_updated_at();
drop trigger if exists set_life_event_items_updated on public.life_event_plan_items;
drop trigger if exists set_life_event_items_updated on public.life_event_plan_items;
create trigger set_life_event_items_updated before update on public.life_event_plan_items
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['life_event_plans','life_event_plan_items'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;



-- ══════════ 0146_activation_events.sql ══════════
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
drop policy if exists activation_events_insert on public.activation_events;
create policy activation_events_insert on public.activation_events
  for insert with check (user_id is null or user_id = auth.uid());

-- A user can read only their own rows; admin analytics uses the service role.
drop policy if exists activation_events_select on public.activation_events;
drop policy if exists activation_events_select on public.activation_events;
create policy activation_events_select on public.activation_events
  for select using (user_id is not null and user_id = auth.uid());



-- ══════════ 0147_twin_simulations.sql ══════════
-- FamilyOS :: 0147 Twin simulations — saved "what-if" activity projections (R8)
-- ----------------------------------------------------------------------------
-- R8 (Digital Twin depth): the full "if Emma joins travel soccer, what has to
-- move?" projection reasons across schedule · travel · cost · family time ·
-- homework · meals · vacation. The projection itself is a pure, no-write what-if;
-- this table is where a family SAVES a scenario they want to keep or compare
-- (verdict + weekly-hours + the per-dimension breakdown), so the decision — and
-- its reasoning — is remembered. Additive + idempotent. Family-scoped RLS.

create table if not exists public.twin_simulations (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  member_id    uuid references public.family_members(id) on delete set null,
  activity_name text not null,
  verdict      text not null default 'clear' check (verdict in ('clear', 'tight', 'conflict')),
  weekly_hours numeric(5,1) not null default 0,
  input        jsonb not null default '{}'::jsonb,   -- the ActivityDecision
  dimensions   jsonb not null default '[]'::jsonb,   -- the per-dimension projection
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists idx_twin_simulations_family on public.twin_simulations(family_id, created_at desc);

drop trigger if exists set_twin_simulations_updated on public.twin_simulations;
drop trigger if exists set_twin_simulations_updated on public.twin_simulations;
create trigger set_twin_simulations_updated before update on public.twin_simulations
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.twin_simulations enable row level security;

drop policy if exists twin_simulations_select on public.twin_simulations;
drop policy if exists twin_simulations_select on public.twin_simulations;
create policy twin_simulations_select on public.twin_simulations
  for select using (public.is_family_member(family_id));

drop policy if exists twin_simulations_insert on public.twin_simulations;
drop policy if exists twin_simulations_insert on public.twin_simulations;
create policy twin_simulations_insert on public.twin_simulations
  for insert with check (public.is_family_member(family_id));

drop policy if exists twin_simulations_delete on public.twin_simulations;
drop policy if exists twin_simulations_delete on public.twin_simulations;
create policy twin_simulations_delete on public.twin_simulations
  for delete using (public.is_family_member(family_id));



-- ══════════ 0148_moment_activations.sql ══════════
-- FamilyOS :: 0148 Moment activations — the Moments organizing-layer log (R12)
-- ----------------------------------------------------------------------------
-- R12 (Moments as an organizing layer): the home/moments surface leads with the
-- life moment the family is in right now (Morning · School · Dinner · Weekend) or
-- one that's coming (Vacation · Birthday · Holiday), each orchestrating the right
-- capabilities. This table logs which moments were surfaced and how the family
-- engaged (engaged / dismissed) — so a dismissed moment stays quiet for the day,
-- and moment-engagement becomes a signal the reasoning layer can learn from
-- ("this family lives in the Dinner moment"). One row per (family, moment, day).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.moment_activations (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  moment_key  text not null,
  as_of_date  date not null default current_date,
  status      text not null default 'active' check (status in ('active', 'engaged', 'dismissed')),
  reason      text,
  priority    integer not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (family_id, moment_key, as_of_date)
);

create index if not exists idx_moment_activations_family on public.moment_activations(family_id, as_of_date, status);

drop trigger if exists set_moment_activations_updated on public.moment_activations;
drop trigger if exists set_moment_activations_updated on public.moment_activations;
create trigger set_moment_activations_updated before update on public.moment_activations
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.moment_activations enable row level security;

drop policy if exists moment_activations_select on public.moment_activations;
drop policy if exists moment_activations_select on public.moment_activations;
create policy moment_activations_select on public.moment_activations
  for select using (public.is_family_member(family_id));

drop policy if exists moment_activations_insert on public.moment_activations;
drop policy if exists moment_activations_insert on public.moment_activations;
create policy moment_activations_insert on public.moment_activations
  for insert with check (public.is_family_member(family_id));

drop policy if exists moment_activations_update on public.moment_activations;
drop policy if exists moment_activations_update on public.moment_activations;
create policy moment_activations_update on public.moment_activations
  for update using (public.is_family_member(family_id));



-- ══════════ 0149_reasoning_snapshots.sql ══════════
-- FamilyOS :: 0149 Reasoning snapshots — the unified Family Reasoning Engine log (R7)
-- ----------------------------------------------------------------------------
-- R7 (unify the reasoning engine): instead of ~8 engines each answering part of
-- "what's going on with this family", a single core (lib/reasoning/engine.ts)
-- answers the six questions every surface consumes — what matters most, what's
-- being forgotten, what to decide next, what Bubaly can just handle, who needs
-- help, and the next best move. It composes the FOI orchestrator, the graph
-- reasoning insights (R2), the hard signals (R10), and ranked next-actions.
--
-- This table persists one snapshot per (family, day): the all-clear flag, the
-- attention count, and a compact report summary — so /dashboard/reasoning can
-- show a day-over-day trend and the report becomes durable family memory.
-- One row per (family, day).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.reasoning_snapshots (
  id               uuid primary key default gen_random_uuid(),
  family_id        uuid not null references public.families(id) on delete cascade,
  as_of_date       date not null default current_date,
  all_clear        boolean not null default true,
  attention_count  integer not null default 0,
  report           jsonb not null default '{}'::jsonb,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (family_id, as_of_date)
);

create index if not exists idx_reasoning_snapshots_family on public.reasoning_snapshots(family_id, as_of_date desc);

drop trigger if exists set_reasoning_snapshots_updated on public.reasoning_snapshots;
drop trigger if exists set_reasoning_snapshots_updated on public.reasoning_snapshots;
create trigger set_reasoning_snapshots_updated before update on public.reasoning_snapshots
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.reasoning_snapshots enable row level security;

drop policy if exists reasoning_snapshots_select on public.reasoning_snapshots;
drop policy if exists reasoning_snapshots_select on public.reasoning_snapshots;
create policy reasoning_snapshots_select on public.reasoning_snapshots
  for select using (public.is_family_member(family_id));

drop policy if exists reasoning_snapshots_insert on public.reasoning_snapshots;
drop policy if exists reasoning_snapshots_insert on public.reasoning_snapshots;
create policy reasoning_snapshots_insert on public.reasoning_snapshots
  for insert with check (public.is_family_member(family_id));

drop policy if exists reasoning_snapshots_update on public.reasoning_snapshots;
drop policy if exists reasoning_snapshots_update on public.reasoning_snapshots;
create policy reasoning_snapshots_update on public.reasoning_snapshots
  for update using (public.is_family_member(family_id));



-- ══════════ 0150_marketplace_matches.sql ══════════
-- FamilyOS :: 0150 Marketplace matches — supply↔demand match intelligence
-- ----------------------------------------------------------------------------
-- The next level for the family marketplace (0120): connect open "wanted"
-- requests to the supply already on the board (sell / free / rent / borrow) so
-- the board becomes proactive — "Dad wants a drill; Mom listed one to borrow."
-- Matches are computed by the pure engine (lib/marketplace/matches.ts) and
-- persisted here so a family can dismiss a match (it stays quiet) and the strip
-- has a durable record. One row per (family, wanted, supply).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.marketplace_matches (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  wanted_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  supply_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  score        integer not null default 0,
  reason       text,
  status       text not null default 'active'
                 check (status in ('active', 'dismissed', 'actioned')),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (family_id, wanted_id, supply_id)
);
create index if not exists idx_marketplace_matches_family
  on public.marketplace_matches(family_id, status, score desc);

drop trigger if exists set_marketplace_matches_updated on public.marketplace_matches;
drop trigger if exists set_marketplace_matches_updated on public.marketplace_matches;
create trigger set_marketplace_matches_updated before update on public.marketplace_matches
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.marketplace_matches enable row level security;

drop policy if exists marketplace_matches_select on public.marketplace_matches;
drop policy if exists marketplace_matches_select on public.marketplace_matches;
create policy marketplace_matches_select on public.marketplace_matches
  for select using (public.is_family_member(family_id));

drop policy if exists marketplace_matches_insert on public.marketplace_matches;
drop policy if exists marketplace_matches_insert on public.marketplace_matches;
create policy marketplace_matches_insert on public.marketplace_matches
  for insert with check (public.is_family_member(family_id));

drop policy if exists marketplace_matches_update on public.marketplace_matches;
drop policy if exists marketplace_matches_update on public.marketplace_matches;
create policy marketplace_matches_update on public.marketplace_matches
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

drop policy if exists marketplace_matches_delete on public.marketplace_matches;
drop policy if exists marketplace_matches_delete on public.marketplace_matches;
create policy marketplace_matches_delete on public.marketplace_matches
  for delete using (public.is_family_member(family_id));



-- ══════════ 0151_marketplace_v2.sql ══════════
-- FamilyOS :: 0151 Marketplace V2 — the AI-first marketplace
-- ----------------------------------------------------------------------------
-- Upgrades the family marketplace (0120/0150) into the full AI-first design:
-- "Buy, sell, rent, borrow, lend & more — all in one trusted community."
--
--   • listings gain two kinds: swap · donate (check-constraint widened)
--   • marketplace_stores            — member storefronts ("Creators" / My Store)
--   • marketplace_follows           — follow a store
--   • marketplace_saves             — save/♥ a listing
--   • marketplace_collections(+items) — curated groups ("Popular Collections")
--   • marketplace_orders            — the transaction record (rent/buy/borrow/…)
--   • marketplace_reviews           — two-sided reviews (buyer ↔ seller)
--
-- Trust scores, AI picks, and the activity feed are COMPUTED from these tables
-- by pure engines (lib/marketplace/trust.ts, lib/marketplace/discover.ts) — no
-- denormalized score columns to drift.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

-- ── listings: widen kind to include swap + donate ───────────────────────────
alter table public.marketplace_listings
  drop constraint if exists marketplace_listings_kind_check;
alter table public.marketplace_listings
  add constraint marketplace_listings_kind_check
  check (kind in ('sell','rent','borrow','free','wanted','swap','donate'));

-- ── marketplace_stores ──────────────────────────────────────────────────────
create table if not exists public.marketplace_stores (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid not null references public.family_members(id) on delete cascade,
  name        text not null,
  tagline     text,
  description text,
  emoji       text,
  is_active   boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (family_id, member_id)
);
create index if not exists idx_marketplace_stores_family on public.marketplace_stores(family_id, is_active);

-- ── marketplace_follows ─────────────────────────────────────────────────────
create table if not exists public.marketplace_follows (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  store_id    uuid not null references public.marketplace_stores(id) on delete cascade,
  member_id   uuid not null references public.family_members(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (store_id, member_id)
);
create index if not exists idx_marketplace_follows_family on public.marketplace_follows(family_id);

-- ── marketplace_saves (♥) ───────────────────────────────────────────────────
create table if not exists public.marketplace_saves (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  listing_id  uuid not null references public.marketplace_listings(id) on delete cascade,
  member_id   uuid not null references public.family_members(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (listing_id, member_id)
);
create index if not exists idx_marketplace_saves_family on public.marketplace_saves(family_id, member_id);

-- ── marketplace_collections + items ─────────────────────────────────────────
create table if not exists public.marketplace_collections (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  name        text not null,
  description text,
  emoji       text,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_marketplace_collections_family on public.marketplace_collections(family_id);

create table if not exists public.marketplace_collection_items (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  collection_id uuid not null references public.marketplace_collections(id) on delete cascade,
  listing_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  created_at    timestamptz not null default now(),
  unique (collection_id, listing_id)
);
create index if not exists idx_marketplace_coll_items_family on public.marketplace_collection_items(family_id);

-- ── marketplace_orders — the transaction record ─────────────────────────────
create table if not exists public.marketplace_orders (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  listing_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  buyer_member  uuid references public.family_members(id) on delete set null,
  seller_member uuid references public.family_members(id) on delete set null,
  kind          text not null default 'buy'
                  check (kind in ('buy','rent','borrow','swap','donate','free')),
  status        text not null default 'requested'
                  check (status in ('requested','confirmed','active','returned','completed','cancelled')),
  amount_cents  bigint not null default 0,
  starts_on     date,
  ends_on       date,
  notes         text,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_marketplace_orders_family on public.marketplace_orders(family_id, status, created_at desc);
create index if not exists idx_marketplace_orders_buyer on public.marketplace_orders(family_id, buyer_member);

-- ── marketplace_reviews — two-sided ─────────────────────────────────────────
create table if not exists public.marketplace_reviews (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  order_id        uuid references public.marketplace_orders(id) on delete set null,
  listing_id      uuid references public.marketplace_listings(id) on delete set null,
  reviewer_member uuid references public.family_members(id) on delete set null,
  reviewee_member uuid references public.family_members(id) on delete set null,
  role            text not null default 'buyer' check (role in ('buyer','seller')),
  rating          integer not null default 5 check (rating between 1 and 5),
  comment         text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_marketplace_reviews_family on public.marketplace_reviews(family_id, created_at desc);
create index if not exists idx_marketplace_reviews_reviewee on public.marketplace_reviews(family_id, reviewee_member);
-- one review per side of an order
create unique index if not exists uq_marketplace_reviews_order_side
  on public.marketplace_reviews(order_id, reviewer_member) where order_id is not null;

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['marketplace_stores','marketplace_collections','marketplace_orders','marketplace_reviews'] loop
    execute format('drop trigger if exists set_%1$s_updated on public.%1$I', t);
    execute format('create trigger set_%1$s_updated before update on public.%1$I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'marketplace_stores','marketplace_follows','marketplace_saves',
    'marketplace_collections','marketplace_collection_items',
    'marketplace_orders','marketplace_reviews'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t);
  end loop;
end $$;



-- ══════════ 0152_marketplace_saved_searches.sql ══════════
-- FamilyOS :: 0152 Marketplace saved searches / alerts
-- ----------------------------------------------------------------------------
-- "Alert me when someone lists X." A member saves a standing search (keyword +
-- optional kind / category / price ceiling); the Alerts page matches it against
-- the live board and badges what's NEW since they last looked (last_seen_at).
-- Pull-based (no trigger/notification hook) — the match logic is the pure
-- lib/marketplace/saved-search.ts. Family-scoped RLS. Additive + idempotent.

create table if not exists public.marketplace_saved_searches (
  id              uuid primary key default gen_random_uuid(),
  family_id       uuid not null references public.families(id) on delete cascade,
  member_id       uuid not null references public.family_members(id) on delete cascade,
  label           text,                       -- optional friendly name
  query           text,                       -- keyword over title/description
  kind            text,                       -- optional: sell/rent/borrow/free/wanted/swap/donate (null = any)
  category        text,                       -- optional category (null = any)
  max_price_cents bigint,                      -- optional ceiling (priced kinds only)
  is_active       boolean not null default true,
  last_seen_at    timestamptz not null default now(),  -- "new since" cursor
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_marketplace_saved_searches_member
  on public.marketplace_saved_searches(family_id, member_id, created_at desc);

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists set_marketplace_saved_searches_updated on public.marketplace_saved_searches;
drop trigger if exists set_marketplace_saved_searches_updated on public.marketplace_saved_searches;
create trigger set_marketplace_saved_searches_updated before update on public.marketplace_saved_searches
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
begin
  execute 'alter table public.marketplace_saved_searches enable row level security';
  execute 'drop policy if exists marketplace_saved_searches_select on public.marketplace_saved_searches';
  execute 'create policy marketplace_saved_searches_select on public.marketplace_saved_searches for select using (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_saved_searches_insert on public.marketplace_saved_searches';
  execute 'create policy marketplace_saved_searches_insert on public.marketplace_saved_searches for insert with check (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_saved_searches_update on public.marketplace_saved_searches';
  execute 'create policy marketplace_saved_searches_update on public.marketplace_saved_searches for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_saved_searches_delete on public.marketplace_saved_searches';
  execute 'create policy marketplace_saved_searches_delete on public.marketplace_saved_searches for delete using (public.is_family_member(family_id))';
end $$;



-- ══════════ 0153_marketplace_questions.sql ══════════
-- FamilyOS :: 0153 Marketplace listing Q&A
-- ----------------------------------------------------------------------------
-- "Ask a question" on any listing — public within the family. The asker posts a
-- question; the listing owner answers. Shown inline on the listing and gathered
-- into the seller's Questions inbox. Family-scoped RLS. Additive + idempotent.

create table if not exists public.marketplace_questions (
  id            uuid primary key default gen_random_uuid(),
  family_id     uuid not null references public.families(id) on delete cascade,
  listing_id    uuid not null references public.marketplace_listings(id) on delete cascade,
  asker_member  uuid references public.family_members(id) on delete set null,
  question      text not null,
  answer        text,
  answered_at   timestamptz,
  answered_by   uuid references public.family_members(id) on delete set null,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_marketplace_questions_listing on public.marketplace_questions(family_id, listing_id, created_at desc);
create index if not exists idx_marketplace_questions_family on public.marketplace_questions(family_id, created_at desc);

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists set_marketplace_questions_updated on public.marketplace_questions;
drop trigger if exists set_marketplace_questions_updated on public.marketplace_questions;
create trigger set_marketplace_questions_updated before update on public.marketplace_questions
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
begin
  execute 'alter table public.marketplace_questions enable row level security';
  execute 'drop policy if exists marketplace_questions_select on public.marketplace_questions';
  execute 'create policy marketplace_questions_select on public.marketplace_questions for select using (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_questions_insert on public.marketplace_questions';
  execute 'create policy marketplace_questions_insert on public.marketplace_questions for insert with check (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_questions_update on public.marketplace_questions';
  execute 'create policy marketplace_questions_update on public.marketplace_questions for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))';
  execute 'drop policy if exists marketplace_questions_delete on public.marketplace_questions';
  execute 'create policy marketplace_questions_delete on public.marketplace_questions for delete using (public.is_family_member(family_id))';
end $$;



-- ══════════ 0154_marketplace_ownership.sql ══════════
-- ============================================================================
-- 0154 · Marketplace object-level authorization (ownership) + safe hand-off.
--
-- Closes the audit's SEC-1/SEC-2/REL-1/REL-3/RACE-1 findings. Prior policies
-- gated marketplace tables by family membership ALONE, so any member could edit
-- another member's listing/store, accept offers they don't own, or forge
-- saves/offers/reviews with a spoofed member id (inflating trust scores). This
-- migration:
--   • adds public.marketplace_member_id(family) — the caller's member id;
--   • ties INSERTs to the acting member and UPDATE/DELETE to the row owner;
--   • moves the offer hand-off + listing status changes into SECURITY DEFINER
--     RPCs that verify ownership and run atomically;
--   • flips a listing to 'pending' via a trigger on offer insert (so the
--     interested member no longer needs UPDATE on someone else's listing);
--   • adds a partial unique index so a member can hold at most one OPEN offer
--     per listing (idempotent "I'm interested").
--
-- Additive + idempotent. Requires 0120 + 0151. Apply to prod (see
-- docs/PENDING_PROD_MIGRATIONS.md) — the app's marketplace mutations call the
-- new RPCs and rely on the tightened policies.
-- ============================================================================

-- ── Caller's member id within a family (null if not a member) ───────────────
create or replace function public.marketplace_member_id(p_family_id uuid)
returns uuid language sql security definer stable set search_path = public as $$
  select id from public.family_members
  where family_id = p_family_id and user_id = auth.uid() and is_active
  limit 1;
$$;

-- ── Collapse any pre-existing duplicate OPEN offers before the unique index ──
-- Keep the earliest per (listing, member); withdraw the rest. Null member ids
-- are treated as distinct (never collapsed).
update public.marketplace_offers o
   set status = 'withdrawn'
 where o.status = 'open'
   and o.member_id is not null
   and exists (
     select 1 from public.marketplace_offers o2
     where o2.listing_id = o.listing_id
       and o2.member_id = o.member_id
       and o2.status = 'open'
       and o2.id < o.id
   );

create unique index if not exists uq_marketplace_offers_open
  on public.marketplace_offers(listing_id, member_id)
  where status = 'open';

-- ── Flip an available listing to 'pending' when its first offer lands ────────
-- Runs as the table owner (definer), so the interested member needs no UPDATE
-- grant on the owner's listing.
create or replace function public.marketplace_offer_flip_pending()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.marketplace_listings
     set status = 'pending', updated_at = now()
   where id = new.listing_id and status = 'available';
  return new;
end $$;

drop trigger if exists trg_marketplace_offer_flip_pending on public.marketplace_offers;
drop trigger if exists trg_marketplace_offer_flip_pending on public.marketplace_offers;
create trigger trg_marketplace_offer_flip_pending
  after insert on public.marketplace_offers
  for each row execute function public.marketplace_offer_flip_pending();

-- ── Owner-checked, atomic offer accept → order + review path ─────────────────
create or replace function public.marketplace_accept_offer(p_offer uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_offer   public.marketplace_offers%rowtype;
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
  v_kind    text;
  v_order   uuid;
begin
  select * into v_offer from public.marketplace_offers where id = p_offer;
  if not found then raise exception 'Offer not found'; end if;
  select * into v_listing from public.marketplace_listings where id = v_offer.listing_id;
  if not found then raise exception 'Listing not found'; end if;

  v_caller := public.marketplace_member_id(v_listing.family_id);
  if v_caller is null or v_listing.member_id is distinct from v_caller then
    raise exception 'Only the listing owner can accept offers';
  end if;
  if v_offer.status <> 'open' then raise exception 'Offer is no longer open'; end if;

  update public.marketplace_listings
     set status = 'claimed', claimed_by = v_offer.member_id, claimed_at = now(), updated_at = now()
   where id = v_listing.id;

  update public.marketplace_offers set status = 'accepted', updated_at = now()
   where id = v_offer.id;
  update public.marketplace_offers set status = 'declined', updated_at = now()
   where listing_id = v_listing.id and status = 'open' and id <> v_offer.id;

  v_kind := case
    when v_listing.kind = 'sell' then 'buy'
    when v_listing.kind in ('rent','borrow','swap','donate','free') then v_listing.kind
    else 'buy'
  end;

  insert into public.marketplace_orders
    (family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, created_by)
  values
    (v_listing.family_id, v_listing.id, v_offer.member_id, v_listing.member_id, v_kind,
     'confirmed', coalesce(v_offer.amount_cents, v_listing.price_cents), auth.uid())
  returning id into v_order;

  return v_order;
end $$;

-- ── Owner-checked decline of a single offer ─────────────────────────────────
create or replace function public.marketplace_decline_offer(p_offer uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_offer   public.marketplace_offers%rowtype;
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
begin
  select * into v_offer from public.marketplace_offers where id = p_offer;
  if not found then raise exception 'Offer not found'; end if;
  select * into v_listing from public.marketplace_listings where id = v_offer.listing_id;
  if not found then raise exception 'Listing not found'; end if;

  v_caller := public.marketplace_member_id(v_listing.family_id);
  if v_caller is null or v_listing.member_id is distinct from v_caller then
    raise exception 'Only the listing owner can decline offers';
  end if;

  update public.marketplace_offers set status = 'declined', updated_at = now()
   where id = v_offer.id and status = 'open';
end $$;

-- ── Owner-checked listing status transition (legal transitions only) ─────────
create or replace function public.marketplace_set_listing_status(p_listing uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_listing public.marketplace_listings%rowtype;
  v_caller  uuid;
  v_ok      boolean;
begin
  select * into v_listing from public.marketplace_listings where id = p_listing;
  if not found then raise exception 'Listing not found'; end if;

  v_caller := public.marketplace_member_id(v_listing.family_id);
  if v_caller is null or v_listing.member_id is distinct from v_caller then
    raise exception 'Only the listing owner can change this listing';
  end if;

  v_ok := case
    when p_status = 'withdrawn'  then v_listing.status in ('available','pending','claimed')
    when p_status = 'completed'  then v_listing.status in ('claimed','pending')
    when p_status = 'available'  then v_listing.status in ('pending','withdrawn')
    when p_status = 'pending'    then v_listing.status = 'available'
    else false
  end;
  if not v_ok then
    raise exception 'Cannot move listing from % to %', v_listing.status, p_status;
  end if;

  update public.marketplace_listings set status = p_status, updated_at = now()
   where id = v_listing.id;
end $$;

grant execute on function public.marketplace_member_id(uuid) to authenticated;
grant execute on function public.marketplace_accept_offer(uuid) to authenticated;
grant execute on function public.marketplace_decline_offer(uuid) to authenticated;
grant execute on function public.marketplace_set_listing_status(uuid, text) to authenticated;

-- ── Tighten policies: bind writes to the acting member / row owner ───────────
do $$
begin
  -- Listings + stores: only the owning member may UPDATE/DELETE. Status changes
  -- and the offer hand-off go through the SECURITY DEFINER RPCs above, which
  -- bypass RLS after their own ownership checks.
  execute 'drop policy if exists marketplace_listings_update on public.marketplace_listings';
  execute 'create policy marketplace_listings_update on public.marketplace_listings for update '
       || 'using (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id)) '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';
  execute 'drop policy if exists marketplace_listings_delete on public.marketplace_listings';
  execute 'create policy marketplace_listings_delete on public.marketplace_listings for delete '
       || 'using (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';

  execute 'drop policy if exists marketplace_listings_insert on public.marketplace_listings';
  execute 'create policy marketplace_listings_insert on public.marketplace_listings for insert '
       || 'with check (public.is_family_member(family_id) and (member_id is null or member_id = public.marketplace_member_id(family_id)))';

  execute 'drop policy if exists marketplace_stores_update on public.marketplace_stores';
  execute 'create policy marketplace_stores_update on public.marketplace_stores for update '
       || 'using (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id)) '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';
  execute 'drop policy if exists marketplace_stores_delete on public.marketplace_stores';
  execute 'create policy marketplace_stores_delete on public.marketplace_stores for delete '
       || 'using (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';
  execute 'drop policy if exists marketplace_stores_insert on public.marketplace_stores';
  execute 'create policy marketplace_stores_insert on public.marketplace_stores for insert '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';

  -- Per-member rows: the member id on INSERT must be the caller's.
  execute 'drop policy if exists marketplace_saves_insert on public.marketplace_saves';
  execute 'create policy marketplace_saves_insert on public.marketplace_saves for insert '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';

  execute 'drop policy if exists marketplace_follows_insert on public.marketplace_follows';
  execute 'create policy marketplace_follows_insert on public.marketplace_follows for insert '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';

  execute 'drop policy if exists marketplace_offers_insert on public.marketplace_offers';
  execute 'create policy marketplace_offers_insert on public.marketplace_offers for insert '
       || 'with check (public.is_family_member(family_id) and member_id = public.marketplace_member_id(family_id))';

  -- Offers UPDATE: the offer owner (withdraw own) or the listing owner. RPCs run
  -- as definer, so this only bounds any direct client write.
  execute 'drop policy if exists marketplace_offers_update on public.marketplace_offers';
  execute 'create policy marketplace_offers_update on public.marketplace_offers for update '
       || 'using (public.is_family_member(family_id) and ('
       || '  member_id = public.marketplace_member_id(family_id) '
       || '  or exists (select 1 from public.marketplace_listings l where l.id = listing_id '
       || '             and l.member_id = public.marketplace_member_id(family_id)))) '
       || 'with check (public.is_family_member(family_id))';

  -- Reviews: the reviewer must be the caller.
  execute 'drop policy if exists marketplace_reviews_insert on public.marketplace_reviews';
  execute 'create policy marketplace_reviews_insert on public.marketplace_reviews for insert '
       || 'with check (public.is_family_member(family_id) and reviewer_member = public.marketplace_member_id(family_id))';

  -- Orders UPDATE: only the two parties may advance the lifecycle.
  execute 'drop policy if exists marketplace_orders_update on public.marketplace_orders';
  execute 'create policy marketplace_orders_update on public.marketplace_orders for update '
       || 'using (public.is_family_member(family_id) and ('
       || '  buyer_member = public.marketplace_member_id(family_id) '
       || '  or seller_member = public.marketplace_member_id(family_id))) '
       || 'with check (public.is_family_member(family_id))';
end $$;



-- ══════════ 0155_wallet_auth_holds.sql ══════════
-- ============================================================================
-- 0155 · Card authorization holds (audit PAY-1).
--
-- Real-time card authorization previously approved when amount <= the child's
-- SPEND balance but placed NO hold, so several authorizations landing before any
-- capture posted could each be approved against the same balance → overspend.
--
-- This adds an ATOMIC reserve: under a per-child row lock it re-checks the
-- spendable balance and, if sufficient, writes a `processing` debit ("hold")
-- keyed by the Stripe authorization id. childSpendableCents already counts
-- `processing` debits, so the hold immediately reduces what the next concurrent
-- authorization sees. Holds are released (status → 'cancelled') on capture or on
-- authorization reversal/expiry by the webhook. Immutable-ledger friendly: a hold
-- is a normal txn row whose status transitions processing → completed/cancelled.
--
-- Additive + idempotent. Requires 0088 (wallet) + 0090 (stripe money).
-- Service-role/webhook only; runs as definer so it can serialize on the bucket.
-- ============================================================================

create or replace function public.wallet_reserve_card_auth(
  p_family uuid,
  p_child_wallet uuid,
  p_amount bigint,
  p_auth_id text,
  p_description text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket    uuid;
  v_spendable bigint;
begin
  -- Nothing to reserve → approve (e.g. $0 auth / balance check).
  if p_amount is null or p_amount <= 0 then
    return true;
  end if;

  -- Lock the child's SPEND bucket so concurrent authorizations for the same
  -- child serialize here (each sees the prior hold before deciding).
  select id into v_bucket
    from public.wallet_buckets
   where family_id = p_family and child_wallet_id = p_child_wallet and kind = 'spend'
   for update;
  if v_bucket is null then
    return false;  -- no spend bucket → cannot fund → decline
  end if;

  -- Idempotency: a hold already exists for this authorization (ret, re-delivery).
  if exists (
    select 1 from public.wallet_transactions
     where stripe_ref = p_auth_id and type = 'card_spend' and status = 'processing'
  ) then
    return true;
  end if;

  -- Spendable = completed + processing (holds already reduce this).
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into v_spendable
    from public.wallet_transactions
   where family_id = p_family and bucket_id = v_bucket and status in ('completed', 'processing');

  if p_amount > v_spendable then
    return false;  -- insufficient funds
  end if;

  insert into public.wallet_transactions
    (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, stripe_ref, metadata)
  values
    (p_family, p_child_wallet, v_bucket, 'card_spend', 'processing', 'debit', p_amount,
     coalesce(nullif(p_description, ''), 'Card hold'), p_auth_id,
     jsonb_build_object('source', 'issuing', 'kind', 'hold'));

  return true;
end $$;

revoke all on function public.wallet_reserve_card_auth(uuid, uuid, bigint, text, text) from public;
grant execute on function public.wallet_reserve_card_auth(uuid, uuid, bigint, text, text) to service_role;



-- ══════════ 0156_rate_limits.sql ══════════
-- FamilyOS :: 0156 Durable rate limits (AI-2)
-- ----------------------------------------------------------------------------
-- The public, model-backed endpoints (e.g. /api/ai/gift) were rate-limited by an
-- in-memory fixed-window map — per serverless INSTANCE, so N cold instances = N×
-- the intended limit. This adds a shared Postgres-backed fixed-window counter so
-- the limit holds across instances.
--
--   • rate_limits          — one row per (bucket_key, window_start)
--   • rate_limit_hit(...)   — atomic increment; returns allowed + retry_after
--
-- Service-role only (RLS on, no policies). The RPC is SECURITY DEFINER so the
-- server can call it regardless. Additive + idempotent.

create table if not exists public.rate_limits (
  bucket_key   text not null,
  window_start timestamptz not null,
  count        integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (bucket_key, window_start)
);
create index if not exists idx_rate_limits_window on public.rate_limits(window_start);

alter table public.rate_limits enable row level security;
-- No policies: only the service role (which bypasses RLS) touches this table.

-- Atomic fixed-window hit. Buckets align to p_window_seconds boundaries so every
-- instance agrees on the current window. Returns whether this hit is allowed and,
-- if not, how many seconds until the window resets.
create or replace function public.rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
returns table(allowed boolean, retry_after integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_count integer;
begin
  insert into public.rate_limits (bucket_key, window_start, count)
  values (p_key, v_window_start, 1)
  on conflict (bucket_key, window_start)
  do update set count = public.rate_limits.count + 1, updated_at = now()
  returning count into v_count;

  if v_count > p_limit then
    return query select false,
      greatest(1, ceil(extract(epoch from (v_window_start + make_interval(secs => p_window_seconds)) - now())))::integer;
  else
    return query select true, 0;
  end if;
end;
$$;

grant execute on function public.rate_limit_hit(text, integer, integer) to anon, authenticated, service_role;

-- Opportunistic cleanup helper (a cron can call it; rows are tiny + self-expiring
-- by window, so this is just housekeeping).
create or replace function public.rate_limit_prune()
returns void language sql security definer set search_path = public as $$
  delete from public.rate_limits where window_start < now() - interval '1 day';
$$;



-- ══════════ 0157_family_signals_budget_drift.sql ══════════
-- FamilyOS :: 0157 Family signals — add the budget-drift kind (R10)
-- ----------------------------------------------------------------------------
-- Widens family_signals.kind (0142) to include 'budget_drift' — the 5th hard
-- signal: a budget category over its cap for the current period (a stronger,
-- dismissable pattern when the prior period was over too). Additive + idempotent:
-- just re-creates the CHECK constraint with the extra allowed value.

alter table public.family_signals
  drop constraint if exists family_signals_kind_check;
alter table public.family_signals
  add constraint family_signals_kind_check
  check (kind in ('ignored_reminder', 'stress_window', 'chore_conflict', 'routine_adherence', 'budget_drift'));



-- ══════════ 0158_concierge_plan_actions.sql ══════════
-- FamilyOS :: 0158 Concierge plan actions — deeper write-back audit
-- ----------------------------------------------------------------------------
-- When an accepted concierge plan is materialized into real records (a calendar
-- event, a reminder, a prep task…), each write-back is logged here — so the flow
-- is IDEMPOTENT (a plan never double-materializes the same kind) and the family
-- can see exactly what the concierge did on their behalf. One row per
-- (family, plan, action_kind).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.concierge_plan_actions (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  plan_id      uuid not null references public.concierge_plans(id) on delete cascade,
  action_kind  text not null check (action_kind in ('calendar', 'reminder', 'task')),
  target_table text not null,
  target_id    uuid,
  detail       text,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (family_id, plan_id, action_kind)
);
create index if not exists idx_concierge_plan_actions_plan on public.concierge_plan_actions(family_id, plan_id);

drop trigger if exists set_concierge_plan_actions_updated on public.concierge_plan_actions;
drop trigger if exists set_concierge_plan_actions_updated on public.concierge_plan_actions;
create trigger set_concierge_plan_actions_updated before update on public.concierge_plan_actions
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.concierge_plan_actions enable row level security;

drop policy if exists concierge_plan_actions_select on public.concierge_plan_actions;
drop policy if exists concierge_plan_actions_select on public.concierge_plan_actions;
create policy concierge_plan_actions_select on public.concierge_plan_actions
  for select using (public.is_family_member(family_id));

drop policy if exists concierge_plan_actions_insert on public.concierge_plan_actions;
drop policy if exists concierge_plan_actions_insert on public.concierge_plan_actions;
create policy concierge_plan_actions_insert on public.concierge_plan_actions
  for insert with check (public.is_family_member(family_id));

drop policy if exists concierge_plan_actions_update on public.concierge_plan_actions;
drop policy if exists concierge_plan_actions_update on public.concierge_plan_actions;
create policy concierge_plan_actions_update on public.concierge_plan_actions
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

drop policy if exists concierge_plan_actions_delete on public.concierge_plan_actions;
drop policy if exists concierge_plan_actions_delete on public.concierge_plan_actions;
create policy concierge_plan_actions_delete on public.concierge_plan_actions
  for delete using (public.is_family_member(family_id));



-- ══════════ 0159_onboarding_progress.sql ══════════
-- FamilyOS :: 0159 Onboarding progress — durable per-account lifecycle + marketing signal
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
drop trigger if exists set_onboarding_progress_updated_at on public.onboarding_progress;
create trigger set_onboarding_progress_updated_at
  before update on public.onboarding_progress
  for each row execute function public.set_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.onboarding_progress enable row level security;

-- A user manages only their own onboarding record. Marketing aggregation across
-- accounts is service-role only (mirrors onboarding_events / activation_events).
drop policy if exists onboarding_progress_select on public.onboarding_progress;
drop policy if exists onboarding_progress_select on public.onboarding_progress;
create policy onboarding_progress_select on public.onboarding_progress
  for select using (user_id = auth.uid());

drop policy if exists onboarding_progress_insert on public.onboarding_progress;
drop policy if exists onboarding_progress_insert on public.onboarding_progress;
create policy onboarding_progress_insert on public.onboarding_progress
  for insert with check (user_id = auth.uid());

drop policy if exists onboarding_progress_update on public.onboarding_progress;
drop policy if exists onboarding_progress_update on public.onboarding_progress;
create policy onboarding_progress_update on public.onboarding_progress
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());


-- ══════════ 0138_demo_sessions.sql ══════════
-- FamilyOS :: 0138 — Ephemeral "Try it free" demo sessions
--
-- Powers the pricing-page "Test Account → Login Now to Try Me" flow: one click
-- provisions a throwaway Family+ family (seeded with data), signs the visitor
-- straight in, and runs a 5-minute countdown. On logout / expiry / the cron, the
-- whole thing is deleted (auth user + family cascade), so it fully resets for the
-- next person. This table just tracks each live demo + when it expires.

create table if not exists public.demo_sessions (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  family_id   uuid        not null references public.families(id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  unique (user_id)
);

create index if not exists idx_demo_sessions_expires on public.demo_sessions (expires_at);

alter table public.demo_sessions enable row level security;

-- A demo visitor may read only their OWN session row (to drive the countdown).
-- All writes/cleanup run through the service-role client in server actions + cron.
drop policy if exists demo_sessions_select_own on public.demo_sessions;
create policy demo_sessions_select_own on public.demo_sessions
  for select to authenticated
  using (user_id = auth.uid());


-- ══════════ 0160_visitor_consent.sql ══════════
-- ============================================================================
-- 0160 · Visitor consent layer (privacy-first).
--
-- The visitor-intelligence spine (mkt_visitors / mkt_sessions / mkt_touchpoints,
-- 0058) records first-party analytics keyed by an anonymous id, but had NO
-- consent model — so /api/mkt/track wrote regardless of the visitor's choice.
-- This adds an APPEND-ONLY consent ledger: every grant/revoke is one immutable,
-- timestamped, versioned row keyed by the anonymous id (and the CRM contact once
-- identified). Current state = the latest row per (anonymous_id, category), so a
-- later 'denied' revokes and the full history is auditable.
--
-- Categories: necessary (always on) · analytics · personalization ·
-- marketing_email · marketing_sms. GPC/Do-Not-Sell is honored at read time.
--
-- Service-role only (RLS ENABLED, NO policies) — mirrors the mkt_ convention;
-- written by /api/mkt/consent and read by /api/mkt/track. Additive + idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.mkt_consent_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anonymous_id  text NOT NULL,
  contact_id    uuid REFERENCES public.crm_contacts(id) ON DELETE SET NULL,
  category      text NOT NULL CHECK (category IN
                  ('necessary','analytics','personalization','marketing_email','marketing_sms')),
  decision      text NOT NULL CHECK (decision IN ('granted','denied')),
  policy_version text NOT NULL DEFAULT 'v1',
  source        text,          -- banner | preference_center | signup | api | gpc
  gpc           boolean NOT NULL DEFAULT false,
  user_agent    text,
  metadata      jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now()
);
-- Latest-per-category lookups by visitor, and contact rollups.
CREATE INDEX IF NOT EXISTS idx_mkt_consent_anon
  ON public.mkt_consent_events (anonymous_id, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mkt_consent_contact
  ON public.mkt_consent_events (contact_id, created_at DESC);

ALTER TABLE public.mkt_consent_events ENABLE ROW LEVEL SECURITY;
-- No policies: service-role only (like mkt_visitors / mkt_sessions / mkt_touchpoints).


-- ══════════ 0161_demo_session_email_gate.sql ══════════
-- FamilyOS :: 0161 — Email-gate the demo + defer the countdown
--
-- The "Test Account" demo now opens behind a blurred email-capture pop-up: one
-- click provisions the demo and signs the visitor in, but the 5-minute clock does
-- NOT start until they enter an email. So `expires_at` becomes nullable (null =
-- provisioned, clock not started yet) and we capture the address in `email`.

alter table public.demo_sessions
  alter column expires_at drop not null;

alter table public.demo_sessions
  add column if not exists email text;

-- Reaping abandoned, never-started demos (email never entered) is by created_at,
-- so keep that queryable.
create index if not exists idx_demo_sessions_created on public.demo_sessions (created_at);


-- ══════════ 0162_demo_email_uses.sql ══════════
-- FamilyOS :: 0162 — One demo per email (durable per-email demo usage ledger)
--
-- The demo is a SINGLE shared account, so demo_sessions.email is one row the next
-- visitor overwrites — useless for "this email already used its demo". This table
-- is the durable, per-email record: when an email starts a demo we stamp it here
-- with that demo's 5-minute expiry. Once expired, that email can't start another
-- demo — the email gate routes it to the upgrade/plan-choice page instead.
--
-- Service-role only (writes + the gate check run through the service client in the
-- demo server actions); RLS enabled with no policies so it's never client-readable.
-- Additive + idempotent.

create table if not exists public.demo_email_uses (
  email         text        primary key,
  first_used_at timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  -- the 5-minute expiry of this email's most recent demo; once now() passes it,
  -- the email is "used up" and can't demo again.
  expires_at    timestamptz not null,
  uses          integer     not null default 1,
  created_at    timestamptz not null default now()
);

create index if not exists idx_demo_email_uses_expires on public.demo_email_uses (expires_at);

alter table public.demo_email_uses enable row level security;
-- No policies: only the service-role client (demo actions) reads/writes this.


-- ══════════ 0163_messages_audio_read_fix.sql ══════════
-- FamilyOS :: 0163 — Messages: allow audio kind + non-destructive read receipts
--
-- Two live Messages bugs:
--   1. Voice notes NEVER saved: the module inserts family_messages.kind='audio'
--      (and renders kind==='audio'), but the 0014 CHECK only allows
--      ('text','image','file','voice','poll','announcement') — every voice
--      message insert violated the constraint and failed. Widen it to include
--      'audio' (keeping every existing value, so no data rewrite).
--   2. Read receipts wiped each other: mark-as-read did
--      update({ read_by: [me] }) — REPLACING the array and erasing every other
--      reader (the family-member RLS policy allows the update, so it succeeded).
--      Add a proper append RPC the client calls instead.
--
-- Additive + idempotent. RLS unchanged; the RPC is SECURITY INVOKER, so the
-- 0014 family-member policy still governs which rows it may touch.

-- 1. Widen family_messages.kind to include 'audio'.
do $$
declare
  c_name text;
begin
  select con.conname into c_name
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'family_messages'
    and con.contype = 'c'
    and pg_get_constraintdef(con.oid) ilike '%kind%';
  if c_name is not null then
    execute format('alter table public.family_messages drop constraint %I', c_name);
  end if;
end $$;

alter table public.family_messages
  add constraint family_messages_kind_check
  check (kind in ('text','image','file','voice','audio','poll','announcement'));

-- 2. Append-only mark-as-read: adds the caller to read_by on every unread,
--    non-deleted message in the conversation WITHOUT touching other readers.
create or replace function public.mark_conversation_read(p_conversation_id uuid)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.family_messages
     set read_by = array_append(read_by, auth.uid())
   where conversation_id = p_conversation_id
     and deleted_at is null
     and auth.uid() is not null
     and not (read_by @> array[auth.uid()]);
$$;

grant execute on function public.mark_conversation_read(uuid) to authenticated;

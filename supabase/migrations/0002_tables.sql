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

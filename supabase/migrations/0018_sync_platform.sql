-- Bubaly :: 0018 sync platform
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
  create trigger trg_sync_log after insert or update or delete on public.sync_calendar_events
    for each row execute function public.sync_log_change('event');
  drop trigger if exists trg_sync_log on public.sync_reminders;
  create trigger trg_sync_log after insert or update or delete on public.sync_reminders
    for each row execute function public.sync_log_change('reminder');
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

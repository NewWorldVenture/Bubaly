-- FamilyOS :: 0024 social media command center
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
create trigger trg_audit_social_accounts
  after insert or update or delete on public.social_accounts
  for each row execute function public.social_write_audit();

drop trigger if exists trg_audit_social_posts on public.social_posts;
create trigger trg_audit_social_posts
  after insert or update or delete on public.social_posts
  for each row execute function public.social_write_audit();

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
create policy social_providers_read on public.social_providers for select
  using (auth.role() = 'authenticated');

-- Tokens: NO policy → only the service-role client (which bypasses RLS) can touch
-- them. RLS is enabled above, so authenticated users get zero rows. This is the
-- deliberate "secure token storage" boundary; never add a permissive policy here.

-- Webhook events: family members may read events scoped to their family; writes
-- are service-role only (no insert/update policy).
drop policy if exists social_webhooks_select on public.social_webhook_events;
create policy social_webhooks_select on public.social_webhook_events for select
  using (family_id is not null and public.is_family_member(family_id));

-- Tighten the publish-sensitive writes to the granular role (defense in depth on
-- top of family isolation). Publishing/scheduling requires the matching permission.
drop policy if exists social_publish_jobs_insert on public.social_publish_jobs;
create policy social_publish_jobs_insert on public.social_publish_jobs for insert
  with check (public.social_has_permission(family_id, 'publish_posts')
              or public.social_has_permission(family_id, 'schedule_posts'));

-- These two policy names were already created generically by the loop above;
-- drop them first, then recreate with the stricter manage_access check.
drop policy if exists social_access_permissions_insert on public.social_access_permissions;
create policy social_access_permissions_insert on public.social_access_permissions for insert
  with check (public.is_family_admin(family_id) or public.social_has_permission(family_id, 'manage_access'));
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

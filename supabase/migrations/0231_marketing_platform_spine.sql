-- ============================================================================
-- Migration 0231: Marketing platform spine
--
-- This migration turns the existing marketing tools into one durable operating
-- system. Pages are versioned, generated work is queued, templates and brand
-- rules are reusable, and provider observations are stored without inventing
-- rankings or citations when a provider is unavailable.
-- ============================================================================

create extension if not exists vector with schema extensions;

create table if not exists public.marketing_pages (
  id uuid primary key default gen_random_uuid(),
  page_type text not null check (page_type in (
    'landing','question','guide','comparison','alternative','audience',
    'resource','glossary','feature','blog','custom'
  )),
  slug text not null,
  path text not null unique,
  parent_id uuid references public.marketing_pages(id) on delete set null,
  campaign_id uuid references public.marketing_campaigns(id) on delete set null,
  template_id uuid,
  title text not null,
  summary text,
  body text,
  content jsonb not null default '{}'::jsonb,
  seo jsonb not null default '{}'::jsonb,
  aeo jsonb not null default '{}'::jsonb,
  status text not null default 'draft' check (status in ('draft','review','approved','published','archived')),
  version integer not null default 1 check (version > 0),
  published_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_mkt_pages_type_status on public.marketing_pages(page_type, status, updated_at desc);
create index if not exists idx_mkt_pages_parent on public.marketing_pages(parent_id, status);

create table if not exists public.marketing_page_versions (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references public.marketing_pages(id) on delete cascade,
  version integer not null,
  title text not null,
  summary text,
  body text,
  content jsonb not null default '{}'::jsonb,
  seo jsonb not null default '{}'::jsonb,
  aeo jsonb not null default '{}'::jsonb,
  change_source text not null default 'manual' check (change_source in ('manual','ai','import','publish','system')),
  change_note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(page_id, version)
);
create index if not exists idx_mkt_page_versions_page on public.marketing_page_versions(page_id, version desc);

create table if not exists public.marketing_content_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  page_type text not null,
  description text,
  schema jsonb not null default '{}'::jsonb,
  instructions text not null default '',
  defaults jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  status text not null default 'active' check (status in ('draft','active','archived')),
  is_default boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_mkt_templates_type_status on public.marketing_content_templates(page_type, status, is_default desc);
create unique index if not exists uq_mkt_default_template_per_type
  on public.marketing_content_templates(page_type) where is_default and status = 'active';

create table if not exists public.marketing_brand_rules (
  id uuid primary key default gen_random_uuid(),
  rule_key text not null unique,
  name text not null,
  instructions text not null default '',
  value jsonb not null default '{}'::jsonb,
  version integer not null default 1 check (version > 0),
  active boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.marketing_generation_jobs (
  id uuid primary key default gen_random_uuid(),
  job_type text not null check (job_type in (
    'regenerate_page','generate_questions','generate_metadata','embed_page','refresh_provider_data','sitemap_sync'
  )),
  target_type text not null default 'marketing_page',
  target_id uuid,
  target_path text,
  status text not null default 'queued' check (status in ('queued','running','succeeded','failed','dead_letter','cancelled')),
  priority integer not null default 50 check (priority between 0 and 100),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_mkt_generation_jobs_queue on public.marketing_generation_jobs(status, priority desc, run_after, created_at);
create index if not exists idx_mkt_generation_jobs_target on public.marketing_generation_jobs(target_type, target_id, created_at desc);

create table if not exists public.marketing_page_relationships (
  id uuid primary key default gen_random_uuid(),
  from_page_id uuid not null references public.marketing_pages(id) on delete cascade,
  to_page_id uuid not null references public.marketing_pages(id) on delete cascade,
  relationship text not null check (relationship in ('parent','related','answers','supports','compares','alternative_to','next')),
  position integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(from_page_id, to_page_id, relationship)
);
create index if not exists idx_mkt_page_relationships_from on public.marketing_page_relationships(from_page_id, relationship, position);
create index if not exists idx_mkt_page_relationships_to on public.marketing_page_relationships(to_page_id, relationship);

create table if not exists public.marketing_embeddings (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('page','page_version','question','content_item','asset')),
  source_id uuid not null,
  chunk_index integer not null default 0,
  content_hash text not null,
  content text not null,
  embedding extensions.vector(1536),
  provider text not null default 'openai',
  model text not null default 'text-embedding-3-small',
  dimensions integer not null default 1536,
  status text not null default 'ready' check (status in ('queued','ready','failed','stale')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(source_type, source_id, chunk_index, content_hash)
);
create index if not exists idx_mkt_embeddings_source on public.marketing_embeddings(source_type, source_id);

create table if not exists public.marketing_provider_observations (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('google_search_console','bing_webmaster','ai_citation','manual')),
  engine text not null default 'unknown',
  observed_for date not null,
  page_path text,
  query text,
  clicks integer not null default 0,
  impressions integer not null default 0,
  ctr numeric(8,5),
  average_position numeric(10,4),
  citations integer not null default 0,
  cited boolean,
  payload jsonb not null default '{}'::jsonb,
  source_status text not null default 'observed' check (source_status in ('observed','unavailable','partial','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, engine, observed_for, page_path, query)
);
create index if not exists idx_mkt_provider_obs_date on public.marketing_provider_observations(provider, observed_for desc);
create index if not exists idx_mkt_provider_obs_page on public.marketing_provider_observations(page_path, observed_for desc);

-- Make the unique observation key deterministic even when an upstream provider
-- does not identify a search engine.
update public.marketing_provider_observations set engine = 'unknown' where engine is null;
alter table public.marketing_provider_observations alter column engine set default 'unknown';
alter table public.marketing_provider_observations alter column engine set not null;

create table if not exists public.marketing_provider_syncs (
  provider text primary key check (provider in ('google_search_console','bing_webmaster','ai_citation')),
  status text not null default 'not_configured' check (status in ('not_configured','connected','degraded','error')),
  last_started_at timestamptz,
  last_completed_at timestamptz,
  last_error text,
  rows_imported integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Asset provenance and byte-level deduplication. Existing first-party assets are
-- explicitly marked original; future uploads must carry a declared license and
-- cannot reuse the same content hash while the prior asset is active.
alter table public.marketing_assets add column if not exists content_hash text;
alter table public.marketing_assets add column if not exists license text not null default 'original';
alter table public.marketing_assets add column if not exists source_url text;
alter table public.marketing_assets add column if not exists attribution text;
create unique index if not exists uq_marketing_assets_content_hash
  on public.marketing_assets(content_hash) where content_hash is not null and deleted_at is null;

alter table public.marketing_videos add column if not exists source_hash text;
alter table public.marketing_videos add column if not exists license text not null default 'embedded_source';
create unique index if not exists uq_marketing_videos_source_hash
  on public.marketing_videos(source_hash) where source_hash is not null and deleted_at is null;

alter table public.marketing_pages enable row level security;
alter table public.marketing_page_versions enable row level security;
alter table public.marketing_content_templates enable row level security;
alter table public.marketing_brand_rules enable row level security;
alter table public.marketing_generation_jobs enable row level security;
alter table public.marketing_page_relationships enable row level security;
alter table public.marketing_embeddings enable row level security;
alter table public.marketing_provider_observations enable row level security;
alter table public.marketing_provider_syncs enable row level security;

create policy marketing_pages_admin_all on public.marketing_pages for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());
create policy marketing_pages_public_read on public.marketing_pages for select to anon, authenticated
  using (status = 'published' and deleted_at is null);
create policy marketing_page_relationships_admin_all on public.marketing_page_relationships for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());
create policy marketing_page_relationships_public_read on public.marketing_page_relationships for select to anon, authenticated
  using (exists (select 1 from public.marketing_pages p where p.id = from_page_id and p.status = 'published' and p.deleted_at is null)
     and exists (select 1 from public.marketing_pages p where p.id = to_page_id and p.status = 'published' and p.deleted_at is null));

create policy marketing_page_versions_admin_all on public.marketing_page_versions for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());
create policy marketing_templates_admin_all on public.marketing_content_templates for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());
create policy marketing_brand_rules_admin_all on public.marketing_brand_rules for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());
create policy marketing_generation_jobs_admin_all on public.marketing_generation_jobs for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());
create policy marketing_embeddings_admin_all on public.marketing_embeddings for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());
create policy marketing_provider_observations_admin_all on public.marketing_provider_observations for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());
create policy marketing_provider_syncs_admin_all on public.marketing_provider_syncs for all to authenticated
  using (public.is_super_admin()) with check (public.is_super_admin());

-- RLS is authorization, not table privilege. Keep the public surface narrow and
-- grant the worker/admin roles only what their policies and RPC require.
grant select on public.marketing_pages, public.marketing_page_relationships to anon, authenticated;
grant select, insert, update, delete on public.marketing_page_versions,
  public.marketing_content_templates, public.marketing_brand_rules,
  public.marketing_generation_jobs, public.marketing_embeddings,
  public.marketing_provider_observations, public.marketing_provider_syncs to authenticated;
grant all on public.marketing_pages, public.marketing_page_versions,
  public.marketing_content_templates, public.marketing_brand_rules,
  public.marketing_generation_jobs, public.marketing_page_relationships,
  public.marketing_embeddings, public.marketing_provider_observations,
  public.marketing_provider_syncs to service_role;

-- Keep page edits durable and automatic. Admin edits bump the version and enqueue
-- one idempotent regeneration job. Worker writes leave updated_by null so they do
-- not recursively enqueue themselves.
create or replace function public.marketing_page_version_on_edit()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.updated_by is not null and (
    new.page_type is distinct from old.page_type or new.slug is distinct from old.slug or
    new.path is distinct from old.path or new.parent_id is distinct from old.parent_id or
    new.campaign_id is distinct from old.campaign_id or new.template_id is distinct from old.template_id or
    new.title is distinct from old.title or new.summary is distinct from old.summary or
    new.body is distinct from old.body or new.content is distinct from old.content or
    new.seo is distinct from old.seo or new.aeo is distinct from old.aeo or
    new.status is distinct from old.status or new.published_at is distinct from old.published_at or
    new.deleted_at is distinct from old.deleted_at
  ) then
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_marketing_page_version_on_edit on public.marketing_pages;
create trigger trg_marketing_page_version_on_edit before update on public.marketing_pages
for each row execute function public.marketing_page_version_on_edit();

create or replace function public.enqueue_marketing_page_generation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.marketing_generation_jobs
    (job_type, target_type, target_id, target_path, idempotency_key, payload, created_by)
  values
    ('regenerate_page', 'marketing_page', new.id, new.path,
     format('marketing-page:%s:v:%s', new.id, new.version),
     jsonb_build_object('page_id', new.id, 'path', new.path, 'version', new.version), new.updated_by)
  on conflict (idempotency_key) do nothing;
  return new;
end;
$$;
drop trigger if exists trg_enqueue_marketing_page_generation_insert on public.marketing_pages;
create trigger trg_enqueue_marketing_page_generation_insert after insert on public.marketing_pages
for each row execute function public.enqueue_marketing_page_generation();
drop trigger if exists trg_enqueue_marketing_page_generation_update on public.marketing_pages;
create trigger trg_enqueue_marketing_page_generation_update after update on public.marketing_pages
for each row when (new.updated_by is not null and new.deleted_at is null and new.version is distinct from old.version)
execute function public.enqueue_marketing_page_generation();

create or replace function public.claim_marketing_generation_jobs(p_limit integer default 10)
returns setof public.marketing_generation_jobs
language plpgsql security definer set search_path = public as $$
begin
  update public.marketing_generation_jobs
  set status = case when attempts >= max_attempts then 'dead_letter' else 'queued' end,
      locked_at = null,
      run_after = now(),
      error = coalesce(error, 'Recovered after a stale worker lock.')
  where status = 'running'
    and locked_at is not null
    and locked_at < now() - interval '15 minutes';

  return query
  with candidates as (
    select id
    from public.marketing_generation_jobs
    where status = 'queued' and run_after <= now()
    order by priority desc, created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  update public.marketing_generation_jobs j
  set status = 'running', attempts = j.attempts + 1, locked_at = now(), started_at = now(), updated_at = now()
  from candidates c
  where j.id = c.id
  returning j.*;
end;
$$;
revoke all on function public.claim_marketing_generation_jobs(integer) from public;
grant execute on function public.claim_marketing_generation_jobs(integer) to service_role;

insert into public.marketing_provider_syncs(provider)
values ('google_search_console'), ('bing_webmaster'), ('ai_citation')
on conflict (provider) do nothing;

do $$
declare t text;
begin
  foreach t in array array[
    'marketing_pages','marketing_content_templates','marketing_brand_rules',
    'marketing_generation_jobs','marketing_embeddings','marketing_provider_observations'
  ] loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', t);
    execute format('create trigger trg_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- Production verification (run after `supabase db push`):
-- select to_regclass('public.marketing_pages'),
--        to_regclass('public.marketing_generation_jobs'),
--        to_regclass('public.marketing_embeddings'),
--        has_table_privilege('anon', 'public.marketing_pages', 'SELECT'),
--        has_function_privilege('service_role', 'public.claim_marketing_generation_jobs(integer)', 'EXECUTE');
-- Rollback note: restore from a reviewed database backup before removing this
-- spine. The dependent public/admin routes must be disabled before dropping it.

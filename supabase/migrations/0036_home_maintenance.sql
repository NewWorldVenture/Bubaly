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

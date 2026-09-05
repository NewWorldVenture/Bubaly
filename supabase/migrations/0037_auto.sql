-- Bubaly :: 0037 auto / vehicles command center
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

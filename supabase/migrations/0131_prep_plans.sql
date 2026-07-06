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
create trigger set_prep_plans_updated before update on public.prep_plans
  for each row execute function public.set_updated_at();
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

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
create trigger set_life_event_plans_updated before update on public.life_event_plans
  for each row execute function public.set_updated_at();
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

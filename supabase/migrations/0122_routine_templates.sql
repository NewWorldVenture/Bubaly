-- Bubaly :: 0122 recurring-routine templates
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
create trigger trg_set_updated_at before update on public.routine_templates
  for each row execute function public.set_updated_at();
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

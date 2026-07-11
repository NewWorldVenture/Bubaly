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
create trigger set_concierge_plan_actions_updated before update on public.concierge_plan_actions
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.concierge_plan_actions enable row level security;

drop policy if exists concierge_plan_actions_select on public.concierge_plan_actions;
create policy concierge_plan_actions_select on public.concierge_plan_actions
  for select using (public.is_family_member(family_id));

drop policy if exists concierge_plan_actions_insert on public.concierge_plan_actions;
create policy concierge_plan_actions_insert on public.concierge_plan_actions
  for insert with check (public.is_family_member(family_id));

drop policy if exists concierge_plan_actions_update on public.concierge_plan_actions;
create policy concierge_plan_actions_update on public.concierge_plan_actions
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

drop policy if exists concierge_plan_actions_delete on public.concierge_plan_actions;
create policy concierge_plan_actions_delete on public.concierge_plan_actions
  for delete using (public.is_family_member(family_id));

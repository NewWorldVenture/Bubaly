-- FamilyOS :: 0174 — Household workload balancing + analytics (renumbered from 0166)
--
-- The "mental load" feature no mainstream family app ships well: measure who is
-- actually carrying the household (chores by estimated minutes, tasks, events
-- organized) and rebalance it. The live numbers are computed in the app from
-- chore_assignments/todo_items/events; this table persists ONE row per member
-- per week so the analytics view can show trends ("Mom carried 61% of the load
-- for 6 straight weeks") without re-deriving history that the source tables no
-- longer contain (completed rows get archived/pruned by other flows).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.workload_snapshots (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  member_id      uuid not null references public.family_members(id) on delete cascade,
  week_start     date not null,                    -- Monday of the ISO week
  chore_minutes  integer not null default 0,       -- est_minutes-weighted chores done
  chore_count    integer not null default 0,
  task_count     integer not null default 0,       -- todo items completed
  event_count    integer not null default 0,       -- events organized/owned
  invisible_count integer not null default 0,      -- coordination acts (approvals, planning)
  load_score     integer not null default 0,       -- 0-100 composite for the week
  share_pct      numeric(5,2) not null default 0,  -- member's share of family load
  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (family_id, member_id, week_start)
);

create index if not exists idx_workload_snap_family_week
  on public.workload_snapshots(family_id, week_start desc);
create index if not exists idx_workload_snap_member
  on public.workload_snapshots(member_id, week_start desc);

drop trigger if exists set_workload_snapshots_updated_at on public.workload_snapshots;
create trigger set_workload_snapshots_updated_at
  before update on public.workload_snapshots
  for each row execute function public.set_updated_at();

alter table public.workload_snapshots enable row level security;

drop policy if exists workload_snapshots_select on public.workload_snapshots;
create policy workload_snapshots_select on public.workload_snapshots
  for select using (public.is_family_member(family_id));

drop policy if exists workload_snapshots_insert on public.workload_snapshots;
create policy workload_snapshots_insert on public.workload_snapshots
  for insert with check (public.is_family_member(family_id));

drop policy if exists workload_snapshots_update on public.workload_snapshots;
create policy workload_snapshots_update on public.workload_snapshots
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

drop policy if exists workload_snapshots_delete on public.workload_snapshots;
create policy workload_snapshots_delete on public.workload_snapshots
  for delete using (public.is_family_member(family_id));

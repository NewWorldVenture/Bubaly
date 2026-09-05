-- Bubaly :: 0175 — Child independence progression (renumbered from 0167)
--
-- "AI increases responsibilities as children mature": an age-banded milestone
-- ladder across six life domains (chores, money, safety, self-care, school,
-- social). The ladder content lives in the app (lib/independence/progression.ts);
-- this table stores each child's actual progress — suggested → in_progress →
-- achieved — so growth is visible and celebrated, and unlocks (bigger chores,
-- allowance steps, privileges) can key off it.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.independence_milestones (
  id           uuid primary key default gen_random_uuid(),
  family_id    uuid not null references public.families(id) on delete cascade,
  member_id    uuid not null references public.family_members(id) on delete cascade,
  domain       text not null
                 check (domain in ('chores','money','safety','self_care','school','social')),
  title        text not null,
  description  text,
  age_band     text not null
                 check (age_band in ('4-6','7-9','10-12','13-15','16-18')),
  status       text not null default 'suggested'
                 check (status in ('suggested','in_progress','achieved','skipped')),
  points       integer not null default 10,
  evidence     text,                -- how it was demonstrated ("made lunch solo all week")
  achieved_at  timestamptz,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (family_id, member_id, domain, title)
);

create index if not exists idx_independence_member
  on public.independence_milestones(member_id, status);
create index if not exists idx_independence_family
  on public.independence_milestones(family_id, created_at desc);

drop trigger if exists set_independence_milestones_updated_at on public.independence_milestones;
create trigger set_independence_milestones_updated_at
  before update on public.independence_milestones
  for each row execute function public.set_updated_at();

alter table public.independence_milestones enable row level security;

drop policy if exists independence_milestones_select on public.independence_milestones;
create policy independence_milestones_select on public.independence_milestones
  for select using (public.is_family_member(family_id));

drop policy if exists independence_milestones_insert on public.independence_milestones;
create policy independence_milestones_insert on public.independence_milestones
  for insert with check (public.is_family_member(family_id));

drop policy if exists independence_milestones_update on public.independence_milestones;
create policy independence_milestones_update on public.independence_milestones
  for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id));

drop policy if exists independence_milestones_delete on public.independence_milestones;
create policy independence_milestones_delete on public.independence_milestones
  for delete using (public.is_family_member(family_id));

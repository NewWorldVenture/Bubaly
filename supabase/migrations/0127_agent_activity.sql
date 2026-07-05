-- FamilyOS :: 0127 Agent activity (North Star pillar #6 — specialized agents)
-- ----------------------------------------------------------------------------
-- The family sees one assistant; behind it a roster of domain agents (Chief of
-- Staff, Scheduler, Meal Planner, Budget Coach, …). This table is the persistent
-- record of what each agent surfaces or does — an auditable "system of
-- execution" log the /dashboard/agents surface reads (live briefings are
-- computed; this is the durable history the family can act on / dismiss).
--
-- Family-scoped RLS. Additive + idempotent.

create table if not exists public.agent_activity (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  member_id   uuid references public.family_members(id) on delete set null,   -- who it's about (null = whole family)
  agent       text not null,                     -- AgentId, e.g. 'scheduler'
  kind        text not null default 'insight'
                check (kind in ('insight','recommendation','action','handoff')),
  title       text not null,
  detail      text,
  href        text,
  severity    text not null default 'info' check (severity in ('info','attention','action')),
  status      text not null default 'active' check (status in ('active','done','dismissed')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_agent_activity_family on public.agent_activity(family_id, status, created_at desc);
create index if not exists idx_agent_activity_agent  on public.agent_activity(family_id, agent, created_at desc);

-- updated_at trigger
drop trigger if exists set_agent_activity_updated on public.agent_activity;
create trigger set_agent_activity_updated before update on public.agent_activity
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['agent_activity'] loop
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

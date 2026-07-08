-- FamilyOS :: 0149 Reasoning snapshots — the unified Family Reasoning Engine log (R7)
-- ----------------------------------------------------------------------------
-- R7 (unify the reasoning engine): instead of ~8 engines each answering part of
-- "what's going on with this family", a single core (lib/reasoning/engine.ts)
-- answers the six questions every surface consumes — what matters most, what's
-- being forgotten, what to decide next, what Bubaly can just handle, who needs
-- help, and the next best move. It composes the FOI orchestrator, the graph
-- reasoning insights (R2), the hard signals (R10), and ranked next-actions.
--
-- This table persists one snapshot per (family, day): the all-clear flag, the
-- attention count, and a compact report summary — so /dashboard/reasoning can
-- show a day-over-day trend and the report becomes durable family memory.
-- One row per (family, day).
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.reasoning_snapshots (
  id               uuid primary key default gen_random_uuid(),
  family_id        uuid not null references public.families(id) on delete cascade,
  as_of_date       date not null default current_date,
  all_clear        boolean not null default true,
  attention_count  integer not null default 0,
  report           jsonb not null default '{}'::jsonb,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (family_id, as_of_date)
);

create index if not exists idx_reasoning_snapshots_family on public.reasoning_snapshots(family_id, as_of_date desc);

drop trigger if exists set_reasoning_snapshots_updated on public.reasoning_snapshots;
create trigger set_reasoning_snapshots_updated before update on public.reasoning_snapshots
  for each row execute function public.set_updated_at();

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.reasoning_snapshots enable row level security;

drop policy if exists reasoning_snapshots_select on public.reasoning_snapshots;
create policy reasoning_snapshots_select on public.reasoning_snapshots
  for select using (public.is_family_member(family_id));

drop policy if exists reasoning_snapshots_insert on public.reasoning_snapshots;
create policy reasoning_snapshots_insert on public.reasoning_snapshots
  for insert with check (public.is_family_member(family_id));

drop policy if exists reasoning_snapshots_update on public.reasoning_snapshots;
create policy reasoning_snapshots_update on public.reasoning_snapshots
  for update using (public.is_family_member(family_id));

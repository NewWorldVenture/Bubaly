-- Bubaly :: 0138 Onboarding calendar imports — the "value-first" first-run record
-- ----------------------------------------------------------------------------
-- T1 (TIME-TO-FIRST-VALUE): the value step imports the family's existing calendar
-- (paste .ics or a sample week), computes an instant "first brief" (today's
-- timeline · conflicts · action list · time-saved opportunities), and persists the
-- imported events into calendar_events at finalize. THIS table is the durable
-- record of that first-value moment: one row per import, with the computed brief
-- summary. It is the seed of the TTFV metric (T10) — "did the family reach a first
-- outcome, and how big was it" — and gives Support a trail when an import looks off.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.onboarding_imports (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  source             text not null default 'ics'
                       check (source in ('ics', 'paste', 'url', 'demo')),
  event_count        integer not null default 0 check (event_count >= 0),
  today_count        integer not null default 0 check (today_count >= 0),
  conflict_count     integer not null default 0 check (conflict_count >= 0),
  action_count       integer not null default 0 check (action_count >= 0),
  time_saved_minutes integer not null default 0 check (time_saved_minutes >= 0),
  brief              jsonb   not null default '{}'::jsonb,   -- the computed FirstBrief summary
  created_by         uuid,
  created_at         timestamptz not null default now()
);

create index if not exists idx_onboarding_imports_family on public.onboarding_imports(family_id, created_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table public.onboarding_imports enable row level security;

drop policy if exists onboarding_imports_select on public.onboarding_imports;
create policy onboarding_imports_select on public.onboarding_imports
  for select using (public.is_family_member(family_id));

drop policy if exists onboarding_imports_insert on public.onboarding_imports;
create policy onboarding_imports_insert on public.onboarding_imports
  for insert with check (public.is_family_member(family_id));

drop policy if exists onboarding_imports_delete on public.onboarding_imports;
create policy onboarding_imports_delete on public.onboarding_imports
  for delete using (public.is_family_member(family_id));

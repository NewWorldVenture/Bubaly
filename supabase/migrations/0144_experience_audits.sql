-- Bubaly :: 0144 Experience Scorecard — measurable premium-consistency (T8)
-- ----------------------------------------------------------------------------
-- The premium-consistency sweep is only real if it's measured. This persists a
-- dated audit per surface (a module or a journey) across the six dimensions that
-- make an experience feel premium — empty state, error recovery, transitions,
-- performance, accessibility, consistency (each 0..100) — so the scorecard can
-- roll them up live and track the trend over time (dated rows → trend lines).
--
-- Family-scoped RLS via public.is_family_member; the scoring/rollup lives in the
-- pure lib/experience/scorecard.ts. Additive + idempotent. Validated on PG16.

create table if not exists public.experience_audits (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  surface_key    text not null,                    -- stable id, e.g. 'calendar'
  surface_label  text not null,                    -- display name, e.g. 'Calendar'
  category       text not null default 'module'
                   check (category in ('module','journey')),
  audited_on     date not null default current_date,
  empty_state    integer check (empty_state    between 0 and 100),
  error_recovery integer check (error_recovery between 0 and 100),
  transitions    integer check (transitions    between 0 and 100),
  performance    integer check (performance    between 0 and 100),
  accessibility  integer check (accessibility  between 0 and 100),
  consistency    integer check (consistency    between 0 and 100),
  score          integer check (score between 0 and 100),   -- cached composite
  grade          text    check (grade in ('A','B','C','D','F')),
  notes          text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (family_id, surface_key, audited_on)       -- one audit per surface per day
);
create index if not exists idx_experience_audits_family on public.experience_audits(family_id, audited_on desc);
create index if not exists idx_experience_audits_surface on public.experience_audits(family_id, surface_key, audited_on desc);

-- ── updated_at trigger ──────────────────────────────────────────────────────
drop trigger if exists set_experience_audits_updated on public.experience_audits;
create trigger set_experience_audits_updated before update on public.experience_audits
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
begin
  execute 'alter table public.experience_audits enable row level security';
  execute 'drop policy if exists experience_audits_select on public.experience_audits';
  execute 'create policy experience_audits_select on public.experience_audits for select using (public.is_family_member(family_id))';
  execute 'drop policy if exists experience_audits_insert on public.experience_audits';
  execute 'create policy experience_audits_insert on public.experience_audits for insert with check (public.is_family_member(family_id))';
  execute 'drop policy if exists experience_audits_update on public.experience_audits';
  execute 'create policy experience_audits_update on public.experience_audits for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))';
  execute 'drop policy if exists experience_audits_delete on public.experience_audits';
  execute 'create policy experience_audits_delete on public.experience_audits for delete using (public.is_family_member(family_id))';
end $$;

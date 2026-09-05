-- Bubaly :: 0130 Family Decision Engine
-- ----------------------------------------------------------------------------
-- Persists family trade-off decisions so they can be revisited + learned from.
-- A decision ("Which vacation?") holds a set of options, each with the metrics
-- the pure engine scores (cost / time / travel / load / benefit) plus the
-- engine's computed score + rationale. The family picks the winner (decided_
-- option_id) — the AI recommends, the family decides.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.family_decisions (
  id                 uuid primary key default gen_random_uuid(),
  family_id          uuid not null references public.families(id) on delete cascade,
  question           text not null,
  detail             text,
  status             text not null default 'open'
                       check (status in ('open','decided','archived')),
  budget_cents       bigint,              -- optional hard cap
  max_travel_minutes integer,             -- optional hard cap
  weights            jsonb not null default '{}'::jsonb,  -- per-criterion overrides
  decided_option_id  uuid,                -- set when status='decided' (FK added after options table)
  created_by         uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_family_decisions_family on public.family_decisions(family_id, status, updated_at desc);

create table if not exists public.decision_options (
  id             uuid primary key default gen_random_uuid(),
  family_id      uuid not null references public.families(id) on delete cascade,
  decision_id    uuid not null references public.family_decisions(id) on delete cascade,
  label          text not null,
  cost_cents     bigint,
  time_minutes   integer,
  travel_minutes integer,
  load_delta     integer,       -- 0..100 added family burden
  benefit        integer,       -- 0..100 upside
  score          numeric,       -- last engine score 0..100 (cached)
  rationale      text,          -- last engine rationale
  feasible       boolean not null default true,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_decision_options_decision on public.decision_options(family_id, decision_id);

-- decided_option_id references decision_options (added here to avoid a cycle at create time).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'family_decisions_decided_option_fk'
  ) then
    alter table public.family_decisions
      add constraint family_decisions_decided_option_fk
      foreign key (decided_option_id) references public.decision_options(id) on delete set null;
  end if;
end $$;

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists set_family_decisions_updated on public.family_decisions;
create trigger set_family_decisions_updated before update on public.family_decisions
  for each row execute function public.set_updated_at();
drop trigger if exists set_decision_options_updated on public.decision_options;
create trigger set_decision_options_updated before update on public.decision_options
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['family_decisions','decision_options'] loop
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

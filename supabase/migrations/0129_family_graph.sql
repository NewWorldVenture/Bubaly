-- Bubaly :: 0129 Family Knowledge Graph (the reasoning substrate)
-- ----------------------------------------------------------------------------
-- The moat: instead of isolated tables, model the household as a graph of typed
-- ENTITIES (people, activities, places, orgs, items, events, pets…) linked by
-- typed EDGES (child --plays--> activity --at--> place --coached_by--> person).
-- Once relationships are first-class, the AI can *reason across* the household
-- (traverse, find dependencies, propagate impact: weather -> field -> game ->
-- travel -> dinner) rather than just retrieve rows. This is what makes autonomous
-- planning, the decision engine, and the Chief of Staff possible.
--
-- graph_entities  — typed nodes. `ref_table`/`ref_id` optionally link a node to
--                   an existing row (a family_member, calendar_event, place…) so
--                   the graph augments the app instead of duplicating it.
-- graph_edges     — directed, typed relationships between two entities, with an
--                   optional weight (edge strength) + metadata.
--
-- Additive + idempotent. Family-scoped RLS via public.is_family_member.

create table if not exists public.graph_entities (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  kind        text not null default 'other'
                check (kind in ('person','activity','place','org','event','item','pet','topic','other')),
  name        text not null,
  ref_table   text,                          -- e.g. 'family_members', 'calendar_events' (nullable)
  ref_id      uuid,                          -- row it mirrors, if any
  attributes  jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_graph_entities_family on public.graph_entities(family_id, kind);
create index if not exists idx_graph_entities_ref on public.graph_entities(family_id, ref_table, ref_id);
-- One graph node per underlying row, so the twin projector can upsert idempotently
-- (a family_member/vehicle/team is mirrored exactly once). Plain (non-partial) so
-- PostgREST .upsert(onConflict) can target it; NULL ref rows (manual/seeded nodes)
-- are treated as distinct by Postgres, so they're unconstrained.
create unique index if not exists uq_graph_entities_ref
  on public.graph_entities(family_id, ref_table, ref_id);

create table if not exists public.graph_edges (
  id          uuid primary key default gen_random_uuid(),
  family_id   uuid not null references public.families(id) on delete cascade,
  source_id   uuid not null references public.graph_entities(id) on delete cascade,
  target_id   uuid not null references public.graph_entities(id) on delete cascade,
  relation    text not null,                 -- e.g. 'plays','at','coached_by','member_of','affects','needs','parent_of'
  weight      numeric not null default 1     check (weight >= 0 and weight <= 1),
  attributes  jsonb not null default '{}'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- one edge of a given relation between the same two nodes
  unique (family_id, source_id, target_id, relation),
  check (source_id <> target_id)
);
create index if not exists idx_graph_edges_family on public.graph_edges(family_id);
create index if not exists idx_graph_edges_source on public.graph_edges(family_id, source_id, relation);
create index if not exists idx_graph_edges_target on public.graph_edges(family_id, target_id, relation);

-- ── updated_at triggers ─────────────────────────────────────────────────────
drop trigger if exists set_graph_entities_updated on public.graph_entities;
create trigger set_graph_entities_updated before update on public.graph_entities
  for each row execute function public.set_updated_at();
drop trigger if exists set_graph_edges_updated on public.graph_edges;
create trigger set_graph_edges_updated before update on public.graph_edges
  for each row execute function public.set_updated_at();

-- ── RLS: family-scoped for all operations ───────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['graph_entities','graph_edges'] loop
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

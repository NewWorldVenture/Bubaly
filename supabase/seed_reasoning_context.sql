-- ============================================================================
-- Bubaly · SEED — Reasoning Context (R1)  [seed:reasoning]
-- Exercises lib/reasoning/context.ts::loadFamilyContext at volume. Unlike
-- seed_graph.sql this ALSO:
--   • mirrors real family_members as ref-linked nodes (ref_table/ref_id) so the
--     row→node join (refIndex / entityForRow) resolves,
--   • concentrates edges on a hub node (so `hubs` ranks something real),
--   • builds a connected directed chain (so relatedTo / impactFrom traverse),
--   • leaves ~20 nodes unlinked (so orphanCount is non-zero).
-- Volume: 500 generated entities (+ one per member) and ~520 edges — >500 each.
-- Idempotent: clears its own '[seed:reasoning]' rows first (edges cascade).
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0129 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_ids    uuid[];
  v_hub    uuid;
  n int := 500;
  ring int := 480;   -- first `ring` nodes form a connected chain; the rest are orphans
  kinds  text[] := array['person','activity','place','org','event','item','pet','topic'];
  people text[] := array['Emma','Noah','Liam','Olivia','Ava','Daniel','Sofia','Mia','Coach Rivera','Grandma'];
  acts   text[] := array['Soccer','Piano','Swim Team','Robotics','Ballet','Scouts','Chess Club','Art Class'];
  places text[] := array['Field','School','Studio','Pool','Library','Gym','Grandma''s House','Rec Center'];
  topics text[] := array['Weather','Homework','Budget','Health','Travel','Nutrition'];
  rels   text[] := array['plays','at','coached_by','member_of','needs','affects','attends','owns','near'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  -- Clear prior seed (edges cascade on entity delete).
  delete from public.graph_entities where family_id = v_family and attributes->>'seed' = 'reasoning';

  -- (a) Mirror every real family member as a ref-linked person node so the
  --     row→node join (entityForRow) resolves to a live row.
  insert into public.graph_entities (family_id, kind, name, ref_table, ref_id, attributes)
  select v_family, 'person', coalesce(fm.display_name, 'Member'), 'family_members', fm.id,
         '{"seed":"reasoning","mirror":true}'::jsonb
  from public.family_members fm
  where fm.family_id = v_family and fm.is_active;

  -- (b) 500 generated entities across kinds, readable names by kind.
  insert into public.graph_entities (family_id, kind, name, attributes)
  select v_family,
    kinds[1 + (g.i % array_length(kinds,1))],
    case kinds[1 + (g.i % array_length(kinds,1))]
      when 'person'   then people[1 + (g.i % array_length(people,1))]
      when 'activity' then acts[1 + (g.i % array_length(acts,1))]
      when 'place'    then places[1 + (g.i % array_length(places,1))]
      when 'topic'    then topics[1 + (g.i % array_length(topics,1))]
      else initcap(kinds[1 + (g.i % array_length(kinds,1))])
    end || ' #' || g.i,
    '{"seed":"reasoning"}'::jsonb
  from generate_series(1, n) as g(i);

  -- Collect the generated (non-mirror) ids in stable order.
  select array_agg(id order by created_at, id) into v_ids
  from public.graph_entities
  where family_id = v_family and attributes->>'seed' = 'reasoning'
    and coalesce((attributes->>'mirror')::boolean, false) = false;
  v_hub := v_ids[1];

  -- (c) Connected directed chain over the first `ring` nodes (i -> i+1). Every
  --     edge is valid + unique; relatedTo / impactFrom traverse end to end.
  insert into public.graph_edges (family_id, source_id, target_id, relation, weight, attributes)
  select v_family, v_ids[g.i], v_ids[g.i + 1],
    rels[1 + (g.i % array_length(rels,1))],
    round((0.4 + (g.i % 6) * 0.1)::numeric, 2),
    '{"seed":"reasoning"}'::jsonb
  from generate_series(1, ring - 1) as g(i)
  on conflict (family_id, source_id, target_id, relation) do nothing;

  -- (d) Hub: node #1 affects 40 others → a clear coordination hub for `hubs`.
  insert into public.graph_edges (family_id, source_id, target_id, relation, weight, attributes)
  select v_family, v_hub, v_ids[g.i], 'affects',
    round((0.5 + (g.i % 5) * 0.1)::numeric, 2),
    '{"seed":"reasoning"}'::jsonb
  from generate_series(2, 41) as g(i)
  on conflict (family_id, source_id, target_id, relation) do nothing;

  -- (e) Tie each mirrored member into the hub so ref-linked nodes are reachable.
  insert into public.graph_edges (family_id, source_id, target_id, relation, weight, attributes)
  select v_family, e.id, v_hub, 'member_of', 0.9, '{"seed":"reasoning"}'::jsonb
  from public.graph_entities e
  where e.family_id = v_family and e.attributes->>'seed' = 'reasoning'
    and (e.attributes->>'mirror')::boolean = true
  on conflict (family_id, source_id, target_id, relation) do nothing;

  -- Nodes v_ids[ring+1 .. n] are intentionally left unlinked (orphans).

  raise notice 'Reasoning context seeded: % generated entities (+members), hub+chain+orphans, family %', n, v_family;
end $$;

-- Verify:
--   select count(*) from graph_entities where attributes->>'seed' = 'reasoning';   -- >= 500
--   select count(*) from graph_edges   where attributes->>'seed' = 'reasoning';   -- >= 500
--   -- orphans (no edges): should be ~20
--   select count(*) from graph_entities e
--     where e.attributes->>'seed'='reasoning'
--       and not exists (select 1 from graph_edges g where g.source_id=e.id or g.target_id=e.id);

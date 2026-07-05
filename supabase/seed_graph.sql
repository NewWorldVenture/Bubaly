-- ============================================================================
-- FamilyOS · SEED — Knowledge Graph (graph_entities 500 + graph_edges 500).
-- A connected household graph so traversal, path-finding and impact propagation
-- can be exercised at volume. Idempotent: clears its own '[seed:graph]' rows
-- (attributes marker) first — edges cascade from entities.
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0129 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_ids    uuid[];
  n int := 500;
  kinds text[] := array['person','activity','place','org','event','item','pet','topic','other'];
  people text[] := array['Emma','Noah','Liam','Olivia','Ava','Daniel','Sofia','Mia','Coach Rivera','Grandma'];
  acts   text[] := array['Soccer','Piano','Swim Team','Robotics','Ballet','Scouts','Chess Club','Art Class'];
  places text[] := array['Field','School','Studio','Pool','Library','Gym','Grandma''s House','Rec Center'];
  rels   text[] := array['plays','at','coached_by','member_of','needs','affects','parent_of','attends','owns','near'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  -- Clear prior seed (edges cascade on entity delete).
  delete from public.graph_entities where family_id = v_family and attributes->>'seed' = 'graph';

  -- 500 entities, cycling kinds + drawing readable names by kind.
  insert into public.graph_entities (family_id, kind, name, attributes)
  select v_family,
    kinds[1 + (g.i % array_length(kinds,1))],
    case kinds[1 + (g.i % array_length(kinds,1))]
      when 'person'   then people[1 + (g.i % array_length(people,1))]
      when 'activity' then acts[1 + (g.i % array_length(acts,1))]
      when 'place'    then places[1 + (g.i % array_length(places,1))]
      else initcap(kinds[1 + (g.i % array_length(kinds,1))])
    end || ' #' || g.i,
    '{"seed":"graph"}'::jsonb
  from generate_series(1, n) as g(i);

  -- Collect the freshly-seeded ids in stable order.
  select array_agg(id order by created_at, id) into v_ids
  from public.graph_entities where family_id = v_family and attributes->>'seed' = 'graph';

  -- 500 edges as a cyclic ring (node i -> next node; 500 -> 1). Guarantees every
  -- edge is valid (source <> target), unique, and the whole graph is connected so
  -- path-finding + impact propagation traverse end to end. Relations + weights vary.
  insert into public.graph_edges (family_id, source_id, target_id, relation, weight, attributes)
  select v_family,
    v_ids[g.i],
    v_ids[1 + (g.i % n)],                 -- i -> i+1, wrapping 500 -> 1
    rels[1 + (g.i % array_length(rels,1))],
    round((0.4 + (g.i % 6) * 0.1)::numeric, 2),
    '{"seed":"graph"}'::jsonb
  from generate_series(1, n) as g(i)
  on conflict (family_id, source_id, target_id, relation) do nothing;

  raise notice 'Knowledge Graph seeded % entities (+edges) for family %', n, v_family;
end $$;

-- Verify:
--   select kind, count(*) from graph_entities group by kind order by 2 desc;
--   select relation, count(*) from graph_edges group by relation order by 2 desc;

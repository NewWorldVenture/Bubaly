-- ============================================================================
-- Bubaly · SEED — Reasoning Insights (R2)  [seed:insights]
-- Shapes the Knowledge Graph so lib/reasoning/insights.ts::reasoningInsights (and
-- therefore the graph source now folded into the Calm inbox) produces every kind
-- of relationship insight at volume:
--   • a clearly-NAMED coordination hub ("North Field") with high degree AND high
--     downstream impact  → 'hub' + 'ripple' insights,
--   • ~24 unlinked nodes                                       → 'coverage' insight.
-- Volume: 500 generated entities + a named scenario core, ~540 edges — >500 each.
-- Idempotent: clears its own '[seed:insights]' rows first (edges cascade).
-- Where: Supabase → SQL Editor → paste → Run.  (Needs migration 0129 applied.)
-- ============================================================================
do $$
declare
  v_email  text := 'newworldventurellc@gmail.com';
  v_family uuid;
  v_hub    uuid;
  v_ids    uuid[];
  n int := 500;
  ring int := 476;   -- first `ring` generated nodes form a connected chain; rest are orphans
  kinds  text[] := array['activity','place','org','event','item','pet','topic','person'];
  acts   text[] := array['Soccer','Piano','Swim Team','Robotics','Ballet','Scouts'];
  events text[] := array['Game','Recital','Meet','Practice','Tournament','Rehearsal'];
  rels   text[] := array['at','affects','needs','attends','coached_by','member_of','near'];
begin
  select f.id into v_family
  from public.families f
  join public.family_members fm on fm.family_id = f.id
  join auth.users u on u.id = fm.user_id
  where lower(u.email) = lower(v_email) limit 1;
  if v_family is null then select id into v_family from public.families order by created_at limit 1; end if;
  if v_family is null then raise exception 'No families found.'; end if;

  delete from public.graph_entities where family_id = v_family and attributes->>'seed' = 'insights';

  -- The named hub — a place everything routes through. Readable so the Calm
  -- insight reads "North Field is a coordination hub".
  insert into public.graph_entities (family_id, kind, name, attributes)
  values (v_family, 'place', 'North Field', '{"seed":"insights","hub":true}'::jsonb)
  returning id into v_hub;

  -- 500 generated entities across kinds with readable names.
  insert into public.graph_entities (family_id, kind, name, attributes)
  select v_family,
    kinds[1 + (g.i % array_length(kinds,1))],
    case kinds[1 + (g.i % array_length(kinds,1))]
      when 'activity' then acts[1 + (g.i % array_length(acts,1))]
      when 'event'    then events[1 + (g.i % array_length(events,1))]
      else initcap(kinds[1 + (g.i % array_length(kinds,1))])
    end || ' #' || g.i,
    '{"seed":"insights"}'::jsonb
  from generate_series(1, n) as g(i);

  select array_agg(id order by created_at, id) into v_ids
  from public.graph_entities
  where family_id = v_family and attributes->>'seed' = 'insights'
    and coalesce((attributes->>'hub')::boolean, false) = false;

  -- (a) Connected directed chain over the first `ring` generated nodes.
  insert into public.graph_edges (family_id, source_id, target_id, relation, weight, attributes)
  select v_family, v_ids[g.i], v_ids[g.i + 1],
    rels[1 + (g.i % array_length(rels,1))],
    round((0.4 + (g.i % 6) * 0.1)::numeric, 2),
    '{"seed":"insights"}'::jsonb
  from generate_series(1, ring - 1) as g(i)
  on conflict (family_id, source_id, target_id, relation) do nothing;

  -- (b) Downstream impact: the hub AFFECTS 40 events → high degree AND high
  --     outgoing impact, so both the 'hub' and 'ripple' insights fire.
  insert into public.graph_edges (family_id, source_id, target_id, relation, weight, attributes)
  select v_family, v_hub, v_ids[g.i], 'affects',
    round((0.6 + (g.i % 4) * 0.1)::numeric, 2),
    '{"seed":"insights"}'::jsonb
  from generate_series(1, 40) as g(i)
  on conflict (family_id, source_id, target_id, relation) do nothing;

  -- (c) A couple of activities depend ON the hub (incoming), reinforcing it.
  insert into public.graph_edges (family_id, source_id, target_id, relation, weight, attributes)
  select v_family, v_ids[40 + g.i], v_hub, 'at', 0.9, '{"seed":"insights"}'::jsonb
  from generate_series(1, 4) as g(i)
  on conflict (family_id, source_id, target_id, relation) do nothing;

  -- Nodes v_ids[ring+1 .. n] (~24) are intentionally left unlinked (orphans).

  raise notice 'Reasoning insights seeded: hub + % entities + ~540 edges, family %', n, v_family;
end $$;

-- Verify:
--   select count(*) from graph_entities where attributes->>'seed'='insights';  -- >= 501
--   select count(*) from graph_edges   where attributes->>'seed'='insights';  -- >= 500
--   -- the hub's degree (should be ~44) and orphan count (~24):
--   select count(*) from graph_entities e where e.attributes->>'seed'='insights'
--     and not exists (select 1 from graph_edges g where g.source_id=e.id or g.target_id=e.id);

-- ============================================================
-- Migration 0349: one saved copy of a provider recipe per family
--
-- WHY. app/(app)/dashboard/recipes/discover/actions.ts dedupes "Save to vault"
-- by probing (family_id, source_provider, source_recipe_id) before it inserts.
-- 0054 indexed that triple but did NOT make it unique, so the probe is only ever
-- a best-effort look: two members tapping "Save to vault" on the same TheMealDB
-- recipe within the same second — or one member on a phone and a laptop — both
-- probe empty and both insert, and the vault carries two identical cards from
-- then on. Only the database can close that window. A check in a server action
-- is a check a second concurrent request steps straight over, and it is
-- side-steppable in a way a unique index is not.
--
-- WHY PARTIAL — read this before widening it. app/api/recipes/transform/route.ts
-- deliberately writes SEVERAL rows sharing (family_id, 'bubaly_ai', <vault
-- recipe id>): one per AI variant (healthier, cheaper, gluten-free) of the same
-- vault recipe. A blanket unique index on the triple would make the second
-- variant of any recipe fail with 23505 and silently kill that feature. Recipes
-- a family typed in by hand carry no source at all, so NULL is excluded too
-- (belt and braces — a NULL never conflicts in a unique index anyway, and
-- leaving them out keeps the index to the rows that need it).
--
-- Replay-safe: `drop index if exists` before `create unique index`, and nothing
-- here grants, revokes, deletes or alters a policy.
--
-- NOT APPLIED. Recorded for the owner to apply.
-- ============================================================

-- A family that ALREADY carries a duplicate pair (the defect above, before the
-- code fix landed) would make `create unique index` fail with Postgres's own
-- terse "could not create unique index … Key … is duplicated" and no hint as to
-- whose vault it is. Say which rows block it and stop there: collapsing them is
-- a data decision, not this migration's to make, because a stale copy may
-- already be a meal-vote option or sitting in a meal-plan slot and deleting it
-- would take that with it.
do $$
declare
  blockers text;
  n_groups int;
begin
  select count(*), string_agg(
           format('family_id=%s source_provider=%L source_recipe_id=%L (%s copies)',
                  family_id, source_provider, source_recipe_id, n),
           E'\n    ' order by family_id, source_provider, source_recipe_id)
    into n_groups, blockers
  from (
    select family_id, source_provider, source_recipe_id, count(*) as n
      from public.family_recipes
     where source_recipe_id is not null
       and source_provider is not null
       and source_provider <> 'bubaly_ai'
     group by family_id, source_provider, source_recipe_id
    having count(*) > 1
  ) d;

  if n_groups > 0 then
    raise exception
      'family_recipes already holds % duplicated provider recipe(s); resolve them before applying 0349:%    %',
      n_groups, E'\n', blockers
      using hint = 'Keep one row per group and delete the extra copies (check meal_plans / meal_vote_options first), then re-run this migration.';
  end if;
end $$;

drop index if exists public.uq_family_recipes_source;

create unique index uq_family_recipes_source
  on public.family_recipes (family_id, source_provider, source_recipe_id)
  where source_recipe_id is not null
    and source_provider is not null
    and source_provider <> 'bubaly_ai';

comment on index public.uq_family_recipes_source is
  'One saved copy per (family, provider, provider recipe id). Excludes source_provider = ''bubaly_ai'', which app/api/recipes/transform/route.ts uses for several AI variants of one vault recipe.';

-- ============================================================
-- Done! A second concurrent "Save to vault" now loses with 23505, which
-- saveDiscoveredRecipe re-probes and reports as "Already in your vault".
-- ============================================================

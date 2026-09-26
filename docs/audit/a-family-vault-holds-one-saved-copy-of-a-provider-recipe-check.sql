-- ── A family vault holds one saved copy of a provider recipe (0349) ──────────
--
-- "Save to vault" on Dashboard → Recipes → Discover
-- (app/(app)/dashboard/recipes/discover/actions.ts, `saveDiscoveredRecipe`)
-- asks one question before it writes — is (family_id, source_provider,
-- source_recipe_id) already in `family_recipes`? — and then inserts. 0054 put a
-- PLAIN index on that triple, so the question was only ever a look: two
-- members tapping Save on the same TheMealDB recipe, or one member on a phone
-- and a laptop, both probe empty, both insert, and the vault shows two
-- identical cards from then on.
--
-- `supabase/migrations/0349_one_saved_copy_of_a_provider_recipe_per_family.sql`
-- adds `uq_family_recipes_source`, a PARTIAL unique index on the triple
-- `where source_recipe_id is not null and source_provider is not null and
-- source_provider <> 'bubaly_ai'`. This file holds that migration. It is the
-- database half of tests/a-failed-vault-probe-does-not-save-a-second-copy.test.ts,
-- which runs without a database and can only model the 23505 it expects.
--
-- WHAT IT PROVES, as the `authenticated` role a PostgREST session runs under,
-- through the SAME insert `saveDiscoveredRecipe` sends (column for column —
-- `pg_temp.v349_save` below is that one statement and nothing else):
--
--   PART 1 (one connection, one transaction, rolled back)
--     1. a member's second save of a provider recipe already in the vault is
--        refused with 23505 NAMED `uq_family_recipes_source` — not merely
--        refused;
--     2. so is the SAME save by a second member of that family (the phone and
--        the laptop);
--     3. a copy cannot be manufactured by UPDATE either: repointing another
--        saved row's source_recipe_id onto the taken key is refused the same way;
--     4. the loser's re-probe (the `23505` branch of saveDiscoveredRecipe) finds
--        exactly one row, and it is the first save's — "Already in your vault"
--        points at a real card;
--     5. the two writers 0349's header says it must NOT reach still land twice:
--        several AI variants of one vault recipe sharing (family, 'bubaly_ai',
--        <vault recipe id>) — app/api/recipes/transform/route.ts — and
--        hand-typed recipes that carry no provider at all.
--
--   PART 2 (three connections, committed fixtures, cleaned up)
--     6. THE RACE the migration exists for, as an interleaving rather than a
--        timing: the phone probes (empty) and inserts, its request still in
--        flight; the laptop probes (STILL empty — this is the window) and
--        inserts; the laptop's insert is observed WAITING on the phone's
--        uncommitted row (`pg_blocking_pids` names the phone's backend, not
--        just "some lock"); the phone commits; the laptop's insert is refused
--        with 23505 on `uq_family_recipes_source`; one card. On a database
--        without 0349 the laptop's insert does not wait, lands, and the family
--        has two cards — which is the defect, reproduced.
--
-- ── THE NEGATIVE CONTROL, AND IT RUNS FIRST ─────────────────────────────────
-- Every refusal above is "a write by a member was refused", and that sentence
-- has many causes that are not this index: a missing or revoked table GRANT
-- (42501), a column-level revoke on `source_recipe_id` or `raw_payload`, a dead
-- `auth.uid()` making `is_family_member` false (42501 from the WITH CHECK), a
-- guard trigger — which is how this repository refuses writes in 0223, 0305,
-- 0326 and 0331 — or a unique index somebody later adds on another key. Any of
-- them would keep a bare "was it refused?" check green with 0349 dropped.
--
-- So before any refusal, THE SAME ACTORS run THE SAME STATEMENT with THE SAME
-- COLUMNS against a key that is free, and every one of them MUST LAND:
--
--   * the phone saves the recipe for the first time — the row the refusals
--     collide with is written BY THE MEMBER, not seeded as postgres, so the
--     probe cannot pass while members cannot save at all;
--   * the phone saves the same recipe with the PROVIDER RECIPE ID flipped,
--     into ANOTHER FAMILY it belongs to, and under ANOTHER PROVIDER — each leg
--     flips exactly one column of the key, which is also the proof that the
--     index is per family and per provider (a key missing `family_id` would
--     refuse the second household's save of a recipe the first one has);
--   * the laptop — the actor refused in (2) — saves a different recipe into
--     the same vault;
--   * the phone's UPDATE repoints a saved row onto a FREE key: the same UPDATE,
--     the same column, as the refusal in (3);
--   * PART 2 runs the identical three-connection interleaving with the laptop
--     saving a DIFFERENT recipe id, and both saves must land without the
--     laptop ever waiting.
--
-- If any control leg is refused, the probe raises "UNPROVEN" and stops: the
-- refusals below would then prove only that something said no. A revoke of
-- INSERT on family_recipes from authenticated, or an unconditional raising
-- trigger on the table, turns this file red AT THE CONTROL — that was checked
-- when the file was written, along with red-on-the-refusal against a database
-- that does not carry 0349. The refusals also require the index BY NAME
-- (`GET STACKED DIAGNOSTICS … CONSTRAINT_NAME`), so a 23505 from some other
-- unique index is reported, not credited.
--
-- ── WHY PART 2 COMMITS ──────────────────────────────────────────────────────
-- A second backend cannot see anything this session has not committed, so the
-- race's family, members and helper live outside a transaction. Its UUIDs are
-- its own (…a011–…a014), its rows are deleted before the seed (a run killed
-- halfway leaves nothing the next run trips on) and again after the race,
-- before any verdict is allowed to raise. The racers are never left open: a
-- racer whose insert waits is released by the phone's commit, and each racer
-- runs with `lock_timeout` so a wait that is never released is an error, not a
-- hung build. The race records its outcome and never raises; the verdict is
-- read afterwards.
--
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 \
--       -f docs/audit/a-family-vault-holds-one-saved-copy-of-a-provider-recipe-check.sql

-- ── Fixtures (UUIDs grepped unique across docs/audit and supabase/migrations) ─
-- PART 1, inside the transaction below and rolled back:
\set F   '00000000-0000-4000-8000-00000349a001'
\set UP  '00000000-0000-4000-8000-00000349a002'
\set UQ  '00000000-0000-4000-8000-00000349a003'
\set G   '00000000-0000-4000-8000-00000349a004'
\set MQ  '00000000-0000-4000-8000-00000349a005'
-- PART 2, committed and cleaned up:
\set FR  '00000000-0000-4000-8000-00000349a011'
\set RA  '00000000-0000-4000-8000-00000349a012'
\set RB  '00000000-0000-4000-8000-00000349a013'
\set MRB '00000000-0000-4000-8000-00000349a014'

-- ── The writers, defined ONCE ───────────────────────────────────────────────
-- Kept as text so the SAME definitions are installed in this session and sent
-- verbatim to each racer in PART 2: the control, the refusals and both racers
-- cannot drift onto different statements. Each returns what happened instead
-- of raising — `landed`, or the SQLSTATE and the constraint that refused it.
-- They are pg_temp functions, SECURITY INVOKER, so they write as whoever calls
-- them, through that caller's grants and RLS. They vanish with the session.
create temp table v349_def (ord int primary key, def text not null);

-- saveDiscoveredRecipe's insert, column for column
-- (app/(app)/dashboard/recipes/discover/actions.ts).
insert into v349_def values (1, $def$
create function pg_temp.v349_save(p_family uuid, p_provider text, p_recipe_id text, p_name text)
returns jsonb
language plpgsql
as $fn$
declare
  v_id uuid;
  v_constraint text;
begin
  insert into public.family_recipes
    (family_id, created_by, name, description, category, cuisine, photo_url, tags,
     ingredients, instructions, source_url, source_provider, source_recipe_id,
     attribution, license_notes, imported_at, raw_payload)
  values
    (p_family, auth.uid(), p_name, 'A sweet soy glaze over roast chicken.', 'dinner', 'Japanese',
     'https://img.example.com/teriyaki.jpg', array['Meat'],
     '[{"name":"Chicken","quantity":"2 pieces","unit":""}]'::jsonb,
     '[{"step":1,"text":"Preheat oven."},{"step":2,"text":"Bake."}]'::jsonb,
     'https://example.com/r', p_provider, p_recipe_id,
     'Recipe from ' || p_provider, 'Free for non-commercial use', now(),
     jsonb_build_object('idMeal', p_recipe_id, 'strMeal', p_name))
  returning id into v_id;
  return jsonb_build_object('landed', true, 'id', v_id);
exception when others then
  get stacked diagnostics v_constraint = constraint_name;
  return jsonb_build_object('landed', false, 'sqlstate', sqlstate,
                            'constraint', nullif(v_constraint, ''), 'message', sqlerrm);
end
$fn$
$def$);

-- The transform route's insert (app/api/recipes/transform/route.ts): one row
-- per AI variant, all sharing (family, 'bubaly_ai', <vault recipe id>).
insert into v349_def values (2, $def$
create function pg_temp.v349_variant(p_family uuid, p_vault_recipe uuid, p_action text)
returns jsonb
language plpgsql
as $fn$
declare
  v_id uuid;
  v_constraint text;
begin
  insert into public.family_recipes
    (family_id, created_by, name, description, category, cuisine, photo_url,
     ingredients, instructions, notes, tags, ai_generated,
     source_provider, source_recipe_id, attribution)
  values
    (p_family, auth.uid(), 'Lasagne (' || p_action || ')', 'An AI variant.', 'dinner', 'Italian', null,
     '[{"name":"Pasta","quantity":"250","unit":"g"}]'::jsonb,
     '[{"step":1,"text":"Layer and bake."}]'::jsonb,
     'Variant notes.', array['ai:' || p_action], true,
     'bubaly_ai', p_vault_recipe::text, format('AI variant (%s) of "Grandma''s Lasagne"', p_action))
  returning id into v_id;
  return jsonb_build_object('landed', true, 'id', v_id);
exception when others then
  get stacked diagnostics v_constraint = constraint_name;
  return jsonb_build_object('landed', false, 'sqlstate', sqlstate,
                            'constraint', nullif(v_constraint, ''), 'message', sqlerrm);
end
$fn$
$def$);

-- createRecipe's insert (lib/services/meals/index.ts): a hand-typed recipe, a
-- source_url perhaps, never a provider.
insert into v349_def values (3, $def$
create function pg_temp.v349_hand_typed(p_family uuid, p_id uuid, p_name text)
returns jsonb
language plpgsql
as $fn$
declare
  v_id uuid;
  v_constraint text;
begin
  insert into public.family_recipes
    (id, family_id, name, category, servings, difficulty, ingredients, instructions,
     tags, allergy_flags, source_url, ai_generated, created_by)
  values
    (coalesce(p_id, gen_random_uuid()), p_family, p_name, 'dinner', 4, 'medium',
     '[{"name":"Pasta","quantity":"500","unit":"g"}]'::jsonb, '["Layer.","Bake."]'::jsonb,
     '{}', '{}', 'https://example.com/grandma', false, auth.uid())
  returning id into v_id;
  return jsonb_build_object('landed', true, 'id', v_id);
exception when others then
  get stacked diagnostics v_constraint = constraint_name;
  return jsonb_build_object('landed', false, 'sqlstate', sqlstate,
                            'constraint', nullif(v_constraint, ''), 'message', sqlerrm);
end
$fn$
$def$);

-- A PATCH of one saved row's provider recipe id — no screen does this, but a
-- member's PostgREST session can, and the index answers for UPDATE too.
insert into v349_def values (4, $def$
create function pg_temp.v349_repoint(p_id uuid, p_recipe_id text)
returns jsonb
language plpgsql
as $fn$
declare
  n int;
  v_constraint text;
begin
  update public.family_recipes set source_recipe_id = p_recipe_id where id = p_id;
  get diagnostics n = row_count;
  return jsonb_build_object('landed', n = 1, 'rows', n);
exception when others then
  get stacked diagnostics v_constraint = constraint_name;
  return jsonb_build_object('landed', false, 'sqlstate', sqlstate,
                            'constraint', nullif(v_constraint, ''), 'message', sqlerrm);
end
$fn$
$def$);

select def from v349_def order by ord \gexec

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 1 — one connection, rolled back
-- ═══════════════════════════════════════════════════════════════════════════
begin;

-- Seeded as postgres. The phone parent (UP) belongs to two households, F and
-- G; the laptop parent (UQ) to F. `on_family_created` files each creator as a
-- parent already — upserted rather than assumed, because a seed whose
-- memberships are wrong would fail the control for a reason that is not the
-- control's.
insert into auth.users (id, email) values (:'UP', 'v349-phone-parent@example.com')  on conflict do nothing;
insert into auth.users (id, email) values (:'UQ', 'v349-laptop-parent@example.com') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'F', 'Vault House', :'UP')       on conflict do nothing;
insert into public.families (id, name, created_by) values (:'G', 'Grandma''s House', :'UP')  on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'F', :'UP', 'Phone Parent', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'G', :'UP', 'Phone Parent', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MQ', :'F', :'UQ', 'Laptop Parent', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;

do $p1$
declare
  fam     constant uuid := '00000000-0000-4000-8000-00000349a001';
  phone   constant uuid := '00000000-0000-4000-8000-00000349a002';
  laptop  constant uuid := '00000000-0000-4000-8000-00000349a003';
  gran    constant uuid := '00000000-0000-4000-8000-00000349a004';
  -- A hand-typed vault recipe the AI variants hang off. Written BY the member
  -- below, not seeded; this is only the id it is written with.
  lasagne constant uuid := '00000000-0000-4000-8000-00000349a006';
  r jsonb;
  first_copy uuid;
  movable    uuid;
  n int;
  probed uuid;
  failures text[] := '{}';
  control text[] := '{}';
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  -- ── NEGATIVE CONTROL: the same actors, the same statement, a free key ──────
  perform set_config('request.jwt.claim.sub', phone::text, true);

  -- The first save. The refusals below collide with THIS row, written by the
  -- member through the app's insert.
  r := pg_temp.v349_save(fam, 'themealdb', '52772', 'Teriyaki Chicken');
  if (r->>'landed')::boolean then
    first_copy := (r->>'id')::uuid;
  else
    control := array_append(control, format('the phone''s FIRST save of themealdb/52772 into its own vault was refused (%s on %s: %s)', r->>'sqlstate', coalesce(r->>'constraint', '-'), r->>'message'));
  end if;

  -- One column of the key flipped per leg.
  r := pg_temp.v349_save(fam, 'themealdb', '52773', 'Teriyaki Chicken');
  if (r->>'landed')::boolean then
    movable := (r->>'id')::uuid;
  else
    control := array_append(control, format('the phone''s save with source_recipe_id flipped (themealdb/52773) was refused (%s on %s: %s)', r->>'sqlstate', coalesce(r->>'constraint', '-'), r->>'message'));
  end if;

  r := pg_temp.v349_save(gran, 'themealdb', '52772', 'Teriyaki Chicken');
  if not (r->>'landed')::boolean then
    control := array_append(control, format('the phone''s save of themealdb/52772 into ANOTHER family it belongs to was refused (%s on %s: %s) — a key without family_id would do exactly this, and every second household would be told a recipe it never saved is "already in your vault"', r->>'sqlstate', coalesce(r->>'constraint', '-'), r->>'message'));
  end if;

  r := pg_temp.v349_save(fam, 'usda', '52772', 'Teriyaki Chicken');
  if not (r->>'landed')::boolean then
    control := array_append(control, format('the phone''s save of the same recipe id under ANOTHER provider (usda/52772) was refused (%s on %s: %s)', r->>'sqlstate', coalesce(r->>'constraint', '-'), r->>'message'));
  end if;

  -- The same UPDATE, the same column, as refusal (3), onto a free key.
  if movable is not null then
    r := pg_temp.v349_repoint(movable, '52774');
    if not (r->>'landed')::boolean then
      control := array_append(control, format('the phone''s UPDATE of a saved row onto a FREE key (themealdb/52774) did not land (%s)', r));
    end if;
  end if;

  -- The laptop, the actor refused in (2), saving a different recipe.
  perform set_config('request.jwt.claim.sub', laptop::text, true);
  r := pg_temp.v349_save(fam, 'themealdb', '52775', 'Beef Stroganoff');
  if not (r->>'landed')::boolean then
    control := array_append(control, format('the laptop''s save of a DIFFERENT recipe (themealdb/52775) into the same vault was refused (%s on %s: %s)', r->>'sqlstate', coalesce(r->>'constraint', '-'), r->>'message'));
  end if;

  -- Say WHY the probe cannot speak, while the reason is in hand. The statements
  -- below read a refusal as the index's; with the control down that reading is
  -- unsupported, so the boundary is reported as unproven — and the build is red.
  if array_length(control, 1) is not null then
    raise exception 'provider recipe dedupe (0349) UNPROVEN — the control this probe rests on did not hold, so a refusal below would prove only that something said no: %', array_to_string(control, ' | ');
  end if;

  -- ── The writers 0349 must leave alone ─────────────────────────────────────
  perform set_config('request.jwt.claim.sub', phone::text, true);

  r := pg_temp.v349_hand_typed(fam, lasagne, 'Grandma''s Lasagne');
  if not (r->>'landed')::boolean then
    failures := array_append(failures, format('a hand-typed recipe (no provider) was refused: %s', r));
  end if;
  r := pg_temp.v349_hand_typed(fam, null, 'Grandma''s Lasagne');
  if not (r->>'landed')::boolean then
    failures := array_append(failures, format('a SECOND hand-typed recipe of the same name (no provider) was refused — 0349 reached rows with no source: %s', r));
  end if;

  -- healthier, cheaper, and healthier AGAIN: all three share
  -- (fam, 'bubaly_ai', lasagne) and all three must land.
  r := pg_temp.v349_variant(fam, lasagne, 'healthier');
  if not (r->>'landed')::boolean then
    failures := array_append(failures, format('the first AI variant of a vault recipe was refused: %s', r));
  end if;
  r := pg_temp.v349_variant(fam, lasagne, 'cheaper');
  if not (r->>'landed')::boolean then
    failures := array_append(failures, format('the SECOND AI variant of one vault recipe was refused (%s on %s) — 0349''s bubaly_ai exemption does not hold and app/api/recipes/transform/route.ts is broken', r->>'sqlstate', coalesce(r->>'constraint', '-')));
  end if;
  r := pg_temp.v349_variant(fam, lasagne, 'healthier');
  if not (r->>'landed')::boolean then
    failures := array_append(failures, format('a repeated AI variant of one vault recipe was refused (%s on %s) — the transform route does not dedupe and must not be refused', r->>'sqlstate', coalesce(r->>'constraint', '-')));
  end if;

  -- ── The refusals 0349 introduces ──────────────────────────────────────────
  -- (1) The phone taps Save again.
  r := pg_temp.v349_save(fam, 'themealdb', '52772', 'Teriyaki Chicken');
  if (r->>'landed')::boolean then
    failures := array_append(failures, 'the phone''s SECOND save of themealdb/52772 LANDED — the vault now shows two Teriyaki Chicken cards');
  elsif r->>'sqlstate' <> '23505' or r->>'constraint' is distinct from 'uq_family_recipes_source' then
    failures := array_append(failures, format('the phone''s second save was refused, but not by uq_family_recipes_source (%s on %s: %s)', r->>'sqlstate', coalesce(r->>'constraint', '-'), r->>'message'));
  end if;

  -- (3) Repoint the row the control moved to 52774 onto the taken key.
  r := pg_temp.v349_repoint(movable, '52772');
  if (r->>'landed')::boolean then
    failures := array_append(failures, 'an UPDATE repointed a saved row onto themealdb/52772, which the vault already holds — a duplicate by PATCH');
  elsif r->>'sqlstate' is distinct from '23505' or r->>'constraint' is distinct from 'uq_family_recipes_source' then
    failures := array_append(failures, format('the repointing UPDATE was stopped, but not by uq_family_recipes_source: %s', r));
  end if;

  -- (2) The laptop saves the same recipe.
  perform set_config('request.jwt.claim.sub', laptop::text, true);
  r := pg_temp.v349_save(fam, 'themealdb', '52772', 'Teriyaki Chicken');
  if (r->>'landed')::boolean then
    failures := array_append(failures, 'the LAPTOP''s save of themealdb/52772, already in the family''s vault, LANDED — a second member makes the second card');
  elsif r->>'sqlstate' <> '23505' or r->>'constraint' is distinct from 'uq_family_recipes_source' then
    failures := array_append(failures, format('the laptop''s save was refused, but not by uq_family_recipes_source (%s on %s: %s)', r->>'sqlstate', coalesce(r->>'constraint', '-'), r->>'message'));
  end if;

  -- (4) The loser's re-probe, as the laptop, exactly as saveDiscoveredRecipe
  -- asks it after a 23505: one row, and it is the phone's first save.
  select count(*), min(id::text)::uuid into n, probed
    from public.family_recipes
   where family_id = fam and source_provider = 'themealdb' and source_recipe_id = '52772';
  if n <> 1 or probed is distinct from first_copy then
    failures := array_append(failures, format('the laptop''s re-probe for themealdb/52772 found %s row(s) (first save was %s, probe answered %s) — "Already in your vault" must point at the one real card', n, first_copy, probed));
  end if;

  -- The vault as postgres sees it, bypassing RLS.
  perform set_config('role', 'postgres', true);
  select count(*) into n from public.family_recipes
   where family_id = fam and source_provider = 'bubaly_ai' and source_recipe_id = lasagne::text;
  if n <> 3 then
    failures := array_append(failures, format('the vault holds %s AI variants of the lasagne, expected 3', n));
  end if;
  select count(*) into n from public.family_recipes
   where family_id = fam and source_provider is null and name = 'Grandma''s Lasagne';
  if n <> 2 then
    failures := array_append(failures, format('the vault holds %s hand-typed lasagnes, expected 2', n));
  end if;

  if array_length(failures, 1) is not null then
    raise exception 'provider recipe dedupe (0349) failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK family_recipes (0349): the same two members CAN save, re-key and cross-file provider recipes on a free key (control); a second copy of one (family, provider, recipe) is refused with 23505 on uq_family_recipes_source for either member and by UPDATE, and the re-probe finds the first; three AI variants of one vault recipe and two hand-typed recipes still land';
end
$p1$;

rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART 2 — the race, as an interleaving across three connections
-- ═══════════════════════════════════════════════════════════════════════════
create extension if not exists dblink;

-- Delete before seeding: a run killed halfway through PART 2 left these.
delete from public.family_recipes where family_id = '00000000-0000-4000-8000-00000349a011';
delete from public.families       where id        = '00000000-0000-4000-8000-00000349a011';
delete from auth.users            where id in ('00000000-0000-4000-8000-00000349a012',
                                               '00000000-0000-4000-8000-00000349a013');

-- Committed, so the racing connections can see them.
insert into auth.users (id, email) values (:'RA', 'v349-race-phone@example.com');
insert into auth.users (id, email) values (:'RB', 'v349-race-laptop@example.com');
insert into public.families (id, name, created_by) values (:'FR', 'Race Vault House', :'RA');
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FR', :'RA', 'Phone Parent', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MRB', :'FR', :'RB', 'Laptop Parent', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;

create temp table v349_race (
  stage     text primary key,
  a_probe   int,
  b_probe   int,
  a         jsonb,
  b         jsonb,
  b_waited  boolean,
  copies_a  int,
  copies_b  int,
  note      text
);

-- One stage of the race. RECORDS, never raises: the fixture cleanup below has
-- to run whatever happens here.
create function pg_temp.v349_race(p_stage text, p_recipe_a text, p_recipe_b text)
returns void
language plpgsql
as $fn$
declare
  fam    constant uuid := '00000000-0000-4000-8000-00000349a011';
  phone  constant uuid := '00000000-0000-4000-8000-00000349a012';
  laptop constant uuid := '00000000-0000-4000-8000-00000349a013';
  v_conn text;
  v_def  text;
  c      text;
  probe  constant text := 'select count(*)::int from public.family_recipes where family_id = %L and source_provider = %L and source_recipe_id = %L';
  a_probe int;
  b_probe int;
  ra jsonb;
  rb jsonb;
  a_pid int;
  b_pid int;
  waited boolean := false;
  ms int := 0;
  n_a int;
  n_b int;
begin
  v_conn := 'dbname=' || current_database()
    || ' host=' || split_part(current_setting('unix_socket_directories'), ',', 1)
    || ' port=' || current_setting('port')
    || ' user=' || current_user;

  perform dblink_connect('v349_a', v_conn || ' application_name=v349_phone');
  perform dblink_connect('v349_b', v_conn || ' application_name=v349_laptop');
  foreach c in array array['v349_a', 'v349_b'] loop
    -- The same writer definitions this session used, sent verbatim.
    for v_def in select def from v349_def order by ord loop
      perform dblink_exec(c, v_def);
    end loop;
    -- A wait nobody releases becomes an error, not a hung build.
    perform dblink_exec(c, 'set lock_timeout = ''20s''');
    perform dblink_exec(c, 'set role authenticated');
    perform dblink_exec(c, 'set "request.jwt.claim.role" = ''authenticated''');
  end loop;
  perform dblink_exec('v349_a', format('set "request.jwt.claim.sub" = %L', phone));
  perform dblink_exec('v349_b', format('set "request.jwt.claim.sub" = %L', laptop));
  select pid into a_pid from dblink('v349_a', 'select pg_backend_pid()') as t(pid int);
  select pid into b_pid from dblink('v349_b', 'select pg_backend_pid()') as t(pid int);

  -- 1. The phone probes: nothing saved yet.
  select n into a_probe from dblink('v349_a', format(probe, fam, 'themealdb', p_recipe_a)) as t(n int);
  -- 2. The phone inserts. Its request has not returned: the row is in flight.
  perform dblink_exec('v349_a', 'begin');
  select v into ra from dblink('v349_a',
    format('select pg_temp.v349_save(%L, %L, %L, %L)', fam, 'themealdb', p_recipe_a, 'Teriyaki Chicken')) as t(v jsonb);
  -- 3. The laptop probes. THE WINDOW: the phone's copy is not visible to it.
  select n into b_probe from dblink('v349_b', format(probe, fam, 'themealdb', p_recipe_b)) as t(n int);
  -- 4. The laptop inserts, asynchronously — with 0349 and the same key it
  --    blocks on the phone's uncommitted row.
  perform dblink_send_query('v349_b',
    format('select pg_temp.v349_save(%L, %L, %L, %L)', fam, 'themealdb', p_recipe_b, 'Teriyaki Chicken'));
  -- 5. Wait until the laptop is provably blocked BY THE PHONE's session — not
  --    by anything else — or has finished.
  loop
    exit when dblink_is_busy('v349_b') = 0;
    if a_pid = any(pg_blocking_pids(b_pid)) then
      waited := true;
      exit;
    end if;
    exit when ms >= 15000;
    perform pg_sleep(0.005);
    ms := ms + 5;
  end loop;
  -- 6. The phone's request returns.
  perform dblink_exec('v349_a', 'commit');
  -- 7. The laptop's answer.
  select v into rb from dblink_get_result('v349_b') as t(v jsonb);
  perform * from dblink_get_result('v349_b') as t(v jsonb);
  perform dblink_disconnect('v349_a');
  perform dblink_disconnect('v349_b');

  select count(*) into n_a from public.family_recipes
   where family_id = fam and source_provider = 'themealdb' and source_recipe_id = p_recipe_a;
  select count(*) into n_b from public.family_recipes
   where family_id = fam and source_provider = 'themealdb' and source_recipe_id = p_recipe_b;

  insert into v349_race (stage, a_probe, b_probe, a, b, b_waited, copies_a, copies_b, note)
  values (p_stage, a_probe, b_probe, ra, rb, waited, n_a, n_b, format('polled %sms', ms));
exception when others then
  -- The phone first: its disconnect rolls back the in-flight row and releases
  -- a laptop waiting on it.
  begin perform dblink_disconnect('v349_a'); exception when others then null; end;
  begin perform dblink_disconnect('v349_b'); exception when others then null; end;
  insert into v349_race (stage, note) values (p_stage, 'raised: ' || sqlstate || ' ' || sqlerrm)
  on conflict (stage) do update set note = excluded.note;
end
$fn$;

-- The control first: the laptop saves a DIFFERENT recipe in the same window.
-- Then the race itself: the same recipe.
do $run$
begin
  perform pg_temp.v349_race('control', '52850', '52851');
  perform pg_temp.v349_race('race',    '52772', '52772');
end
$run$;

-- Clean up before any verdict can raise.
delete from public.family_recipes where family_id = '00000000-0000-4000-8000-00000349a011';
delete from public.families       where id        = '00000000-0000-4000-8000-00000349a011';
delete from auth.users            where id in ('00000000-0000-4000-8000-00000349a012',
                                               '00000000-0000-4000-8000-00000349a013');

do $p2$
declare
  c record;
  r record;
  failures text[] := '{}';
begin
  -- ── The control ───────────────────────────────────────────────────────────
  select * into c from v349_race where stage = 'control';
  if not found or c.note like 'raised:%' then
    raise exception 'provider recipe race (0349) UNPROVEN — the control interleaving did not run: %', coalesce(c.note, 'no row recorded');
  end if;
  if c.a_probe <> 0 or c.b_probe <> 0
     or not coalesce((c.a->>'landed')::boolean, false)
     or not coalesce((c.b->>'landed')::boolean, false)
     or c.copies_a <> 1 or c.copies_b <> 1 then
    raise exception 'provider recipe race (0349) UNPROVEN — in the control, two members saving DIFFERENT recipes in the same window did not both land once each (phone probe=%, laptop probe=%, phone=%, laptop=%, copies=%/%), so the refusal in the race would prove only that the laptop could not save at all',
      c.a_probe, c.b_probe, c.a, c.b, c.copies_a, c.copies_b;
  end if;
  if c.b_waited then
    raise exception 'provider recipe race (0349) UNPROVEN — in the control the laptop''s save of a DIFFERENT recipe WAITED on the phone''s in-flight row, so a wait in the race would not be the index''s (phone=%, laptop=%)', c.a, c.b;
  end if;

  -- ── The race ──────────────────────────────────────────────────────────────
  select * into r from v349_race where stage = 'race';
  if not found or r.note like 'raised:%' then
    raise exception 'provider recipe race (0349) failed to run: %', coalesce(r.note, 'no row recorded');
  end if;
  if r.a_probe <> 0 or r.b_probe <> 0 then
    failures := array_append(failures, format('the window was not open: phone probe=%s, laptop probe=%s (both must see an empty vault, or this is not the race)', r.a_probe, r.b_probe));
  end if;
  if not coalesce((r.a->>'landed')::boolean, false) then
    failures := array_append(failures, format('the phone''s save — the winner — did not land: %s', r.a));
  end if;
  if coalesce((r.b->>'landed')::boolean, false) then
    failures := array_append(failures, format('BOTH saves landed: two members probed an empty vault and the family now has %s Teriyaki Chicken cards', r.copies_a));
  elsif r.b->>'sqlstate' is distinct from '23505' or r.b->>'constraint' is distinct from 'uq_family_recipes_source' then
    failures := array_append(failures, format('the laptop''s save was refused, but not by uq_family_recipes_source: %s', r.b));
  end if;
  if not r.b_waited and not coalesce((r.b->>'landed')::boolean, false) then
    failures := array_append(failures, 'the laptop''s insert was never seen waiting on the phone''s in-flight row, so this run did not exercise the race');
  end if;
  if r.copies_a <> 1 then
    failures := array_append(failures, format('after the race the vault holds %s copies of themealdb/52772, expected 1', r.copies_a));
  end if;

  if array_length(failures, 1) is not null then
    raise exception 'provider recipe race (0349) failed: %', array_to_string(failures, ' | ');
  end if;
  raise notice 'OK family_recipes race (0349): in the control two members save different recipes in one window and both land without waiting; saving the SAME recipe, both probe an empty vault, the laptop''s insert waits on the phone''s in-flight row and, once the phone commits, is refused with 23505 on uq_family_recipes_source — one card (%)', r.note;
end
$p2$;

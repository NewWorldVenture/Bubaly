-- ── A trip item stays with its trip's family (0503) ─────────────────────────
--
-- trip_items is manager-only to delete, and trip_item_content_guard lets only a
-- family manager change an item's content, family included, but it asks only
-- whether the caller manages the NEW family. The update policy is
-- is_family_member(family_id) on both halves, so a teen of Trip House who is a
-- parent of their own house moved Trip House's packing items there: a delete,
-- and a rewrite, they could not do directly. The held 0503 adds a move guard
-- (a manager of BOTH families) and binds trip_id to the item's own family with
-- 0311's reference_shares_family('trip_id', 'trips').
--
-- What this probe asserts, through PostgREST's role, each outcome matched
-- exactly (`OK <rows>`, or the SQLSTATE and the guard's own sentence):
--
--   1. control: the teen ticks an item done (OK 1);
--   2-4. the teen's move of an item into their own house is refused with the
--      move guard's sentence (42501) whether they relabel it, move only its
--      family, or take a trip of their own house with it; Trip House still
--      holds all three items, unchanged (counted);
--   5. control: a manager of BOTH families moves an item together with a trip
--      of the new family (OK 1, counted where it landed);
--   6. that manager's move that keeps Trip House's trip is refused by the
--      binding (42501, reference_shares_family's own sentence for
--      trip_items.trip_id);
--   7. that manager's insert of an item in Trip House naming the other
--      family's trip is refused the same way;
--   8. control: Trip House's parent files an item against its own trip (OK 1);
--   9. control: the service role (carrying the teen's user id, so only the
--      service-role branches can exempt it) and, separately,
--   10. a session-less writer (null auth.uid()) each move an item with the
--      other family's trip (OK 1 each, counted);
--   11. both triggers are wired exactly (the move guard BEFORE UPDATE OF
--      family_id; the binding BEFORE INSERT OR UPDATE OF trip_id, family_id
--      with ('trip_id', 'trips')), and the move guard is SECURITY DEFINER with
--      a pinned search_path;
--
-- and, only where 0503 is installed, each in a rolled-back subtransaction:
--
--   M1. MUTATION: the move guard without its old-family clause (the shape of
--       trip_item_content_guard) lets the teen's move with their own trip land;
--   N1. NEGATIVE CONTROL: with the move guard disabled, that move lands;
--   N2. NEGATIVE CONTROL: with the binding disabled, the manager's insert
--       naming the other family's trip lands.
--
-- Everything is rolled back.
--
-- HELD with 0503: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/trip-item-family-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0503 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8503-0000000000a1','t0503-parent@example.com'),
  ('00000000-0000-4000-8503-0000000000a2','t0503-teen@example.com'),
  ('00000000-0000-4000-8503-0000000000a3','t0503-own-house@example.com'),
  ('00000000-0000-4000-8503-0000000000a5','t0503-both@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8503-0000000000f1','Trip House','00000000-0000-4000-8503-0000000000a1'),
  ('00000000-0000-4000-8503-0000000000f2','The teen''s own house','00000000-0000-4000-8503-0000000000a3');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8503-0000000000a1','00000000-0000-4000-8503-0000000000a3');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8503-0000000000c2','00000000-0000-4000-8503-0000000000f1','00000000-0000-4000-8503-0000000000a2','Teen','teen',true),
  ('00000000-0000-4000-8503-0000000000c3','00000000-0000-4000-8503-0000000000f2','00000000-0000-4000-8503-0000000000a2','Teen (a parent here)','parent',true),
  ('00000000-0000-4000-8503-0000000000c5','00000000-0000-4000-8503-0000000000f1','00000000-0000-4000-8503-0000000000a5','Parent of both','parent',true),
  ('00000000-0000-4000-8503-0000000000c6','00000000-0000-4000-8503-0000000000f2','00000000-0000-4000-8503-0000000000a5','Parent of both','parent',true);
insert into public.trips (id, family_id, name) values
  ('00000000-0000-4000-8503-0000000000b1','00000000-0000-4000-8503-0000000000f1','Beach'),
  ('00000000-0000-4000-8503-0000000000b2','00000000-0000-4000-8503-0000000000f2','The teen''s own trip');
insert into public.trip_items (id, family_id, trip_id, label) values
  ('00000000-0000-4000-8503-0000000000e1','00000000-0000-4000-8503-0000000000f1','00000000-0000-4000-8503-0000000000b1','Sunscreen'),
  ('00000000-0000-4000-8503-0000000000e2','00000000-0000-4000-8503-0000000000f1','00000000-0000-4000-8503-0000000000b1','Tent'),
  ('00000000-0000-4000-8503-0000000000e3','00000000-0000-4000-8503-0000000000f1','00000000-0000-4000-8503-0000000000b1','Towels'),
  ('00000000-0000-4000-8503-0000000000e4','00000000-0000-4000-8503-0000000000f1','00000000-0000-4000-8503-0000000000b1','Snacks'),
  ('00000000-0000-4000-8503-0000000000e5','00000000-0000-4000-8503-0000000000f1','00000000-0000-4000-8503-0000000000b1','Maps'),
  ('00000000-0000-4000-8503-0000000000e6','00000000-0000-4000-8503-0000000000f1','00000000-0000-4000-8503-0000000000b1','Chargers'),
  ('00000000-0000-4000-8503-0000000000e7','00000000-0000-4000-8503-0000000000f1','00000000-0000-4000-8503-0000000000b1','Passports'),
  ('00000000-0000-4000-8503-0000000000e8','00000000-0000-4000-8503-0000000000f1','00000000-0000-4000-8503-0000000000b1','Hats');

-- As one signed-in user, run one statement and say exactly what happened.
create or replace function pg_temp.t0503_as(p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  return got;
end
$fn$;

do $$
declare
  trip_house constant uuid := '00000000-0000-4000-8503-0000000000f1';
  own_house  constant uuid := '00000000-0000-4000-8503-0000000000f2';
  beach      constant uuid := '00000000-0000-4000-8503-0000000000b1';
  own_trip   constant uuid := '00000000-0000-4000-8503-0000000000b2';
  parent     constant text := '00000000-0000-4000-8503-0000000000a1';
  teen       constant text := '00000000-0000-4000-8503-0000000000a2';
  both_mgr   constant text := '00000000-0000-4000-8503-0000000000a5';
  moved      constant text := '42501: A trip item can only be moved to another family by a manager of both families';
  bound      constant text := '42501: trip_items.trip_id points at a row in another family';
  installed  boolean := to_regprocedure('public.trip_item_family_change_guard()') is not null;
  failures   text[] := '{}';
  t          record;
  got        text;
  n          int;
begin
  -- 1. The teen ticks an item done.
  got := pg_temp.t0503_as(teen, format('update public.trip_items set is_done = true where id = %L', '00000000-0000-4000-8503-0000000000e1'));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the teen could not tick a packing item done (%s)', got));
  end if;

  -- 2-4. The teen's moves into their own house.
  for t in select * from (values
      ('00000000-0000-4000-8503-0000000000e1'::uuid, 'Sunscreen', 'relabelled', format('family_id = %L, label = %L', own_house, 'Nothing to pack')),
      ('00000000-0000-4000-8503-0000000000e2'::uuid, 'Tent',      'family only', format('family_id = %L', own_house)),
      ('00000000-0000-4000-8503-0000000000e3'::uuid, 'Towels',    'with a trip of their own house', format('family_id = %L, trip_id = %L', own_house, own_trip))
    ) as v(item, label, how, sets) loop
    got := pg_temp.t0503_as(teen, format('update public.trip_items set %s where id = %L', t.sets, t.item));
    if got is distinct from moved then
      failures := array_append(failures, format('a teen of Trip House moved a packing item (%s) into the family where they are a parent (%s)', t.how, got));
    end if;
  end loop;
  select count(*) into n from public.trip_items
   where family_id = trip_house and trip_id = beach
     and (id, label) in (('00000000-0000-4000-8503-0000000000e1'::uuid, 'Sunscreen'),
                         ('00000000-0000-4000-8503-0000000000e2'::uuid, 'Tent'),
                         ('00000000-0000-4000-8503-0000000000e3'::uuid, 'Towels'));
  if n <> 3 then
    failures := array_append(failures, format('Trip House holds %s of its three packing items, unchanged, after the teen''s moves', n));
  end if;

  -- 5. A manager of both families moves an item together with a trip there.
  got := pg_temp.t0503_as(both_mgr, format('update public.trip_items set family_id = %L, trip_id = %L where id = %L',
                                           own_house, own_trip, '00000000-0000-4000-8503-0000000000e4'));
  select count(*) into n from public.trip_items
   where id = '00000000-0000-4000-8503-0000000000e4' and family_id = own_house and trip_id = own_trip;
  if got is distinct from 'OK 1' or n <> 1 then
    failures := array_append(failures, format('CONTROL: a manager of both families could not move an item together with a trip of the new family (%s; %s rows there)', got, n));
  end if;

  -- 6. The same manager, keeping Trip House's trip.
  got := pg_temp.t0503_as(both_mgr, format('update public.trip_items set family_id = %L where id = %L',
                                           own_house, '00000000-0000-4000-8503-0000000000e5'));
  if got is distinct from bound then
    failures := array_append(failures, format('a manager of both families moved an item into the other family still naming Trip House''s trip (%s)', got));
  end if;

  -- 7. The same manager files an item in Trip House against the other family's trip.
  got := pg_temp.t0503_as(both_mgr, format('insert into public.trip_items (family_id, trip_id, label) values (%L, %L, %L)',
                                           trip_house, own_trip, 'Borrowed'));
  if got is distinct from bound then
    failures := array_append(failures, format('a manager filed a Trip House item against another family''s trip (%s)', got));
  end if;

  -- 8. Trip House's parent files an item against its own trip.
  got := pg_temp.t0503_as(parent, format('insert into public.trip_items (family_id, trip_id, label) values (%L, %L, %L)',
                                         trip_house, beach, 'Water'));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: Trip House''s parent could not file an item against its own trip (%s)', got));
  end if;

  -- 9. The service role, carrying a user id so auth.uid() is not null: only
  --    the service-role branches can exempt this move.
  begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claim.sub', teen, true);
    perform set_config('request.jwt.claims', json_build_object('sub', teen, 'role', 'service_role')::text, true);
    if auth.uid() is null then
      failures := array_append(failures, 'CONTROL (service role): auth.uid() is null, so this does not separate the service-role exemption from the null-uid one');
    end if;
    update public.trip_items set family_id = own_house, trip_id = own_trip where id = '00000000-0000-4000-8503-0000000000e6';
    get diagnostics n = row_count;
    perform set_config('role', 'postgres', true);
    if n <> 1 then
      failures := array_append(failures, format('CONTROL (service role): its move changed %s rows, not 1', n));
    end if;
  exception when others then
    perform set_config('role', 'postgres', true);
    failures := array_append(failures, format('CONTROL (service role): refused (%s: %s)', sqlstate, sqlerrm));
  end;

  -- 10. A session-less writer (a migration, seed or backfill): null auth.uid().
  begin
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    if auth.uid() is not null then
      failures := array_append(failures, 'CONTROL (session-less writer): auth.uid() is not null, so this is not the null-uid case');
    end if;
    update public.trip_items set family_id = own_house, trip_id = own_trip where id = '00000000-0000-4000-8503-0000000000e7';
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('CONTROL (session-less writer, null uid): its move changed %s rows, not 1', n));
    end if;
  exception when others then
    failures := array_append(failures, format('CONTROL (session-less writer, null uid): refused (%s: %s)', sqlstate, sqlerrm));
  end;
  select count(*) into n from public.trip_items
   where id in ('00000000-0000-4000-8503-0000000000e6', '00000000-0000-4000-8503-0000000000e7')
     and family_id = own_house and trip_id = own_trip;
  if n <> 2 then
    failures := array_append(failures, format('CONTROL: %s of the two exempt moves landed in the other family', n));
  end if;

  -- 11. Wiring.
  if not exists (
    select 1 from pg_trigger tr
     where tr.tgrelid = 'public.trip_items'::regclass
       and tr.tgname = 'trg_trip_item_family_change_guard'
       and tr.tgfoid = to_regprocedure('public.trip_item_family_change_guard()')
       and tr.tgenabled <> 'D'
       and (tr.tgtype & 2) = 2 and (tr.tgtype & 1) = 1 and (tr.tgtype & 16) = 16
       and (select array_agg(a.attname::text) from unnest(tr.tgattr) k
              join pg_attribute a on a.attrelid = tr.tgrelid and a.attnum = k) = array['family_id']) then
    failures := array_append(failures, 'trip_items carries no enabled BEFORE UPDATE OF family_id move guard');
  end if;
  if not exists (
    select 1 from pg_trigger tr
     where tr.tgrelid = 'public.trip_items'::regclass
       and tr.tgfoid = 'public.reference_shares_family()'::regprocedure
       and tr.tgenabled <> 'D'
       and (tr.tgtype & 2) = 2 and (tr.tgtype & 1) = 1 and (tr.tgtype & 4) = 4 and (tr.tgtype & 16) = 16
       and encode(tr.tgargs, 'escape') = E'trip_id\\000trips\\000'
       and (select array_agg(a.attname::text order by a.attname::text) from unnest(tr.tgattr) k
              join pg_attribute a on a.attrelid = tr.tgrelid and a.attnum = k) = array['family_id', 'trip_id']) then
    failures := array_append(failures, 'trip_items.trip_id is not bound to its own family by reference_shares_family');
  end if;
  if installed and not exists (select 1 from pg_proc f
                                where f.oid = to_regprocedure('public.trip_item_family_change_guard()')
                                  and f.prosecdef
                                  and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    failures := array_append(failures, 'the move guard is not SECURITY DEFINER with a pinned search_path');
  end if;

  if installed then
    -- M1. The move guard without its old-family clause.
    begin
      execute replace(pg_get_functiondef(to_regprocedure('public.trip_item_family_change_guard()')),
                      'public.can_manage_family(old.family_id) and ', '');
      got := pg_temp.t0503_as(teen, format('update public.trip_items set family_id = %L, trip_id = %L where id = %L',
                                           own_house, own_trip, '00000000-0000-4000-8503-0000000000e8'));
      if got is distinct from 'OK 1' then
        failures := array_append(failures, format('MUTATION M1: without the old-family clause the teen''s move still did not land (%s), so the refusal is not that clause''s', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- N1. With the move guard disabled, the teen's move lands. (Each negative
    -- control needs its trigger; a missing one is already the wiring line.)
    if exists (select 1 from pg_trigger where tgrelid = 'public.trip_items'::regclass
                  and tgname = 'trg_trip_item_family_change_guard') then
    begin
      alter table public.trip_items disable trigger trg_trip_item_family_change_guard;
      got := pg_temp.t0503_as(teen, format('update public.trip_items set family_id = %L, trip_id = %L where id = %L',
                                           own_house, own_trip, '00000000-0000-4000-8503-0000000000e8'));
      if got is distinct from 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the move guard disabled the teen''s move did not land (%s), so this fixture cannot see the defect', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
    end if;

    -- N2. With the binding disabled, the manager's insert against the other family's trip lands.
    if exists (select 1 from pg_trigger where tgrelid = 'public.trip_items'::regclass
                  and tgname = 'trg_trip_items_trip_id_family') then
    begin
      alter table public.trip_items disable trigger trg_trip_items_trip_id_family;
      got := pg_temp.t0503_as(both_mgr, format('insert into public.trip_items (family_id, trip_id, label) values (%L, %L, %L)',
                                               trip_house, own_trip, 'Borrowed'));
      if got is distinct from 'OK 1' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the binding disabled the manager''s insert against another family''s trip did not land (%s)', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
    end if;
  end if;
  perform set_config('role', 'postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'a trip item can leave its trip''s family:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-trip-item-stays-with-its-trips-family: OK (a teen of Trip House who is a parent of their own house still ticks an item done (OK 1), and their moves of a packing item into their own house, relabelled, family only, or with a trip of their own house, were each refused with the move guard''s own sentence (42501, exact); Trip House holds all three items unchanged; a manager of both families moved an item together with a trip of the new family (OK 1), and their move keeping Trip House''s trip and their insert against the other family''s trip were each refused with reference_shares_family''s own sentence for trip_items.trip_id; Trip House''s parent files against its own trip (OK 1); the service role (with a user id) and, separately, a null-uid session-less writer each moved an item (1 row each); both triggers are wired exactly; mutation M1 and negative controls N1 and N2 each let the refused write land)';
end $$;

rollback;

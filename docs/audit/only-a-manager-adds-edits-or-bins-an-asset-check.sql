-- ── An asset is a manager's record; the service date is everyone's (0336) ───
--
-- 0004_rls.sql gave `home_assets` the role-blind four — SELECT/INSERT/UPDATE/
-- DELETE all `is_family_member(family_id)`. components/modules/home-module.tsx
-- disagrees three times over: `const manager = isManager(role)` (:79) hides
-- "Add Asset" (:207), hides the per-asset delete button (:344), and renders the
-- warranty_until field `disabled={!manager}` with Save hidden (:467-468). There
-- is no server action for any of those three writes — they go from the browser
-- on the caller's own client — so a hidden button was the entire boundary, and
-- a child with a real login went past all three with one request to
-- /rest/v1/home_assets.
--
-- The fix is deliberately NOT a blanket manager-only rule, and this probe's
-- job is as much to prove that as to prove the boundary. Two legitimate
-- non-manager writers update this table on their own client with no role gate:
-- saveServiceRecordAction (app/(app)/dashboard/home/actions.ts:129), reached
-- from /dashboard/home/service which is requirePlanLevel(1) only, and
-- lib/services/home/index.ts:367 behind the AI tool home.createServiceRecord,
-- which ROLE_DEFAULTS grants to `child`. Both move `last_serviced_on`. A
-- manager-only UPDATE would have 42501'd every child who logs a service visit.
--
-- Asserts, in both directions:
--
--   1. a child CANNOT add an asset — home-module.tsx:207 says so and now the
--      database does;
--   2. a child CANNOT delete one. `home_assets` has no `deleted_at`, so this
--      is a hard delete, and documents.asset_id is ON DELETE CASCADE (0007) —
--      the asset's uploaded manual goes with it;
--   3. a child CANNOT change warranty_until, the field the app disables for
--      them — nor any other descriptive field (name/brand/purchase_price);
--   4. a child CAN still write last_serviced_on, which is what logging a
--      service visit does. A boundary that stops the honest caller is the
--      wrong boundary;
--   5. a MANAGER can still insert, edit and delete — the positive control;
--   6. reads stay `is_family_member`: a child still sees the household's
--      assets, which is what /dashboard/home and the twin render;
--   7. `anon` holds no INSERT (0290's argument);
--   8. NEGATIVE CONTROL: drop ONLY the three new guards and require all three
--      escalations to succeed again.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubalyv \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/only-a-manager-adds-edits-or-bins-an-asset-check.sql

\set FA '00000000-0000-4000-8000-0000000a55e0'
\set UP '00000000-0000-4000-8000-0000000a55e1'
\set UK '00000000-0000-4000-8000-0000000a55e2'
\set AP '00000000-0000-4000-8000-0000000a55e5'
\set DM '00000000-0000-4000-8000-0000000a55e6'

begin;

insert into auth.users (id, email) values (:'UP','a55-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','a55-kid@example.com')    on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FA','Asset House',:'UP') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-0000000a55e3',:'FA',:'UP','Parent','parent',true) on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-0000000a55e4',:'FA',:'UK','Kid','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FA' and user_id = :'UP';

-- The furnace the parent added, and the manual filed against it.
insert into public.home_assets (id, family_id, name, category, brand, purchase_price, warranty_until, last_serviced_on, created_by)
  values (:'AP', :'FA', 'Parent Furnace', 'appliance', 'Carrier', 4200.00, '2030-01-01', '2026-01-01', :'UP');
insert into public.documents (id, family_id, title, storage_path, asset_id, category)
  values (:'DM', :'FA', 'Furnace manual', 'fam/a55/manual.pdf', :'AP', 'manual');

grant select, insert, update, delete on public.home_assets to authenticated;

do $$
declare
  n   int;
  txt text;
  failures text[] := '{}';
  fam      constant uuid := '00000000-0000-4000-8000-0000000a55e0';
  parent_u constant uuid := '00000000-0000-4000-8000-0000000a55e1';
  kid_u    constant uuid := '00000000-0000-4000-8000-0000000a55e2';
  asset    constant uuid := '00000000-0000-4000-8000-0000000a55e5';
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- Sanity: the actor really is a non-manager member, so a refusal below is
  -- the guard talking and not a broken fixture.
  if not public.is_family_member(fam) then
    failures := array_append(failures, 'fixture broken: the child is not seen as a family member at all');
  end if;
  if public.can_manage_family(fam) then
    failures := array_append(failures, 'fixture broken: the child is seen as a MANAGER — every assertion below is meaningless');
  end if;

  -- 1. The forged asset. home-module.tsx:207 hides Add Asset from this caller.
  begin
    insert into public.home_assets (family_id, name, category, brand, purchase_price, created_by)
      values (fam, 'CHILD FORGED Gaming PC', 'appliance', 'Forged', 9999.99, kid_u);
    failures := array_append(failures, 'a child ADDED a home asset — /dashboard/home, the asset detail page, the twin, the purchases advisor and AI insights all render it as a real household asset');
  exception when insufficient_privilege then null;
  end;

  -- 3. The manager-only field. The app disables this input for a child.
  begin
    update public.home_assets set warranty_until = '1999-01-01' where id = asset;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a child rewrote warranty_until on %s asset(s) — the field home-module.tsx renders disabled={!manager}', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3b. and the rest of the record with it.
  begin
    update public.home_assets set name = 'FORGED', purchase_price = 1.00 where id = asset;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a child rewrote the name and price of %s asset(s)', n));
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. The honest caller. saveServiceRecordAction and the AI tool both do
  --    exactly this, on the caller's own client, with no role gate anywhere.
  begin
    update public.home_assets set last_serviced_on = '2026-09-20' where id = asset;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('a child could not log a service visit: last_serviced_on updated %s row(s), expected 1 — saveServiceRecordAction and home.createServiceRecord are now broken for every child', n));
    end if;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child was REFUSED the last_serviced_on write — this is the CENSUS-002 mistake: /dashboard/home/service is requirePlanLevel(1) with no role check, so every child logging a service visit would 500');
  end;

  -- 6. Reads are untouched, deliberately.
  select count(*) into n from public.home_assets where id = asset;
  if n <> 1 then
    failures := array_append(failures, 'a child can no longer READ the household''s assets — /dashboard/home and the twin render them for whoever is signed in; that would be a change of decision, not this migration''s');
  end if;

  -- 2. The hard delete, and what cascades with it.
  select count(*) into n from public.documents where asset_id = asset;
  if n <> 1 then
    failures := array_append(failures, 'fixture broken: the manual was not filed against the asset, so the cascade assertion proves nothing');
  end if;
  begin
    delete from public.home_assets where id = asset;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, format('a child DELETED %s asset(s) — there is no deleted_at on this table, so it is permanent', n));
    end if;
  exception when insufficient_privilege then null;
  end;
  perform set_config('role','postgres', true);
  select count(*) into n from public.documents where asset_id = asset;
  if n <> 1 then
    failures := array_append(failures, 'the asset''s manual was cascaded away by a child''s delete (documents.asset_id is ON DELETE CASCADE, 0007)');
  end if;

  -- 5. The positive control: the manager still runs the feature.
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.home_assets (id, family_id, name, category, created_by)
      values ('00000000-0000-4000-8000-0000000a55e7', fam, 'Parent Water Heater', 'appliance', parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not add an asset — the guard is too tight to run the feature');
  end;
  begin
    update public.home_assets set warranty_until = '2031-06-01', name = 'Parent Furnace II' where id = asset;
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('a MANAGER edited %s asset(s), expected 1 — the field guard refuses its own manager', n));
    end if;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER was refused an asset edit — the field guard refuses its own manager');
  end;
  begin
    delete from public.home_assets where id = '00000000-0000-4000-8000-0000000a55e7';
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('a MANAGER deleted %s asset(s), expected 1', n));
    end if;
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not delete an asset');
  end;

  -- 7. The grant layer, which a `to authenticated` policy cannot reach.
  perform set_config('role','postgres', true);
  if has_table_privilege('anon', 'public.home_assets', 'INSERT') then
    failures := array_append(failures, 'anon holds INSERT on home_assets');
  end if;

  -- ── Negative control: prove this probe can SEE the defect ────────────────
  -- Remove ONLY what 0336 added, leaving 0004's policies as they were, and
  -- require all three escalations to work again. The outer rollback undoes
  -- this along with everything else.
  drop policy  if exists home_assets_manager_insert_guard on public.home_assets;
  drop policy  if exists home_assets_manager_delete_guard on public.home_assets;
  drop trigger if exists trg_home_asset_manager_field_guard on public.home_assets;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  begin
    insert into public.home_assets (id, family_id, name, category, brand, purchase_price, created_by)
      values ('00000000-0000-4000-8000-0000000a55e8', fam, 'CHILD FORGED Gaming PC', 'appliance', 'Forged', 9999.99, kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'with 0336''s guards removed the child STILL could not add an asset — this probe''s INSERT half is decoration, not a boundary');
  end;

  begin
    update public.home_assets set warranty_until = '1999-01-01' where id = asset;
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.home_assets where id = asset;
  exception when insufficient_privilege then null;
  end;

  perform set_config('role','postgres', true);

  select count(*) into n from public.home_assets where id = '00000000-0000-4000-8000-0000000a55e8';
  if n = 0 then
    failures := array_append(failures, 'with the guards removed no forged asset landed — the INSERT half of this probe has never been shown to fail');
  end if;

  select count(*) into n from public.home_assets where id = asset;
  if n <> 0 then
    failures := array_append(failures, 'with the guards removed the child''s DELETE still did nothing — the DELETE half of this probe has never been shown to fail');
  end if;

  select count(*) into n from public.documents where asset_id = asset;
  if n <> 0 then
    failures := array_append(failures, 'with the guards removed the manual survived the child''s delete — the ON DELETE CASCADE this migration cites does not behave as described');
  end if;

  -- The warranty forgery is asserted on a row that the delete above removed,
  -- so re-run it on a surviving one to show the field guard was doing work.
  insert into public.home_assets (id, family_id, name, warranty_until, created_by)
    values ('00000000-0000-4000-8000-0000000a55e9', fam, 'Control Fridge', '2030-01-01', parent_u);
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  begin
    update public.home_assets set warranty_until = '1999-01-01'
     where id = '00000000-0000-4000-8000-0000000a55e9';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role','postgres', true);
  select warranty_until::text into txt from public.home_assets
   where id = '00000000-0000-4000-8000-0000000a55e9';
  if txt is distinct from '1999-01-01' then
    failures := array_append(failures, format('with the field guard removed the child STILL could not rewrite warranty_until (it reads %s) — the UPDATE half of this probe has never been shown to fail', coalesce(txt,'null')));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'home_assets does not match the rule the app states:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'only-a-manager-adds-edits-or-bins-an-asset: OK (a child cannot add, delete or re-describe an asset, can still log a service visit, still reads the household''s assets; a manager runs the whole feature; anon holds no INSERT; negative control reproduced all three escalations)';
end $$;

rollback;

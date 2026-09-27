-- ── Only a released app installs (SRV-001 l8, 0420) ─────────────────────────
--
-- HOLDS: supabase/migrations/0420_only_a_released_app_installs.sql
--
-- A family member, with their own JWT over /rest/v1, could install an app the
-- catalogue says is coming soon or retired: 0165's install policies are
-- is_family_member(family_id) and nothing else. This probe proves, as that
-- member:
--
--   1. a PUBLISHED and a BETA app install (a guard that refuses everything is
--      not a boundary);
--   2. a COMING-SOON and a RETIRED app are refused with 42501, and nothing is
--      written;
--   3. an existing install cannot be re-pointed at a coming-soon app;
--   4. an install whose app has since moved to coming-soon can still be
--      REMOVED — the removal path the UI keeps open;
--   5. the catalogue carries exactly the two RESTRICTIVE guards, on INSERT and
--      UPDATE, and none on DELETE;
--   6. NEGATIVE CONTROL, last: with ONLY the two guards dropped, the same
--      coming-soon install lands — so 2 was the guards.
--
-- Fixtures are seeded as postgres inside one transaction and rolled back.

\set U  '00000000-0000-4000-8420-0000000000a1'
\set F  '00000000-0000-4000-8420-0000000000f1'

begin;

insert into auth.users (id, email) values (:'U','m0420-parent@example.com') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'F','Released App House',:'U') on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'F' and user_id = :'U';

insert into public.family_apps (slug, name, status) values
  ('m0420-published', 'Published app', 'published'),
  ('m0420-beta',      'Beta app',      'beta'),
  ('m0420-soon',      'Coming app',    'coming_soon'),
  ('m0420-retired',   'Retired app',   'retired'),
  ('m0420-later',     'App that goes back to coming soon', 'published'),
  -- One unreleased app per step that installs or re-points, so no step's
  -- outcome depends on another's (a unique (family, app) pair would).
  ('m0420-repoint',   'Coming app, re-point target', 'coming_soon'),
  ('m0420-control',   'Coming app, negative control', 'coming_soon');

do $$
declare
  fam uuid := '00000000-0000-4000-8420-0000000000f1';
  uid uuid := '00000000-0000-4000-8420-0000000000a1';
  pub uuid; beta uuid; soon uuid; retired uuid; later uuid; repoint uuid; control uuid;
  inst uuid;
  n int;
  failures text[] := '{}';
begin
  select id into pub     from public.family_apps where slug = 'm0420-published';
  select id into beta    from public.family_apps where slug = 'm0420-beta';
  select id into soon    from public.family_apps where slug = 'm0420-soon';
  select id into retired from public.family_apps where slug = 'm0420-retired';
  select id into later   from public.family_apps where slug = 'm0420-later';
  select id into repoint from public.family_apps where slug = 'm0420-repoint';
  select id into control from public.family_apps where slug = 'm0420-control';

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);

  -- ── 1. Released apps install ───────────────────────────────────────────────
  begin
    insert into public.family_app_installs (family_id, app_id) values (fam, pub) returning id into inst;
    insert into public.family_app_installs (family_id, app_id) values (fam, beta);
    insert into public.family_app_installs (family_id, app_id) values (fam, later);
  exception when others then
    failures := array_append(failures, format('CONTROL: a member could not install a published or beta app (%s) — the guard refuses everything', sqlerrm));
  end;

  -- ── 2. Unreleased apps are refused ────────────────────────────────────────
  begin
    insert into public.family_app_installs (family_id, app_id) values (fam, soon);
    failures := array_append(failures, 'a member installed a COMING-SOON app');
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.family_app_installs (family_id, app_id) values (fam, retired);
    failures := array_append(failures, 'a member installed a RETIRED app');
  exception when insufficient_privilege then null;
  end;

  -- ── 3. An install cannot be re-pointed at an unreleased app ──────────────
  begin
    update public.family_app_installs set app_id = repoint where id = inst;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, 'a member re-pointed an install at a COMING-SOON app'); end if;
  exception when insufficient_privilege then null;
  end;

  -- ── 4. An app moved back to coming-soon can still be removed ─────────────
  perform set_config('role','postgres', true);
  update public.family_apps set status = 'coming_soon' where id = later;
  perform set_config('role','authenticated', true);
  delete from public.family_app_installs where family_id = fam and app_id = later;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('an install of an app now coming soon could not be removed (%s rows) — the family is stuck with it', n)); end if;
  perform set_config('role','postgres', true);

  select count(*) into n from public.family_app_installs where family_id = fam and app_id in (soon, retired, repoint);
  if n <> 0 then failures := array_append(failures, format('%s install(s) of unreleased apps exist after the refusals', n)); end if;

  -- ── 5. Catalogue ──────────────────────────────────────────────────────────
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'family_app_installs'
     and permissive = 'RESTRICTIVE'
     and policyname in ('family_app_installs_released_insert_guard', 'family_app_installs_released_update_guard');
  if n <> 2 then failures := array_append(failures, format('%s of the 2 released-app guards are present and RESTRICTIVE', n)); end if;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'family_app_installs'
     and permissive = 'RESTRICTIVE' and cmd = 'DELETE';
  if n <> 0 then failures := array_append(failures, 'a RESTRICTIVE delete guard exists on family_app_installs — removing a stranded install must stay open'); end if;

  -- ── 6. Negative control: the guards alone ────────────────────────────────
  drop policy if exists family_app_installs_released_insert_guard on public.family_app_installs;
  drop policy if exists family_app_installs_released_update_guard on public.family_app_installs;
  perform set_config('role','authenticated', true);
  begin
    insert into public.family_app_installs (family_id, app_id) values (fam, control);
  exception when others then
    failures := array_append(failures, format('with the guards dropped the coming-soon install was still refused (%s) — step 2 was not shown to be the guards', sqlerrm));
  end;
  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'an unreleased app installs:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'only-a-released-app-installs: OK (a member installs a published and a beta app; a coming-soon and a retired app are refused with 42501 and nothing is written; an install cannot be re-pointed at an unreleased app; an install whose app went back to coming soon can still be removed; exactly two RESTRICTIVE guards, on insert and update, none on delete; negative control: with the guards dropped the coming-soon install lands)';
end $$;

rollback;

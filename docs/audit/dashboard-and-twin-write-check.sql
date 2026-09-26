-- ── The dashboard settings, the layouts and the digital twin (0325) ────────
--
-- Three tables, two rules. `family_digital_twin_profiles` (0022) and
-- `family_dashboard_settings` (0195) are manager surfaces: the first is named
-- in lib/family/actions.ts's MANAGER_ONLY set and gated again by `canManage()`
-- in lib/services/memory/index.ts, the second has exactly one writer,
-- `saveDashboardSettingsAction`, which opens `if (!isManager(ctx.active.role))`.
--
-- `dashboard_layouts` is NOT, and that is the point of testing it here rather
-- than stamping it with the others. In the same file,
-- `saveFamilyDefaultLayoutAction` and `resetAllLayoutsAction` are manager-only
-- while `saveDashboardLayoutAction` and `resetDashboardLayoutAction` are gated
-- by `canCustomizeDashboard(isManager(role), settings)` — a family may leave
-- personal customization open to children on purpose. The table separates the
-- two itself: `scope='family'` with a NULL `user_id` is the family default,
-- `scope='user'` with the signed-in user's id is a personal layout. So the rule
-- is scope-shaped, and this probe asserts the PERMISSION as loudly as the
-- refusal — a guard that took a teen's own home screen away would pass a
-- one-directional test and fail the product.
--
-- Asserts, in both directions:
--
--   1. a child cannot write, retarget or delete a digital-twin profile — the
--      row holding `ai_insights`, `strengths` and `stress_baseline` that
--      `loadFamilyContext` hands to every AI surface;
--   2. a child cannot flip `allow_child_customization` or
--      `lock_to_family_default` — the two flags `canCustomizeDashboard()`
--      itself reads, so writing them is not breaking the rule, it is turning
--      the rule off;
--   3. a child CAN still save, change and delete their OWN `scope='user'`
--      layout row (the positive control that matters most here);
--   4. a child CANNOT write the `scope='family'` default, cannot promote their
--      own row to it, and cannot touch another member's personal row;
--   5. a manager still can, on all three, including clearing everyone's
--      personal layouts the way `resetAllLayoutsAction` does;
--   6. reads are untouched on all three — ai-home-dashboard.tsx reads BOTH
--      scopes for the whole family in one query and picks the caller's row
--      client-side, `familyDashSettings()` reads the settings on the caller's
--      client before deciding whether a save is allowed, and the digital-twin
--      page renders every member's profile to every member. If any of these
--      lines fails, SELECT was narrowed and a page went blank;
--   7. UPDATE pins `family_id` on BOTH sides;
--   8. `anon` holds no INSERT on any of the three (0290's argument);
--   9. NEGATIVE CONTROL: drop the restrictive guards, leaving the original
--      permissive policies exactly as they were, and require every escalation
--      to succeed again.
--
-- RLS is evaluated BEFORE a unique index, so an insert that reaches a
-- constraint violation is one RLS LET THROUGH; those are reported as breaches
-- rather than swallowed.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/dashboard-and-twin-write-check.sql

\set FD '00000000-0000-4000-8000-00000000db10'
\set FE '00000000-0000-4000-8000-00000000db11'
\set UP '00000000-0000-4000-8000-00000000db12'
\set UK '00000000-0000-4000-8000-00000000db13'
\set US '00000000-0000-4000-8000-00000000db14'
\set UO '00000000-0000-4000-8000-00000000db15'

begin;

insert into auth.users (id, email) values (:'UP','db-parent@example.com')  on conflict do nothing;
insert into auth.users (id, email) values (:'UK','db-kid@example.com')     on conflict do nothing;
insert into auth.users (id, email) values (:'US','db-sibling@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UO','db-other@example.com')   on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FD','Dash House',:'UP') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FE','Other House',:'UO') on conflict do nothing;

insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000db16',:'FD',:'UK','Kid','child',true) on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000db17',:'FD',:'US','Sibling','child',true) on conflict do nothing;
-- A third member with no login, so the parent's positive-control insert below
-- can never collide with a row the child planted in the negative control.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000db1b',:'FD',null,'Toddler','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FD' and user_id = :'UP';
update public.family_members set role = 'parent' where family_id = :'FE' and user_id = :'UO';

-- What Bubaly believes about the sibling, and hands to every AI surface.
insert into public.family_digital_twin_profiles (id, family_id, member_id, strengths, notes, ai_insights, stress_baseline)
  values ('00000000-0000-4000-8000-00000000db18', :'FD', '00000000-0000-4000-8000-00000000db17',
          'Patient, good with little ones', 'Struggles with mornings', 'Best focus time is early evening', 30);

-- A parent has switched child customization OFF and locked the family default.
insert into public.family_dashboard_settings (family_id, allow_child_customization, lock_to_family_default, updated_by)
  values (:'FD', false, true, :'UP');

-- The family default, and one personal layout per child.
insert into public.dashboard_layouts (id, family_id, user_id, scope, device_context, feature_keys, created_by, updated_by)
  values ('00000000-0000-4000-8000-00000000db19', :'FD', null, 'family', 'all', array['chores','calendar'], :'UP', :'UP');
insert into public.dashboard_layouts (id, family_id, user_id, scope, device_context, feature_keys, created_by, updated_by)
  values ('00000000-0000-4000-8000-00000000db1a', :'FD', :'US', 'user', 'all', array['missions'], :'US', :'US');

grant select, insert, update, delete on public.family_digital_twin_profiles to authenticated;
grant select, insert, update, delete on public.family_dashboard_settings    to authenticated;
grant select, insert, update, delete on public.dashboard_layouts            to authenticated;

do $$
declare
  n int;
  flag boolean;
  failures text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-00000000db10';
  other_fam constant uuid := '00000000-0000-4000-8000-00000000db11';
  parent_u  constant uuid := '00000000-0000-4000-8000-00000000db12';
  kid_u     constant uuid := '00000000-0000-4000-8000-00000000db13';
  sib_u     constant uuid := '00000000-0000-4000-8000-00000000db14';
  kid_m     constant uuid := '00000000-0000-4000-8000-00000000db16';
  sib_m     constant uuid := '00000000-0000-4000-8000-00000000db17';
  tot_m     constant uuid := '00000000-0000-4000-8000-00000000db1b';
  twin      constant uuid := '00000000-0000-4000-8000-00000000db18';
  fam_lay   constant uuid := '00000000-0000-4000-8000-00000000db19';
  sib_lay   constant uuid := '00000000-0000-4000-8000-00000000db1a';
  t text;
  managed constant text[] := array['family_digital_twin_profiles','family_dashboard_settings'];
  tbls    constant text[] := array['family_digital_twin_profiles','family_dashboard_settings','dashboard_layouts'];
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. The digital twin.
  update public.family_digital_twin_profiles
     set ai_insights = 'Should be allowed to stay up late', stress_baseline = 99
   where id = twin;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child rewrote %s digital-twin profile(s) — the brief every AI surface answers from', n)); end if;

  delete from public.family_digital_twin_profiles where id = twin;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s digital-twin profile(s)', n)); end if;

  begin
    insert into public.family_digital_twin_profiles (family_id, member_id, ai_insights, strengths)
      values (fam, kid_m, 'Extremely responsible, needs no supervision', 'Everything');
    failures := array_append(failures, 'a child WROTE their own digital-twin profile');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s family_digital_twin_profiles INSERT reached the unique index, so RLS did not refuse it');
  end;

  -- 2. The settings that ARE the permission.
  update public.family_dashboard_settings
     set allow_child_customization = true, lock_to_family_default = false
   where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child flipped %s dashboard settings row(s) — the flags canCustomizeDashboard() itself reads', n)); end if;

  delete from public.family_dashboard_settings where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s dashboard settings row(s), which restores the permissive defaults', n)); end if;

  -- 3. The layout that IS theirs. This must keep working.
  begin
    insert into public.dashboard_layouts (family_id, user_id, scope, device_context, feature_keys, created_by, updated_by)
      values (fam, kid_u, 'user', 'all', array['missions','wallet'], kid_u, kid_u);
  exception
    when insufficient_privilege then
      failures := array_append(failures, 'a MEMBER could not save their OWN dashboard layout — the guard blanket-restricted a table the product leaves open');
    when unique_violation then
      failures := array_append(failures, 'a member''s own dashboard_layouts INSERT hit the unique index — the fixture is wrong, not the boundary');
  end;

  update public.dashboard_layouts set feature_keys = array['wallet'] where family_id = fam and user_id = kid_u and scope = 'user';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('a MEMBER could not change their OWN layout (%s rows) — that is the feature, not the defect', n)); end if;

  delete from public.dashboard_layouts where family_id = fam and user_id = kid_u and scope = 'user';
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('a MEMBER could not reset their OWN layout (%s rows)', n)); end if;

  -- 4. The layout that is NOT theirs.
  update public.dashboard_layouts set feature_keys = array['nothing'] where id = fam_lay;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child rewrote %s FAMILY-DEFAULT layout(s) — every member without a personal layout inherits it', n)); end if;

  delete from public.dashboard_layouts where id = fam_lay;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s family-default layout(s)', n)); end if;

  update public.dashboard_layouts set feature_keys = array['chores'] where id = sib_lay;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child rewrote %s OTHER member''s personal layout(s)', n)); end if;

  begin
    insert into public.dashboard_layouts (family_id, user_id, scope, device_context, feature_keys)
      values (fam, null, 'family', 'mobile', array['missions']);
    failures := array_append(failures, 'a child SET the family-default layout');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s scope=family INSERT reached the unique index, so RLS did not refuse it');
  end;

  -- The promotion: take a row that is legitimately mine and make it everyone's.
  begin
    insert into public.dashboard_layouts (family_id, user_id, scope, device_context, feature_keys, created_by, updated_by)
      values (fam, kid_u, 'user', 'tablet', array['missions'], kid_u, kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MEMBER could not save their own tablet layout');
  end;
  -- The row IS reachable (it is theirs), so a correct guard refuses this at the
  -- WITH CHECK half and raises rather than filtering. Both outcomes are a pass;
  -- a row actually changed is not.
  begin
    update public.dashboard_layouts set scope = 'family', user_id = null
     where family_id = fam and user_id = kid_u and device_context = 'tablet';
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child PROMOTED %s of their own layouts to the family default — WITH CHECK is missing', n)); end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Reads stay open, deliberately. Recorded so the decision is visible.
  select count(*) into n from public.family_digital_twin_profiles where id = twin;
  if n = 0 then failures := array_append(failures, 'a child can no longer READ digital-twin profiles — that is a change of decision; update finalaudit.md and this probe'); end if;
  select count(*) into n from public.family_dashboard_settings where family_id = fam;
  if n = 0 then failures := array_append(failures, 'a child can no longer READ dashboard settings — canCustomizeDashboard() reads them on the caller''s own client and would fall back to the permissive defaults'); end if;
  select count(*) into n from public.dashboard_layouts where family_id = fam and scope = 'family';
  if n = 0 then failures := array_append(failures, 'a child can no longer READ the family-default layout — ai-home-dashboard.tsx would render the tier default instead'); end if;

  -- ── As the parent: the positive control ─────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  update public.family_digital_twin_profiles set ai_insights = 'Thrives with a checklist' where id = twin;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not update a digital-twin profile — the guard refuses everyone'); end if;

  begin
    insert into public.family_digital_twin_profiles (family_id, member_id, strengths, created_by)
      values (fam, tot_m, 'Tidy', parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not add a digital-twin profile');
  end;

  update public.family_dashboard_settings set allow_child_customization = true where family_id = fam;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not change the dashboard settings'); end if;

  update public.dashboard_layouts set feature_keys = array['chores','calendar','wallet'] where id = fam_lay;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not set the family-default layout'); end if;

  -- resetAllLayoutsAction: a manager clears every member's personal layout.
  delete from public.dashboard_layouts where family_id = fam and scope = 'user';
  get diagnostics n = row_count;
  if n = 0 then failures := array_append(failures, 'a MANAGER could not reset the family''s personal layouts (resetAllLayoutsAction)'); end if;

  -- ── The WITH CHECK half: a manager may not relocate a row ───────────────
  begin
    update public.family_digital_twin_profiles set family_id = other_fam where id = twin;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, 'a manager MOVED a digital-twin profile into another family — WITH CHECK is missing');
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.dashboard_layouts set family_id = other_fam where id = fam_lay;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, 'a manager MOVED the family-default layout into another family — WITH CHECK is missing');
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── The grant layer, which `to authenticated` guards cannot reach ───────
  perform set_config('role','postgres', true);
  foreach t in array tbls loop
    if has_table_privilege('anon', 'public.' || t, 'INSERT') then
      failures := array_append(failures,
        format('anon holds INSERT on %s — the 0325 guards are `to authenticated` and would not apply', t));
    end if;
  end loop;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Drop only the restrictive guards; 0022's, 0195's and 0022's permissive
  -- "Members manage …" policies are left exactly as they were, which is the
  -- pre-0325 state. Every escalation must work again.
  foreach t in array managed loop
    execute format('drop policy if exists %I on public.%I', t || '_manager_insert_guard', t);
    execute format('drop policy if exists %I on public.%I', t || '_manager_update_guard', t);
    execute format('drop policy if exists %I on public.%I', t || '_manager_delete_guard', t);
  end loop;
  drop policy if exists dashboard_layouts_scope_insert_guard on public.dashboard_layouts;
  drop policy if exists dashboard_layouts_scope_update_guard on public.dashboard_layouts;
  drop policy if exists dashboard_layouts_scope_delete_guard on public.dashboard_layouts;

  -- Re-arm the parent's decision, which the positive control above relaxed.
  update public.family_dashboard_settings
     set allow_child_customization = false, lock_to_family_default = true
   where family_id = fam;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  update public.family_digital_twin_profiles set ai_insights = 'Should be allowed to stay up late' where id = twin;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with the original policy alone the child STILL could not rewrite a digital-twin profile — this probe is decoration, not a boundary');
  end if;

  update public.family_dashboard_settings set allow_child_customization = true, lock_to_family_default = false where family_id = fam;
  get diagnostics n = row_count;
  select allow_child_customization into flag from public.family_dashboard_settings where family_id = fam;
  if n = 0 or flag is not true then
    failures := array_append(failures, 'with 0195''s policy alone the child STILL could not turn child customization back on — this probe has never been shown to fail');
  end if;

  update public.dashboard_layouts set feature_keys = array['nothing'] where id = fam_lay;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with the original policy alone the child STILL could not rewrite the family-default layout — the scope assertion above is decoration');
  end if;

  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'the dashboard and the digital twin are not written by the right people:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'dashboard-and-twin-write: OK (twin + settings are manager-only, a member keeps their own scope=user layout and cannot reach the family default or another member''s, manager allowed, reads untouched, anon holds no INSERT, negative control reproduced all three escalations)';
end $$;

rollback;

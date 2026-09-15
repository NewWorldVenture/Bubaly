-- Behavioural proof for 0302 AND for 0297, run as real `authenticated` sessions
-- under RLS. Two sessions found the child_logins half independently and 0297
-- landed first, keeping the policy's name and re-predicating it; 0302 covers
-- behavior_logs. This probe asserts both halves whichever migration supplied
-- them, which is the right shape for a boundary check: it tests the boundary,
-- not the file that drew it.
--
-- child_logins carried a policy literally called "Managers manage child_logins"
-- whose predicate was `is_family_member(family_id)` for ALL commands. A child
-- could delete a SIBLING's row, removing that sibling's ability to sign in (the
-- sign-in lookup is `select … from child_logins where username = …`) and
-- blanking the parent's /dashboard/family-access view.
--
-- behavior_logs — "behaviour notes about children" in the repo's own
-- SENSITIVE_TABLES — let the child a note is about edit or delete it.
--
-- Both keep what they should: the parent's family-access SELECT still works
-- (it is the only authenticated-session use of child_logins; every write goes
-- through the service role), and a member can still record a behaviour note and
-- correct their own.
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam         uuid := 'ffff2222-0000-4000-8000-00000000000f';
  parent_uid  uuid := 'f2000000-0000-4000-8000-000000000001';
  child_uid   uuid := 'f2000000-0000-4000-8000-000000000002';
  sibling_uid uuid := 'f2000000-0000-4000-8000-000000000003';
  child_mid   uuid;
  sibling_mid uuid;
  parent_note uuid;
  child_note  uuid;
  n           int;
  v_note      text;
  blocked     boolean;
begin
  delete from public.behavior_logs where family_id = fam;
  delete from public.child_logins where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, child_uid, sibling_uid);
  delete from public.families where id = fam;

  insert into public.families (id, name) values (fam, 'Access') on conflict do nothing;
  insert into auth.users (id, email) values
    (parent_uid, 'fp@example.test'), (child_uid, 'fc@example.test'), (sibling_uid, 'fs@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, sibling_uid, 'Sibling', 'child', true) returning id into sibling_mid;

  -- Both logins are created by the SERVICE ROLE in the real app, so seed them
  -- the same way — as the bootstrap superuser, before any role is assumed.
  insert into public.child_logins (family_id, member_id, user_id, username, created_by)
  values (fam, child_mid, child_uid, 'accesskid', parent_uid),
         (fam, sibling_mid, sibling_uid, 'accesssib', parent_uid);

  -- As the PARENT: a note about the child, and the fixture.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  insert into public.behavior_logs (family_id, member_id, kind, note, points, logged_by)
  values (fam, child_mid, 'concern', 'Shouted at their sibling', -5, parent_uid)
  returning id into parent_note;

  -- The parent's family-access read, which is the only authenticated-session
  -- use of child_logins in the app.
  select count(*) into n from public.child_logins where family_id = fam;
  if n <> 2 then
    raise exception 'a parent can no longer read the family logins (%)', n;
  end if;

  -- ── As the CHILD ─────────────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 1. Cannot delete a sibling's login. This is the denial of service.
  delete from public.child_logins where username = 'accesssib';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a sibling''s login';
  end if;

  -- 2. Nor rewrite one, nor mint one.
  update public.child_logins set username = 'stolen' where username = 'accesssib';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child rewrote a sibling''s login';
  end if;
  blocked := false;
  begin
    insert into public.child_logins (family_id, member_id, user_id, username)
    values (fam, child_mid, child_uid, 'minted');
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child inserted a child_logins row';
  end if;

  -- 3. Cannot edit or delete the parent's note about them.
  update public.behavior_logs set note = 'Was an angel', points = 5 where id = parent_note;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child rewrote a behaviour note about themselves';
  end if;
  delete from public.behavior_logs where id = parent_note;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a behaviour note about themselves';
  end if;
  reset role;
  select note into v_note from public.behavior_logs where id = parent_note;
  if v_note <> 'Shouted at their sibling' then
    raise exception 'the note now reads %', v_note;
  end if;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 4. …but may still record one, and correct their own.
  insert into public.behavior_logs (family_id, member_id, kind, note, logged_by)
  values (fam, child_mid, 'positive', 'Tidied the kitchen', child_uid) returning id into child_note;
  update public.behavior_logs set note = 'Tidied the whole kitchen' where id = child_note;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a member can no longer correct the note they wrote (%)', n;
  end if;

  reset role;
  raise notice 'OK access records: a sibling''s login and a parent''s behaviour note are not a child''s to touch; the parent''s family-access read and a member''s own note both still work';
end $$;

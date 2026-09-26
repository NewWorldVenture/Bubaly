-- Behavioural proof for 0333, run as real `authenticated` sessions under RLS.
--
-- Guardian screens a family member's incoming calls and texts. Two tables decide
-- what gets through:
--
--   guardian_contacts         a caller's trust_level — `blocked` … `immediate_family`
--   guardian_member_profiles  how each member's calls route: default modes per
--                             trust level, the current context, the number
--
-- Both carried ONE policy, `FOR ALL … is_family_member(family_id)`, from 01370.
-- Every server action that writes them checks `isManager` first — but PostgREST
-- is reachable with the same JWT, so those checks were a UI boundary and not a
-- database one. As a child, before 0333:
--
--     update guardian_contacts set trust_level = 'immediate_family' where …; -> UPDATE 1
--     update guardian_member_profiles set default_mode_unknown = 'immediate_ring';
--                                                                        -> UPDATE 1
--
-- The first lets a number a parent flagged as a scam ring straight through; the
-- second turns screening off for unknown callers entirely. The protection could be
-- switched off by the person it protects.
--
-- The probe asserts what each role may STILL do, too: a child still READS their
-- contacts and their own routing (a screening rule nobody can see is not one), and
-- a parent still writes both.
grant usage on schema public to authenticated;

do $$
declare
  fam        uuid := 'eeee0000-0000-4000-8000-00000000000e';
  parent_uid uuid := 'e0000000-0000-4000-8000-000000000001';
  child_uid  uuid := 'e0000000-0000-4000-8000-000000000002';
  child_mid  uuid;
  scam       uuid;
  prof       uuid;
  n          int;
  v_trust    text;
  v_mode     text;
  blocked    boolean;
begin
  delete from public.guardian_member_profiles where family_id = fam;
  delete from public.guardian_contacts where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, child_uid);
  delete from public.families where id = fam;

  insert into public.families (id, name) values (fam, 'Screened') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'gp@example.test'), (child_uid, 'gc@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;

  -- ── As the PARENT: the fixture, and the positive control ──────────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  insert into public.guardian_contacts (family_id, name, phone, trust_level)
  values (fam, 'Known scam line', '+12025550199', 'blocked') returning id into scam;
  insert into public.guardian_member_profiles (family_id, member_id, default_mode_unknown)
  values (fam, child_mid, 'ai_handle_first') returning id into prof;

  -- A parent can still change both — the fix must not take the feature away.
  update public.guardian_contacts set notes = 'Reported by the bank' where id = scam;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a parent can no longer edit a Guardian contact (%)', n; end if;
  update public.guardian_member_profiles set current_context = 'normal' where id = prof;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'a parent can no longer edit a member''s routing (%)', n; end if;

  -- ── As the CHILD ─────────────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 1. Cannot promote a blocked caller. Before 0333: UPDATE 1.
  update public.guardian_contacts set trust_level = 'immediate_family' where id = scam;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child promoted a blocked caller to immediate_family'; end if;
  reset role;
  select trust_level into v_trust from public.guardian_contacts where id = scam;
  if v_trust <> 'blocked' then raise exception 'the scam line now reads % rather than blocked', v_trust; end if;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 2. Cannot delete the contact that blocks it.
  delete from public.guardian_contacts where id = scam;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child deleted the contact that blocks a scam line'; end if;

  -- 3. Cannot add a trusted contact of their own choosing.
  blocked := false;
  begin
    insert into public.guardian_contacts (family_id, name, phone, trust_level)
    values (fam, 'Not really grandma', '+12025550123', 'immediate_family');
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'a child inserted a contact with immediate_family trust'; end if;

  -- 4. Cannot turn off screening for unknown callers on their own profile.
  update public.guardian_member_profiles set default_mode_unknown = 'immediate_ring' where id = prof;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child turned off screening for unknown callers'; end if;
  reset role;
  select default_mode_unknown into v_mode from public.guardian_member_profiles where id = prof;
  if v_mode <> 'ai_handle_first' then raise exception 'unknown callers now route as % rather than ai_handle_first', v_mode; end if;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 5. Cannot take the number off their own profile, or delete the profile.
  update public.guardian_member_profiles set guardian_phone = null where id = prof;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child cleared the Guardian number from their own profile'; end if;
  delete from public.guardian_member_profiles where id = prof;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'a child deleted their own Guardian routing profile'; end if;

  -- 6. …but still SEES both. A screening rule nobody can see is not one.
  select count(*) into n from public.guardian_contacts where family_id = fam;
  if n <> 1 then raise exception 'a child can no longer read the family''s Guardian contacts (%)', n; end if;
  select count(*) into n from public.guardian_member_profiles where id = prof;
  if n <> 1 then raise exception 'a child can no longer read their own Guardian routing (%)', n; end if;

  -- ── No stray permissive write policy survives ────────────────────────────
  reset role;
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename in ('guardian_contacts', 'guardian_member_profiles')
     and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL') and permissive = 'PERMISSIVE'
     and coalesce(qual, '') !~ 'can_manage_family' and coalesce(with_check, '') !~ 'can_manage_family';
  if n <> 0 then raise exception '% permissive write policy(ies) on the Guardian tables do not require a manager', n; end if;

  delete from public.guardian_member_profiles where family_id = fam;
  delete from public.guardian_contacts where family_id = fam;
  delete from public.family_members where family_id = fam;
  delete from public.families where id = fam;
  raise notice 'OK: a child cannot promote a caller, add a trusted contact, or turn off their own screening; members still read both; a parent still writes both.';
end $$;

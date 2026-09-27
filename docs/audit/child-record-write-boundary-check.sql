-- Behavioural proof for 0300, run as real `authenticated` sessions under RLS.
--
-- `screen_time_limits` and `grades` each carried ONE `FOR ALL … is_family_member`
-- policy, and both are written directly from the browser. Neither module has a
-- role gate of any kind, so the UI was not even claiming a boundary — there
-- simply was none. As a child, before 0300:
--     update grades set grade='A', score=98;            -> UPDATE 1
--     update screen_time_limits set daily_minutes=1440; -> UPDATE 1
--
-- The two get DIFFERENT rules, and this probe asserts both, including what each
-- deliberately still allows:
--
--   screen_time_limits  writes are a manager's; a child still READS their limit
--   grades              any member may RECORD one; only its author or a manager
--                       may rewrite it
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam        uuid := 'bbbb0000-0000-4000-8000-00000000000b';
  parent_uid uuid := 'b0000000-0000-4000-8000-000000000001';
  child_uid  uuid := 'b0000000-0000-4000-8000-000000000002';
  child_mid  uuid;
  parent_grade uuid;
  child_grade  uuid;
  n          int;
  v_grade    text;
  v_minutes  int;
  blocked    boolean;
begin
  delete from public.grades where family_id = fam;
  delete from public.screen_time_limits where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, child_uid);
  delete from public.families where id = fam;

  insert into public.families (id, name) values (fam, 'School') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'sp@example.test'), (child_uid, 'sc@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;

  -- ── As the PARENT: the fixture and the positive control ──────────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  insert into public.grades (family_id, member_id, subject, grade, score, created_by)
  values (fam, child_mid, 'Math', 'D', 55, parent_uid) returning id into parent_grade;
  insert into public.screen_time_limits (family_id, member_id, daily_minutes, created_by)
  values (fam, child_mid, 60, parent_uid);

  -- ── As the CHILD ─────────────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 1. Cannot rewrite the grade a parent recorded. Before 0300: UPDATE 1.
  update public.grades set grade = 'A', score = 98 where id = parent_grade;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child rewrote a grade their parent recorded';
  end if;
  -- …and it really is unchanged, not merely unmatched.
  reset role;
  select grade into v_grade from public.grades where id = parent_grade;
  if v_grade <> 'D' then
    raise exception 'the grade now reads % rather than D', v_grade;
  end if;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 2. Cannot delete it either.
  delete from public.grades where id = parent_grade;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a grade their parent recorded';
  end if;

  -- 3. A member may still RECORD a grade, and correct their OWN entry. Making
  --    this manager-only would take a feature away to fix a different problem.
  insert into public.grades (family_id, member_id, subject, grade, created_by)
  values (fam, child_mid, 'Chemistry', 'B', child_uid) returning id into child_grade;
  update public.grades set grade = 'B+' where id = child_grade;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a member can no longer correct the grade they entered (%)', n;
  end if;

  -- 4. Cannot raise their own screen-time limit. Before 0300: UPDATE 1.
  update public.screen_time_limits set daily_minutes = 1440 where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child raised their own screen-time limit';
  end if;
  blocked := false;
  begin
    insert into public.screen_time_limits (family_id, member_id, daily_minutes)
    values (fam, child_mid, 1440);
  exception when insufficient_privilege then blocked := true;
       when unique_violation then blocked := true;
  end;
  if not blocked then
    raise exception 'a child inserted their own screen-time limit';
  end if;

  -- 5. …but still SEES it. A limit nobody can see is not a limit.
  select daily_minutes into v_minutes from public.screen_time_limits where family_id = fam;
  if v_minutes is distinct from 60 then
    raise exception 'a child can no longer read their own limit (%)', v_minutes;
  end if;

  -- ── No stray permissive write policy survives ────────────────────────────
  reset role;
  select count(*) into n
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public'
    and c.relname in ('screen_time_limits','grades')
    and p.polpermissive and p.polcmd in ('a','w','d','*')
    and p.polname not in (
      'screen_time_limits_mng_insert','screen_time_limits_mng_update','screen_time_limits_mng_delete',
      'grades_insert','grades_author_or_manager_update','grades_author_or_manager_delete'
    );
  if n <> 0 then
    raise exception '% stray permissive write policy(ies) on grades/screen_time_limits', n;
  end if;

  raise notice 'OK child records: a parent''s grade and a child''s limit are not the child''s to rewrite; recording a grade and correcting your own still work';
end $$;

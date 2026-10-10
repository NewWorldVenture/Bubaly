-- ── A child's XP is awarded by a parent, not by the child ──────────────────
--
-- 0354 made kid_progress a manager's to write ("a child could simply write
-- their own level 50 and every badge"), and a child's direct UPDATE now changes
-- nothing. 0341's two SECURITY DEFINER award functions, which RLS does not
-- reach, still admitted `is_family_member`, so the same child could call
-- kid_progress_apply_completion for themselves with any XP, or
-- kid_progress_revert_completion with any streak. The held 0496 makes their
-- caller check 0354's: a manager, or the service role.
--
-- What this probe asserts, through the real functions:
--
--   1. a child calling kid_progress_apply_completion for themselves is refused
--      ('forbidden') and their row does not move;
--   2. the same child's kid_progress_revert_completion is refused and their
--      streak does not move;
--   3. a teen (a member who is not a manager) is refused the same way;
--   4. control: a parent's award lands, as approveSubmissionAction's does;
--   5. control: the service path (no auth.uid, the auto-approve payout) lands;
--   6. control: an award for another family's child is still refused;
--   7. the functions stay SECURITY DEFINER and admit no bare is_family_member.
--
-- NEGATIVE CONTROL. Inside this transaction the apply function's check is put
-- back to 0341's `is_family_member`, and the child's self-award must then land.
-- That proves the fixture can see the defect. Everything is rolled back.
--
-- HELD with 0496: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/kid-progress-award-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0496 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8496-0000000000a1','m0496-parent@example.com'),
  ('00000000-0000-4000-8496-0000000000c1','m0496-kid@example.com'),
  ('00000000-0000-4000-8496-0000000000e1','m0496-teen@example.com'),
  ('00000000-0000-4000-8496-0000000000b1','m0496-other@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8496-0000000000f1','XP House','00000000-0000-4000-8496-0000000000a1'),
  ('00000000-0000-4000-8496-0000000000f2','Other XP House','00000000-0000-4000-8496-0000000000b1')
  on conflict do nothing;
update public.family_members set role = 'parent', is_active = true
 where family_id = '00000000-0000-4000-8496-0000000000f1' and user_id = '00000000-0000-4000-8496-0000000000a1';
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8496-0000000000d1','00000000-0000-4000-8496-0000000000f1','00000000-0000-4000-8496-0000000000c1','Kid','child',true),
  ('00000000-0000-4000-8496-0000000000d3','00000000-0000-4000-8496-0000000000f1','00000000-0000-4000-8496-0000000000e1','Teen','teen',true),
  ('00000000-0000-4000-8496-0000000000d2','00000000-0000-4000-8496-0000000000f2',null,'Other Kid','child',true);
insert into public.kid_progress (family_id, member_id, xp, level, current_streak, longest_streak, last_activity) values
  ('00000000-0000-4000-8496-0000000000f1','00000000-0000-4000-8496-0000000000d1', 40, 1, 2, 2, current_date - 1),
  ('00000000-0000-4000-8496-0000000000f1','00000000-0000-4000-8496-0000000000d3', 40, 1, 2, 2, current_date - 1);

do $$
declare
  fam    uuid := '00000000-0000-4000-8496-0000000000f1';
  parent uuid := '00000000-0000-4000-8496-0000000000a1';
  kid_u  uuid := '00000000-0000-4000-8496-0000000000c1';
  teen_u uuid := '00000000-0000-4000-8496-0000000000e1';
  kid    uuid := '00000000-0000-4000-8496-0000000000d1';
  teen   uuid := '00000000-0000-4000-8496-0000000000d3';
  other  uuid := '00000000-0000-4000-8496-0000000000d2';
  failures text[] := '{}';
  r      jsonb;
  row_now text;
  n      int;
  original_def text;
  who    record;
  xp_before int;
begin
  -- A child and a teen, each acting as themselves.
  for who in select * from (values
      (kid_u,  kid,  'a child'),
      (teen_u, teen, 'a teen')
    ) as w(uid, member, label) loop
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', who.uid::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', who.uid, 'role', 'authenticated')::text, true);
    if auth.uid() is distinct from who.uid then
      raise exception 'CONTROL: the impersonation did not take; nothing below would measure anything';
    end if;

    r := public.kid_progress_apply_completion(fam, who.member, 999999, current_date);
    if coalesce(r->>'ok', 'false') <> 'false' or r->>'reason' is distinct from 'forbidden' then
      failures := array_append(failures, format('%s awarded themselves XP through kid_progress_apply_completion (%s)', who.label, r));
    end if;
    r := public.kid_progress_revert_completion(fam, who.member, 0, 2, 2, current_date - 1, 365, 365, current_date - 1);
    if coalesce(r->>'ok', 'false') <> 'false' or r->>'reason' is distinct from 'forbidden' then
      failures := array_append(failures, format('%s rewrote their own streak through kid_progress_revert_completion (%s)', who.label, r));
    end if;

    perform set_config('role','postgres', true);
    select xp || '/' || level || '/' || current_streak || '/' || longest_streak into row_now
      from public.kid_progress where member_id = who.member;
    if row_now is distinct from '40/1/2/2' then
      failures := array_append(failures, format('%s''s own progress row moved to xp/level/streak/longest %s', who.label, row_now));
    end if;
  end loop;

  -- Control: a parent awards, as approveSubmissionAction does. Measured as a
  -- delta, so on the released schema (where the child's award above landed)
  -- this control still says only what it is about.
  select xp into xp_before from public.kid_progress where member_id = kid;
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', parent, 'role', 'authenticated')::text, true);
  r := public.kid_progress_apply_completion(fam, kid, 20, current_date);
  if coalesce(r->>'ok', 'false') <> 'true' or (r->>'xp')::int <> xp_before + 20 then
    failures := array_append(failures, format('CONTROL: a parent''s award did not land (%s)', r));
  end if;
  -- Control: another family's child is still refused.
  r := public.kid_progress_apply_completion(fam, other, 20, current_date);
  if r->>'reason' is distinct from 'member_not_in_family' then
    failures := array_append(failures, format('CONTROL: an award for another family''s child was not refused as member_not_in_family (%s)', r));
  end if;

  -- Control: the service path (no auth.uid), which the auto-approve payout uses.
  perform set_config('role','postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  select xp into xp_before from public.kid_progress where member_id = kid;
  r := public.kid_progress_apply_completion(fam, kid, 20, current_date);
  if coalesce(r->>'ok', 'false') <> 'true' or (r->>'xp')::int <> xp_before + 20 then
    failures := array_append(failures, format('CONTROL: the service path''s award did not land (%s)', r));
  end if;

  select count(*) into n from pg_proc
   where oid in ('public.kid_progress_apply_completion(uuid,uuid,integer,date)'::regprocedure,
                 'public.kid_progress_revert_completion(uuid,uuid,integer,integer,integer,date,integer,integer,date)'::regprocedure)
     and prosecdef and position('is_family_member(p_family_id)' in prosrc) = 0;
  if n <> 2 then
    failures := array_append(failures, 'the kid_progress award functions are not both SECURITY DEFINER without a bare is_family_member check');
  end if;

  -- NEGATIVE CONTROL: 0341's check, under which the child's self-award lands.
  select pg_get_functiondef('public.kid_progress_apply_completion(uuid,uuid,integer,date)'::regprocedure) into original_def;
  if position('can_manage_family(p_family_id)' in original_def) > 0 then
    execute replace(original_def, 'can_manage_family(p_family_id)', 'is_family_member(p_family_id)');
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', kid_u::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', kid_u, 'role', 'authenticated')::text, true);
    r := public.kid_progress_apply_completion(fam, kid, 1, current_date);
    perform set_config('role','postgres', true);
    execute original_def;
    if coalesce(r->>'ok', 'false') <> 'true' then
      failures := array_append(failures, format('NEGATIVE CONTROL: under 0341''s check the child''s self-award was still refused (%s), so this fixture cannot see the defect', r));
    end if;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a child can award their own XP:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-childs-xp-is-awarded-by-a-parent: OK (a child and a teen are refused by both award functions and their rows do not move; a parent''s award and the service path''s land; another family''s child is still refused; both functions are SECURITY DEFINER without a bare is_family_member check; negative control: under 0341''s check the child''s self-award landed)';
end $$;

rollback;

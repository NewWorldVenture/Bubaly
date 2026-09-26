-- What the approval was WORTH, not just who made it.
--
-- 0223 stops a child moving their own chore assignment into 'approved'. It
-- says nothing about `points_awarded` and `cash_awarded_cents`, and a child may
-- legitimately set their own assignment to 'done' — so both amounts could be
-- written in that same statement.
--
-- The cash column is the one with teeth: payChoreRewardAction credits a child's
-- wallet with `assignment.cash_awarded_cents ?? chore.cash_cents`. The chores
-- board hides its Pay button while that column is truthy, which happens to
-- block the ordinary click path — an accident of a condition written for
-- idempotency, not a boundary.
--
-- Judged on ROW COUNTS: an UPDATE refused by a policy raises, but one refused
-- by nothing simply lands, and an exception-only assertion would report a
-- boundary that is not there.
--
-- NEGATIVE CONTROL, and it runs FIRST, before the refusals it gives meaning to
-- ---------------------------------------------------------------------------
-- MECHANISM. This boundary is not RLS. `chore_assignments` carries
-- `0004_rls.sql`'s role-blind CRUD set — four policies, all
-- `is_family_member(family_id)` — and no later migration replaces them:
-- grepping `chore_assignments_update` and its three siblings across
-- supabase/migrations returns 0004 and nothing else. What refuses checks 2-5 is
-- a BEFORE INSERT OR UPDATE TRIGGER, `trg_chore_assignment_decision_guard`.
--
-- And the body under test is the LAST one written, not 0223's and not 0305's.
-- `0223` created the function, `0305` added the award-amount rule, and
-- `0331_ai_score_is_not_the_childs_to_write.sql` (~L114) does `create or
-- replace` on it for the third time and re-creates the trigger. 0331 is the
-- last of the three hits for `chore_assignment_decision_guard` across
-- supabase/migrations, so 0331's body is the one running; it carries 0305's
-- amount rule through verbatim, which is why the checks below still read the
-- way 0305 wrote them.
--
-- In that body the amount branch is exactly one question:
--
--   amount_changed and not (service_role or auth.uid() is null
--                           or public.can_manage_family(new.family_id))
--
-- One question is all the boundary is, so the control is the same child, the
-- same trigger and the same two verbs in a SECOND family where that child IS a
-- manager: the same actor through the same predicate with the answer the other
-- way, which must land. `ctl_fam` is a household the child created, so
-- `can_manage_family` answers YES there for the very user it answers no for in
-- `fam`. Nothing else about the statements changes.
--
-- Without it, checks 2-5 are refusals with no attribution:
--
--   * each catches `insufficient_privilege` and credits the guard — but a
--     missing or revoked table GRANT raises 42501, a column-level denial on
--     `points_awarded` or `cash_awarded_cents` raises 42501, a dead
--     `auth.uid()` raises 42501, and another guard trigger raises 42501. This
--     repository refuses writes with guard triggers in 0223, 0305, 0326 and
--     0331, and two more already fire on this very table — 0311's pair of
--     `reference_shares_family` triggers — so that is not hypothetical;
--   * each also passes on ZERO ROWS, and a row this session cannot see or
--     cannot write reports zero just as readily as a guard does.
--
-- The control's UPDATE names THE SAME THREE COLUMNS check 4 writes — `status`,
-- `points_awarded` AND `cash_awarded_cents` — and that is not decoration. A
-- `revoke update (cash_awarded_cents) on public.chore_assignments from
-- authenticated` sails straight past a control that only touches `status`,
-- which is all step 1 does: step 1 is a real positive control for the
-- member-allowed path, but it proves nothing about the two guarded columns
-- because it never names them. Postgres checks column privileges against the
-- SET list and not against the values, so writing both amounts onto the
-- control's OWN row — in the family the child DOES manage — is the whole of
-- that proof. The control's INSERT names check 5's column list for the same
-- reason.
--
-- Step 7's manager write does not cover either: it proves the guard lets
-- SOMEBODY through, not that the CHILD's session could have written these two
-- columns at all.
--
-- If the control is refused, the probe reports this boundary as UNPROVEN
-- rather than as holding, and stops — every check after it would be
-- unreadable, and a build that cannot tell is red either way.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000ca01';
  parent_uid uuid := '00000000-0000-4000-8000-00000000caa1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000caa2';
  child_mid uuid;
  chore_id uuid;
  asg uuid;
  n int;
  failures int := 0;
  -- ── the negative control's own household ─────────────────────────────────
  -- A SECOND family the SAME child manages, so `can_manage_family(new.family_id)`
  -- — the one question the guard asks — answers yes for the very user it answers
  -- no for in `fam`. Checked unique across docs/audit and supabase/migrations:
  -- 65 probes share one database and seeded rows outlive the probe that wrote
  -- them, so a reused anchor would silently rewrite somebody else's assertion.
  ctl_fam   uuid := '00000000-0000-4000-8000-00000000ca02';
  ctl_mid   uuid;
  ctl_chore uuid;
  ctl_asg   uuid;
  ctl_fail  text[] := '{}';
begin
  delete from public.chore_assignments where family_id = fam;
  delete from public.chores where family_id = fam;
  delete from public.chore_assignments where family_id = ctl_fam;
  delete from public.chores where family_id = ctl_fam;

  insert into auth.users (id, email) values
    (parent_uid, 'chore-parent@example.com'), (child_uid, 'chore-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Chore Awards', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  insert into public.chores (family_id, title, points) values (fam, 'Dishes', 5) returning id into chore_id;
  insert into public.chore_assignments (family_id, chore_id, member_id, status)
    values (fam, chore_id, child_mid, 'todo') returning id into asg;

  -- ── the negative control's household ─────────────────────────────────────
  -- Seeded here, while the trusted server's exemption is still in force
  -- (`auth.uid()` is null until the set_config below), exactly as `fam` is. The
  -- control's chore and member live in ctl_fam because 0311's two
  -- `reference_shares_family` triggers require a row's references to share the
  -- row's family — a control that tripped THOSE would fail for a reason that is
  -- not the control's.
  insert into public.families (id, name, created_by)
    values (ctl_fam, 'Chore Awards (the child manages this one)', child_uid)
  on conflict (id) do nothing;
  -- on_family_created already files the creator as a 'parent'; upsert rather
  -- than assume, because a seed whose roles are wrong would fail the control
  -- for a reason that is not the control's either.
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (ctl_fam, child_uid, 'Child (a manager here)', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
  select id into ctl_mid from public.family_members where family_id = ctl_fam and user_id = child_uid;

  insert into public.chores (family_id, title, points)
    values (ctl_fam, 'Dishes (control house)', 5) returning id into ctl_chore;
  -- No amounts on the seeded row, deliberately: the control's UPDATE has to be
  -- an actual CHANGE to both columns or `amount_changed` is false and the guard
  -- is never reached, which would make the control pass without testing it.
  insert into public.chore_assignments (family_id, chore_id, member_id, status)
    values (ctl_fam, ctl_chore, ctl_mid, 'todo') returning id into ctl_asg;

  -- ── as the child ─────────────────────────────────────────────────────────
  -- Set BEFORE dropping role, or auth.uid() is null and the guard waves it
  -- through as the trusted server — every assertion below would pass falsely.
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;
  -- The control's own precondition: the SAME session must be a manager of
  -- ctl_fam, or the control is not this predicate answered the other way and
  -- its failure would say nothing about the guard.
  if not public.can_manage_family(ctl_fam) then
    raise exception 'CONTROL FAILED: this child is not a manager of the control family %, so the control below is not the same predicate with the answer the other way', ctl_fam;
  end if;

  -- 0. NEGATIVE CONTROL — the same child, the same trigger, the other answer.
  --    Runs BEFORE checks 2-5, because it is what makes their refusals mean
  --    "the guard said no" rather than "something said no". Both legs must
  --    LAND. If either does not, this session never held the access those
  --    checks are supposed to be measuring: a revoked table GRANT, a
  --    column-level revoke on either amount column, or a second guard trigger
  --    on this table would refuse the control here too, and then 2-5 are
  --    42501s credited to a guard that may have been loosened.
  begin
    -- The same three columns check 4 writes, and the same values.
    update public.chore_assignments
       set status = 'done', points_awarded = 9999, cash_awarded_cents = 500000
     where id = ctl_asg;
    get diagnostics n = row_count;
    if n <> 1 then
      ctl_fail := array_append(ctl_fail, format(
        'this child''s UPDATE of status + points_awarded + cash_awarded_cents in the family they DO manage changed %s rows, not 1 — so the zero-row halves of checks 2-5 would prove nothing: a row this session cannot see or cannot write reports zero either way', n));
    end if;
  exception when others then
    ctl_fail := array_append(ctl_fail, format(
      'this child was refused status + points_awarded + cash_awarded_cents in the family they DO manage (%s: %s) — so checks 2-4 catching insufficient_privilege would prove only that something said no, not that the award guard said it', sqlstate, sqlerrm));
  end;

  begin
    -- Check 5's column list, in the family the child manages.
    insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded, cash_awarded_cents)
    values (ctl_fam, ctl_chore, ctl_mid, 'done', 9999, 500000);
    get diagnostics n = row_count;
    if n <> 1 then
      ctl_fail := array_append(ctl_fail, format(
        'this child''s INSERT of an assignment carrying both award amounts in the family they DO manage stored %s rows, not 1', n));
    end if;
  exception when others then
    ctl_fail := array_append(ctl_fail, format(
      'this child was refused an INSERT carrying both award amounts in the family they DO manage (%s: %s) — so check 5''s insufficient_privilege would prove only that something said no', sqlstate, sqlerrm));
  end;

  -- The control's rows do not outlive the control. Unconditional: a stray
  -- assignment carrying 9999 points and $5,000 in a second family is exactly
  -- the quiet contamination that turns one unattributed check here into one
  -- false failure in a probe that runs later against the same database.
  reset role;
  delete from public.chore_assignments where family_id = ctl_fam;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- A failed control makes every refusal below unreadable. The boundary is not
  -- reported as holding and it is not reported as broken: it is reported as
  -- unproven, here, while the reason is still in hand.
  if array_length(ctl_fail, 1) is not null then
    raise exception 'chore award amount boundary UNPROVEN (the control this probe rests on did not hold): %', array_to_string(ctl_fail, ' | ');
  end if;

  -- 1. Ticking a chore done is theirs to do — the positive control. A guard
  --    that blocked this would have broken the feature rather than closed the
  --    hole, and every refusal below would mean nothing.
  begin
    update public.chore_assignments set status = 'done' where id = asg;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a child could not tick their own chore done (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not tick their own chore done (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. But not for a points figure of their choosing.
  begin
    update public.chore_assignments set points_awarded = 9999 where id = asg;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child set their own points_awarded (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Nor a cash figure — the column payChoreRewardAction credits a wallet from.
  begin
    update public.chore_assignments set cash_awarded_cents = 500000 where id = asg;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child set their own cash_awarded_cents (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Nor smuggled in beside a status they ARE allowed to set.
  begin
    update public.chore_assignments
       set status = 'done', points_awarded = 9999, cash_awarded_cents = 500000
     where id = asg;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child set both amounts alongside status=done (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Nor on a fresh assignment of their own.
  begin
    insert into public.chore_assignments (family_id, chore_id, member_id, status, points_awarded, cash_awarded_cents)
    values (fam, chore_id, child_mid, 'done', 9999, 500000);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child inserted an assignment carrying its own award amounts (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. And the displayed total is still the honest one.
  select coalesce(sum(points_awarded), 0) into n
    from public.chore_assignments
   where family_id = fam and member_id = child_mid and status in ('done', 'approved');
  if n <> 0 then
    raise warning 'BREACH: the child''s displayed points total is % after the attempts above', n;
    failures := failures + 1;
  end if;

  reset role;

  -- 7. A manager still awards, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    update public.chore_assignments
       set status = 'approved', points_awarded = 5, cash_awarded_cents = 250
     where id = asg;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not approve and award (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not approve and award (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'chore-award-amount: % assertion(s) failed', failures;
  end if;
  raise notice 'chore-award-amount: OK — a child may tick a chore done, and may not price it';
end
$probe$;

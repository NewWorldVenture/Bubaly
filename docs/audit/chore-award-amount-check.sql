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
begin
  delete from public.chore_assignments where family_id = fam;
  delete from public.chores where family_id = fam;

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

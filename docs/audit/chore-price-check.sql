-- The chore's OWN price, which 0305 did not reach.
--
-- 0305 closed `chore_assignments.cash_awarded_cents` — the override a manager
-- writes at approval. The payout reads that column with a FALLBACK:
--
--   app/(app)/wallet/actions.ts:206
--     const amount = assignment.cash_awarded_cents ?? chore?.cash_cents ?? 0;
--
-- An ordinary chore has no override, so the number a parent's Pay click credits
-- is `chores.cash_cents` — and `chores` carries four permissive policies whose
-- whole condition is `is_family_member(family_id)`.
--
-- This is worse than the column 0305 fixed, not the same. There the chores
-- board's `canPay = … && !a.cash_awarded_cents` happened to hide the button
-- once the column was set. Here the button's condition is
-- `(a.chore?.cash_cents ?? 0) > 0 && !a.cash_awarded_cents`
-- (components/modules/chores-module.tsx:554) — exactly the state a child can
-- manufacture. The parent is shown "Pay $5,000.00" on a chore their child wrote
-- and priced.
--
-- Points are the second number: the chores board's approve writes
-- `points_awarded: chore.points`, and lib/chores/dashboard.ts counts
-- `a.points_awarded ?? a.chore?.points`. A member may still CREATE a chore
-- carrying points — the assistant's own tasks service does exactly that as the
-- calling user (lib/services/tasks/index.ts, `points: input.points ?? 10`) and
-- a guard on INSERT would close that path. Re-pricing an existing chore is
-- nobody's business but a manager's, so that is what is asserted.
--
-- Judged on ROW COUNTS: an INSERT nothing refuses simply lands, and an
-- exception-only assertion would report a boundary that is not there.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000cf01';
  parent_uid uuid := '00000000-0000-4000-8000-00000000cfa1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000cfa2';
  child_mid uuid;
  priced uuid;
  n int;
  failures int := 0;
begin
  delete from public.chore_assignments where family_id = fam;
  delete from public.chores where family_id = fam;

  insert into auth.users (id, email) values
    (parent_uid, 'price-parent@example.com'), (child_uid, 'price-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Chore Prices', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  -- A chore a manager priced, for the re-pricing assertions below.
  insert into public.chores (family_id, title, points, cash_cents)
    values (fam, 'Mow the lawn', 5, 500) returning id into priced;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- 1. A member may still add a chore, points and all — the positive control.
  --    The assistant's tasks service does this as the calling user, so a guard
  --    that blocked it would have closed a working path rather than the hole.
  begin
    insert into public.chores (family_id, title, points) values (fam, 'Tidy my room', 10);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a member could not add a chore (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a member could not add a chore (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. But not one that pays cash. This is the number payChoreRewardAction
  --    credits when the assignment carries no override, which is the ordinary
  --    case.
  begin
    insert into public.chores (family_id, title, cash_cents) values (fam, 'Wash the car', 500000);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child created a chore paying % cents (rows: %)', 500000, n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Nor raise the cash on a chore a manager priced.
  begin
    update public.chores set cash_cents = 500000 where id = priced;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child re-priced a manager''s chore in cash (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Nor its points, which the board copies into points_awarded on approval.
  begin
    update public.chores set points = 9999 where id = priced;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child re-priced a manager''s chore in points (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Nor smuggle the cash in via the range columns the reward modes read.
  begin
    update public.chores set cash_min_cents = 500000, cash_max_cents = 900000 where id = priced;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child set a chore''s cash range (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. Renaming the chore is still theirs to do — the second positive control.
  --    A guard written on the row rather than on the columns would fail here.
  begin
    update public.chores set title = 'Mow the lawn (front)' where id = priced;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a member could not edit a chore''s text (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a member could not edit a chore''s text (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 7. And what the payout would read is still what the manager set.
  select cash_cents into n from public.chores where id = priced;
  if n <> 500 then
    raise warning 'BREACH: the chore the payout reads is now priced at % cents', n;
    failures := failures + 1;
  end if;

  reset role;

  -- 8. A manager still prices a chore, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    insert into public.chores (family_id, title, points, cash_cents)
      values (fam, 'Clean the gutters', 20, 1500);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not price a chore (rows: %)', n;
      failures := failures + 1;
    end if;
    update public.chores set cash_cents = 750, points = 8 where id = priced;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not re-price a chore (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not price a chore (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'chore-price: % assertion(s) failed', failures;
  end if;
  raise notice 'chore-price: OK — a member may add and edit a chore, and may not price one';
end
$probe$;

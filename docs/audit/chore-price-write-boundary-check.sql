-- Behavioural proof for 0303, run as real `authenticated` sessions under RLS.
--
-- The chores economy's PRICE LIST is `public.chores` (points, cash_cents,
-- auto_approve_score, the min/max bounds) and the amount actually paid is
-- `chore_assignments.points_awarded` / `.cash_awarded_cents`. Both were
-- UPDATE-able by `is_family_member` — by the child who gets paid — and three
-- cash-out paths re-read those values instead of re-deriving them.
--
-- 0223's decision guard fired only on a transition INTO 'approved'/'rejected',
-- so an UPDATE that changed only cash_awarded_cents on an ALREADY-approved row
-- passed untouched. That case is asserted here explicitly, because it is the one
-- the previous guard could not see.
--
-- What a member may still do is asserted alongside what they may not: a child
-- still READS their chores, still moves their own assignment to 'submitted',
-- and still records ai_score and submitted_at when they submit proof. A guard
-- that broke those would stop the product working.
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam        uuid := 'cccc1111-0000-4000-8000-00000000000c';
  parent_uid uuid := 'c1000000-0000-4000-8000-000000000001';
  child_uid  uuid := 'c1000000-0000-4000-8000-000000000002';
  parent_mid uuid;
  child_mid  uuid;
  ch         uuid;
  asg        uuid;
  blocked    boolean;
  n          int;
  v_cash     int;
  v_points   int;
  v_score    int;
begin
  -- Re-runnable against a database that already holds a previous run's rows.
  delete from public.chore_assignments where family_id = fam;
  delete from public.chores where family_id = fam;
  delete from public.family_members where user_id in (parent_uid, child_uid);
  delete from public.families where id = fam;

  insert into public.families (id, name) values (fam, 'Chores') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'cp@example.test'), (child_uid, 'cc@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;

  -- ── As the PARENT: the price list, and the positive control ──────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  insert into public.chores (family_id, title, points, cash_cents, auto_approve_score, created_by)
  values (fam, 'Tidy the kitchen', 5, 200, 95, parent_uid) returning id into ch;
  insert into public.chore_assignments (family_id, chore_id, member_id, status)
  values (fam, ch, child_mid, 'todo') returning id into asg;

  update public.chores set cash_cents = 250 where id = ch;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer reprice their own chore (%)', n;
  end if;

  -- ── As the CHILD ─────────────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 1. Cannot rewrite the price list. Before 0303 this was UPDATE 1.
  update public.chores set cash_cents = 5000000, points = 99999, auto_approve_score = 0 where id = ch;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child rewrote the chore price list';
  end if;
  reset role;
  select cash_cents, points, auto_approve_score into v_cash, v_points, v_score
    from public.chores where id = ch;
  if v_cash <> 250 or v_points <> 5 or v_score <> 95 then
    raise exception 'the chore now reads cash=% points=% auto_approve=%', v_cash, v_points, v_score;
  end if;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- 2. Cannot mint a chore of their own, nor delete the parent's.
  blocked := false;
  begin
    insert into public.chores (family_id, title, points, cash_cents)
    values (fam, 'Pay me', 99999, 5000000);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child created a chore';
  end if;
  delete from public.chores where id = ch;
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'a child deleted a parent''s chore';
  end if;

  -- 3. May still submit their own work — the member-driven path, which writes
  --    only status, ai_score and submitted_at.
  update public.chore_assignments
     set status = 'submitted', ai_score = 88, submitted_at = now()
   where id = asg;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a child can no longer submit their own chore (%)', n;
  end if;

  -- 4. Cannot approve it (0223's guard, re-asserted here so 0303 cannot
  --    accidentally drop what it replaced).
  blocked := false;
  begin
    update public.chore_assignments set status = 'approved' where id = asg;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child approved their own chore assignment';
  end if;

  -- 5. Cannot write the payout columns while the status stays put. THIS is the
  --    case 0223 could not see: no status transition, so its branch never ran.
  blocked := false;
  begin
    update public.chore_assignments set cash_awarded_cents = 4242424 where id = asg;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child set their own cash payout without moving the status';
  end if;
  blocked := false;
  begin
    update public.chore_assignments set points_awarded = 88888 where id = asg;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child set their own points payout without moving the status';
  end if;
  blocked := false;
  begin
    update public.chore_assignments set approved_by = child_mid, approved_at = now() where id = asg;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child stamped their own approval fields';
  end if;

  -- 6. Nor arrive with a payout already filled in on INSERT.
  blocked := false;
  begin
    insert into public.chore_assignments (family_id, chore_id, member_id, status, cash_awarded_cents)
    values (fam, ch, child_mid, 'todo', 999999);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child created an assignment with a payout already recorded';
  end if;

  -- ── As the PARENT: approving and paying still work ───────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  update public.chore_assignments
     set status = 'approved', approved_at = now(), approved_by = parent_mid, points_awarded = 5,
         cash_awarded_cents = 250
   where id = asg;
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'a parent can no longer approve and price a submission (%)', n;
  end if;

  -- ── And the after-the-fact edit is still refused on an APPROVED row ──────
  reset role;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;
  blocked := false;
  begin
    update public.chore_assignments set cash_awarded_cents = 4242424 where id = asg;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child rewrote the payout on an already-approved assignment';
  end if;
  reset role;
  select cash_awarded_cents into v_cash from public.chore_assignments where id = asg;
  if v_cash <> 250 then
    raise exception 'the approved payout now reads %', v_cash;
  end if;

  -- ── No stray permissive write policy survives on chores ─────────────────
  select count(*) into n
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and c.relname = 'chores'
    and p.polpermissive and p.polcmd in ('a','w','d','*')
    and p.polname not in ('chores_mng_insert','chores_mng_update','chores_mng_delete');
  if n <> 0 then
    raise exception '% stray permissive write policy(ies) on chores', n;
  end if;

  raise notice 'OK chore price: the price list and the payout columns are a manager''s; submitting your own work still is not';
end $$;

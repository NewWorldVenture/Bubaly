-- Can a child mark their own savings goal reached, or erase a funded one?
--
-- wallet_goals was "Members manage wallet_goals" FOR ALL while every other
-- wallet table is manager-write. 0323 aligns it: members read, managers write.
-- As the CHILD: UPDATE and DELETE match zero rows (a refused write raises
-- nothing); INSERT is refused. The child can still read the goal (control). As
-- the PARENT: update and delete succeed (control).
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-00000000ed61';
  uPar   uuid := '00000000-0000-4000-8000-00000000ed6a';
  uKid   uuid := '00000000-0000-4000-8000-00000000ed6b';
  mKid   uuid; wallet uuid; goal uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'goal-parent@example.com'), (uKid, 'goal-kid@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Goal family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uKid, 'Kid', 'child', true) returning id into mKid;
  insert into public.child_wallets (family_id, member_id) values (fam, mKid) returning id into wallet;
  insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents, saved_cents)
    values (fam, wallet, 'Bike', 20000, 5000) returning id into goal;

  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.wallet_goals where id = goal;
  if n <> 1 then raise warning 'CONTROL FAILED: the child cannot see their goal (%)', n; failures := failures + 1; end if;

  update public.wallet_goals set saved_cents = target_cents where id = goal;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child filled their own savings goal with no money moved (rows: %)', n; failures := failures + 1; end if;

  delete from public.wallet_goals where id = goal;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child deleted a funded savings goal (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents, saved_cents) values (fam, wallet, 'Forged', 100, 100);
    raise warning 'BREACH: a child created a pre-filled savings goal'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.wallet_goals set title = 'New bike' where id = goal;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not edit the goal (rows: %)', n; failures := failures + 1; end if;
  delete from public.wallet_goals where id = goal;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not delete the goal (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uKid);

  if failures > 0 then
    raise exception 'wallet-goal-manager-write-check: % failure(s)', failures;
  end if;
end
$probe$;

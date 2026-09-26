-- A redemption spends your own points (0347).
--
-- CHILD A had a 500-point redemption approved. As A: cancelling it (or
-- moving it back to requested) to get the points back, re-pointing it at
-- sibling B, requesting a reward on B's points, deleting B's request, and
-- requesting tokens on B's balance must be refused. Controls: A requests for
-- A (points and tokens); the PARENT requests on B's behalf.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000eee1';
  uPar uuid := '00000000-0000-4000-8000-00000000eeea';
  uA uuid := '00000000-0000-4000-8000-00000000eeeb';
  uB uuid := '00000000-0000-4000-8000-00000000eeec';
  mA uuid; mB uuid; reward uuid; approved uuid; bReq uuid; cur uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'redeem-parent@example.com'), (uA, 'redeem-a@example.com'), (uB, 'redeem-b@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Redeem family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'A', 'child', true) returning id into mA;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'child', true) returning id into mB;
  insert into public.rewards (family_id, title, cost_points) values (fam, 'Game night', 500) returning id into reward;
  insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, reward, mA, 'Game night', 500, 'approved') returning id into approved;
  insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, reward, mB, 'Game night', 500, 'requested') returning id into bReq;
  insert into public.family_currencies (family_id, name) values (fam, 'Stars') returning id into cur;

  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.reward_redemptions set status = 'cancelled' where id = approved;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child cancelled an approved redemption and got the points back (rows: %)', n; failures := failures + 1; end if;
  update public.reward_redemptions set status = 'requested' where id = approved;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child moved an approved redemption back to requested (rows: %)', n; failures := failures + 1; end if;
  update public.reward_redemptions set member_id = mB where id = approved;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child moved their spent points onto a sibling (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
      values (fam, reward, mB, 'Game night', 500, 'requested');
    raise warning 'BREACH: a child requested a reward on a sibling''s points'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  delete from public.reward_redemptions where id = bReq;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child deleted a sibling''s request (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into public.economy_redemptions (family_id, currency_id, member_id, title, cost, status)
      values (fam, cur, mB, 'Ice cream', 10, 'pending');
    raise warning 'BREACH: a child requested tokens on a sibling''s balance'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, reward, mA, 'Game night', 500, 'requested');
  insert into public.economy_redemptions (family_id, currency_id, member_id, title, cost, status)
    values (fam, cur, mA, 'Ice cream', 10, 'pending');
  reset role;

  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.reward_redemptions (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, reward, mB, 'Game night', 500, 'requested');
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not request on a child''s behalf (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB);

  if failures > 0 then
    raise exception 'redemption-owner-check: % failure(s)', failures;
  end if;
end
$probe$;

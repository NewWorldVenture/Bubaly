-- Checkout tracking, the wallet-terms record, chore rewards and babysitters are
-- not a child's (or any member's) to write — 0328.
--
-- As the CHILD: raising their own XP, awarding themselves a badge, changing a
-- sitter's phone, deleting a payment receipt, filing a wallet-terms acceptance
-- in the parent's name, and filing a pending checkout (which the abandoned-
-- checkout cron would email) must all be refused. As the PARENT: checkout rows
-- stay service-only, and an acceptance can be neither rewritten nor deleted.
-- Controls: the child still reads their progress and the sitter; the parent
-- awards a badge, updates the sitter, and records their own acceptance.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000edb1';
  uPar uuid := '00000000-0000-4000-8000-00000000edba';
  uKid uuid := '00000000-0000-4000-8000-00000000edbb';
  mKid uuid; sitter uuid; receipt uuid; disclosure uuid; chk uuid;
  n int; failures int := 0;
begin
  delete from public.checkout_sessions where session_id like 'cs_probe_0328_%';
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'reward-parent@example.com'), (uKid, 'reward-kid@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Reward family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uKid, 'Kid', 'child', true) returning id into mKid;
  insert into public.kid_progress (family_id, member_id, xp, level) values (fam, mKid, 10, 1);
  insert into public.babysitter_profiles (family_id, name, phone) values (fam, 'Sam', '+15550100') returning id into sitter;
  insert into public.babysitter_payments (family_id, babysitter_id, amount_cents, status, created_by)
    values (fam, sitter, 4000, 'completed', uPar) returning id into receipt;
  insert into public.compliance_disclosures (family_id, kind, version, accepted_by)
    values (fam, 'wallet_terms', 'v1', uPar) returning id into disclosure;
  insert into public.checkout_sessions (session_id, family_id, email, status)
    values ('cs_probe_0328_real', fam, 'reward-parent@example.com', 'pending') returning id into chk;

  -- ── as the CHILD ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into n from public.kid_progress where member_id = mKid;
  if n <> 1 then raise warning 'CONTROL FAILED: the child cannot see their own progress (%)', n; failures := failures + 1; end if;
  select count(*) into n from public.babysitter_profiles where id = sitter;
  if n <> 1 then raise warning 'CONTROL FAILED: the child cannot see the family''s sitter (%)', n; failures := failures + 1; end if;

  update public.kid_progress set xp = 999999, level = 50 where member_id = mKid;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child raised their own XP and level (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.member_badges (family_id, member_id, badge_id) values (fam, mKid, 'streak_7');
    raise warning 'BREACH: a child awarded themselves a badge'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  update public.babysitter_profiles set phone = '+15559999' where id = sitter;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child changed the sitter''s phone number (rows: %)', n; failures := failures + 1; end if;

  delete from public.babysitter_payments where id = receipt;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child deleted a babysitter payment receipt (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.compliance_disclosures (family_id, kind, version, accepted_by) values (fam, 'wallet_terms', 'v2', uPar);
    raise warning 'BREACH: a child filed a wallet-terms acceptance in the parent''s name'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;

  delete from public.compliance_disclosures where id = disclosure;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child deleted the wallet-terms acceptance (rows: %)', n; failures := failures + 1; end if;

  begin
    insert into public.checkout_sessions (session_id, family_id, email, name, status)
      values ('cs_probe_0328_forged', fam, 'stranger@example.com', 'Click here', 'pending');
    raise warning 'BREACH: a child filed a pending checkout the cron would email'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ── as the PARENT ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.member_badges (family_id, member_id, badge_id) values (fam, mKid, 'first_chore');
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not award a badge (rows: %)', n; failures := failures + 1; end if;
  update public.babysitter_profiles set phone = '+15550101' where id = sitter;
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not update the sitter (rows: %)', n; failures := failures + 1; end if;
  insert into public.compliance_disclosures (family_id, kind, version, accepted_by) values (fam, 'wallet_terms', 'v2', uPar);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not record their own acceptance (rows: %)', n; failures := failures + 1; end if;

  update public.compliance_disclosures set version = 'v0', accepted_at = now() - interval '1 year' where id = disclosure;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a wallet-terms acceptance was rewritten (rows: %)', n; failures := failures + 1; end if;
  delete from public.compliance_disclosures where id = disclosure;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a wallet-terms acceptance was deleted (rows: %)', n; failures := failures + 1; end if;

  update public.checkout_sessions set status = 'completed', email = 'stranger@example.com' where id = chk;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a family member rewrote a tracked checkout (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into public.checkout_sessions (session_id, family_id, email, status)
      values ('cs_probe_0328_parent', fam, 'stranger@example.com', 'pending');
    raise warning 'BREACH: a family member filed a pending checkout'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  delete from public.checkout_sessions where session_id like 'cs_probe_0328_%';
  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uKid);

  if failures > 0 then
    raise exception 'checkout-rewards-babysitter-check: % failure(s)', failures;
  end if;
end
$probe$;

-- Network consent is a manager's decision; affiliate commissions are not a
-- family member's to write.
--
-- As a CHILD: opting the family into network sharing is refused (INSERT raises;
-- UPDATE matches zero rows). As an ADULT MANAGER: filing a converted referral,
-- inflating a commission, or voiding one is refused — members never write this
-- table (0327). Controls: the child can still read the consent row; a parent
-- can opt the family in.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000eda1';
  uPar uuid := '00000000-0000-4000-8000-00000000edaa';
  uKid uuid := '00000000-0000-4000-8000-00000000edab';
  aff  uuid := '00000000-0000-4000-8000-00000000edac';
  ref  uuid;
  n int; failures int := 0;
begin
  delete from public.affiliate_referrals where family_id = fam;
  delete from public.network_consent where family_id = fam;
  delete from public.families where id = fam;
  delete from public.affiliates where id = aff;
  insert into auth.users (id, email) values
    (uPar, 'consent-parent@example.com'), (uKid, 'consent-kid@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Consent family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uKid, 'Kid', 'child', true);
  insert into public.affiliates (id, name, code) values (aff, 'Probe affiliate', 'probe-affiliate-code');
  insert into public.affiliate_referrals (affiliate_id, family_id, status, commission_cents)
    values (aff, fam, 'pending', 500) returning id into ref;

  -- ── as the CHILD: network consent ────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.network_consent (family_id, enabled, consented_by) values (fam, true, uKid);
    raise warning 'BREACH: a child opted the family into network data sharing'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  reset role;

  -- ── as the PARENT: consent (control), then commission forgery ────────────
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uPar, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.network_consent (family_id, enabled, consented_by) values (fam, true, uPar);
  get diagnostics n = row_count;
  if n <> 1 then raise warning 'CONTROL FAILED: a parent could not opt the family in (rows: %)', n; failures := failures + 1; end if;

  update public.affiliate_referrals set status = 'converted', commission_cents = 500000 where id = ref;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a family member converted and inflated an affiliate commission (rows: %)', n; failures := failures + 1; end if;
  begin
    insert into public.affiliate_referrals (affiliate_id, family_id, status, commission_cents) values (aff, fam, 'converted', 999999);
    raise warning 'BREACH: a family member filed a converted referral'; failures := failures + 1;
  exception when insufficient_privilege then null;
  end;
  delete from public.affiliate_referrals where id = ref;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a family member deleted a referral (rows: %)', n; failures := failures + 1; end if;
  reset role;

  -- ── the child can still read, and cannot flip it off either ──────────────
  perform set_config('request.jwt.claim.sub', uKid::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uKid, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.network_consent where family_id = fam;
  if n <> 1 then raise warning 'CONTROL FAILED: the child cannot read the consent setting (%)', n; failures := failures + 1; end if;
  update public.network_consent set enabled = false where family_id = fam;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a child changed the family''s network consent (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.affiliate_referrals where family_id = fam;
  delete from public.network_consent where family_id = fam;
  delete from public.families where id = fam;
  delete from public.affiliates where id = aff;
  delete from auth.users where id in (uPar, uKid);

  if failures > 0 then
    raise exception 'consent-and-commission-check: % failure(s)', failures;
  end if;
end
$probe$;

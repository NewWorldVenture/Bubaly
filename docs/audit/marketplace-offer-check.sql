-- A marketplace offer is withdrawn, not deleted by a sibling (0344).
--
-- As TEEN A: deleting sibling B's offer must be refused; the offer is still
-- there afterwards. Control: A still reads it.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000eeb1';
  uPar uuid := '00000000-0000-4000-8000-00000000eeba';
  uA uuid := '00000000-0000-4000-8000-00000000eebb';
  uB uuid := '00000000-0000-4000-8000-00000000eebc';
  mB uuid; listing uuid; offer uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'offer-parent@example.com'), (uA, 'offer-a@example.com'), (uB, 'offer-b@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Offer family', uPar);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uA, 'A', 'teen', true);
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values (fam, uB, 'B', 'teen', true) returning id into mB;
  insert into public.marketplace_listings (family_id, title) values (fam, 'Guitar') returning id into listing;
  insert into public.marketplace_offers (family_id, listing_id, member_id, kind, amount_cents, status)
    values (fam, listing, mB, 'offer', 5000, 'open') returning id into offer;

  perform set_config('request.jwt.claim.sub', uA::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', uA, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into n from public.marketplace_offers where id = offer;
  if n <> 1 then raise warning 'CONTROL FAILED: A cannot see the offer (%)', n; failures := failures + 1; end if;
  delete from public.marketplace_offers where id = offer;
  get diagnostics n = row_count;
  if n <> 0 then raise warning 'BREACH: a sibling deleted someone''s offer (rows: %)', n; failures := failures + 1; end if;
  reset role;

  delete from public.families where id = fam;
  delete from auth.users where id in (uPar, uA, uB);

  if failures > 0 then
    raise exception 'marketplace-offer-check: % failure(s)', failures;
  end if;
end
$probe$;

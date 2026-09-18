-- The listing state machine must decide from the row it writes to.
--
-- `marketplace_set_listing_status` read the listing with no lock and wrote with
-- no predicate, so the transition was judged against a row another transaction
-- may already have changed. Of the twenty-two SECURITY DEFINER functions in
-- this schema that read a row and then update it, this was the only one with
-- NEITHER mechanism — every other one takes `for update`, predicates its write,
-- or both.
--
-- The race itself needs two sessions, so it is not reproduced here. It was
-- measured directly, buyer vs. seller, and recorded in 0317's header:
--
--   before:  seller: (no error — the forbidden transition was accepted)
--            listing=pending  claimed_by=<buyer>  confirmed_orders=1
--   after:   seller: ERROR: Cannot move listing from claimed to pending
--
-- What this probe holds is (1) that the mechanism is present in the function
-- the database actually has — read out of pg_get_functiondef, not out of a
-- file, so it cannot pass against a definition that was replaced later — and
-- (2) that the state machine still behaves, including the transitions that are
-- SUPPOSED to be legal. `claimed -> withdrawn` is one of them: a seller whose
-- buyer falls through must still be able to pull the listing, and that is not
-- the defect above.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-0000000c8a01';
  u   uuid := '00000000-0000-4000-8000-0000000c8a0a';
  seller uuid; listing uuid;
  src text;
  st text;
  failures int := 0;
begin
  delete from public.marketplace_listings where family_id = fam;

  insert into auth.users (id, email) values (u, 'statemachine@example.com') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'State family', u) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, u, 'Seller', 'parent', true) on conflict do nothing;
  select id into seller from public.family_members where family_id = fam and user_id = u;

  -- 1. The mechanism, in the installed function.
  select pg_get_functiondef(p.oid) into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'marketplace_set_listing_status';

  if src !~* 'for update' then
    raise warning 'BREACH: marketplace_set_listing_status reads without FOR UPDATE, so it decides from a row it does not hold';
    failures := failures + 1;
  end if;
  if src !~* 'and status = v_listing\.status' then
    raise warning 'BREACH: the UPDATE does not carry the status it decided from';
    failures := failures + 1;
  end if;

  -- 2. No other read-then-write SECURITY DEFINER function may drop both
  --    mechanisms either. This is the sweep that found this one, kept so the
  --    next such function is caught at replay rather than by a buyer.
  declare
    bare text[];
  begin
    select coalesce(array_agg(p.proname order by p.proname), '{}') into bare
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f' and p.prosecdef
      and p.prosrc ~* 'select .* into ' and p.prosrc ~* 'update public\.'
      and p.prosrc !~* 'for update'
      and p.prosrc !~* 'update public\.[a-z_]+[^;]*where[^;]*status\s*(=|in)';
    if array_length(bare, 1) > 0 then
      raise warning 'BREACH: % function(s) read a row then update it with neither a row lock nor a predicated write: %',
        array_length(bare, 1), array_to_string(bare, ', ');
      failures := failures + 1;
    end if;
  end;

  -- ── the state machine still works ────────────────────────────────────────
  insert into public.marketplace_listings (family_id, member_id, title, kind, price_cents, status)
    values (fam, seller, 'State bike', 'sell', 3000, 'available') returning id into listing;

  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;

  -- 3. Control: available -> pending is legal and still works.
  begin
    perform public.marketplace_set_listing_status(listing, 'pending');
    select status into st from public.marketplace_listings where id = listing;
    if st <> 'pending' then
      raise warning 'CONTROL FAILED: available -> pending did not take (status %)', st;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: available -> pending was refused (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 4. Control: pending -> available is legal and still works.
  begin
    perform public.marketplace_set_listing_status(listing, 'available');
  exception when others then
    raise warning 'CONTROL FAILED: pending -> available was refused (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 5. The forbidden one is still forbidden, judged from the true status.
  reset role;
  update public.marketplace_listings set status = 'claimed' where id = listing;
  perform set_config('request.jwt.claim.sub', u::text, true);
  set local role authenticated;
  begin
    perform public.marketplace_set_listing_status(listing, 'pending');
    raise warning 'BREACH: claimed -> pending was accepted';
    failures := failures + 1;
  exception when others then null;
  end;
  select status into st from public.marketplace_listings where id = listing;
  if st <> 'claimed' then
    raise warning 'BREACH: a refused transition still changed the listing (status %)', st;
    failures := failures + 1;
  end if;

  -- 6. Control: claimed -> withdrawn IS legal and must stay that way. A seller
  --    whose buyer falls through has to be able to pull the listing; widening
  --    the fix into forbidding this would break a real thing families do.
  begin
    perform public.marketplace_set_listing_status(listing, 'withdrawn');
    select status into st from public.marketplace_listings where id = listing;
    if st <> 'withdrawn' then
      raise warning 'CONTROL FAILED: claimed -> withdrawn did not take (status %)', st;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: claimed -> withdrawn was refused (% %) — that transition is legal', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 7. Control: someone who does not own the listing still cannot move it.
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.marketplace_set_listing_status(listing, 'available');
    raise warning 'BREACH: a non-owner moved the listing';
    failures := failures + 1;
  exception when others then null;
  end;

  delete from public.marketplace_listings where family_id = fam;

  if failures > 0 then
    raise exception '0317 FAILED: % assertion(s)', failures;
  end if;
  raise notice '0317 OK: the listing state machine decides from a locked row (7 assertions)';
end
$probe$;

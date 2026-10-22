-- ── A listing other families hold records of is withdrawn, not erased (0505) ─
--
-- A seller may hard-delete their own listing, and every table that records a
-- dealing with it cascades on listing_id: orders, offers, questions, bids,
-- negotiations and their rounds, handoffs and reports, rows other families
-- hold. The held 0505 refuses a signed-in caller's delete of a listing that has
-- any of them; such a listing is withdrawn instead.
--
-- What this probe asserts, through PostgREST's role, each outcome exact
-- (`OK <rows>` or the SQLSTATE and the guard's own sentence), with one listing
-- per kind of record, each held by Buyer House:
--
--   1. the seller's delete of the listing with an order, one with an offer, a
--      question, a bid, a negotiation (and its round), and one with ONLY a
--      report (which the seller cannot even see) is refused with 42501 and the
--      guard's sentence; each listing and each record is still there (counted);
--   2. control: the seller withdraws the listing with the order and the report
--      (marketplace_set_listing_status → withdrawn), and both records remain;
--   3. control: the seller still deletes a listing nobody has dealt with (OK 1);
--   4. RECORDED LIMIT, pinned so a change is seen (not a preservation
--      guarantee, and not an owner decision): the service role (carrying the
--      seller's user id) and, separately, a session-less writer (null uid) each
--      delete a listing with records (1 row each, its records gone with it);
--   5. RECORDED LIMIT, likewise: a family's own deletion still takes its
--      listings, and the offer and report other families hold of them (the
--      family-gone branch). Whether those records should outlive the seller's
--      family is the retention policy's owner's decision, not this probe's;
--   6. wiring: an enabled BEFORE DELETE row trigger, SECURITY DEFINER with a
--      pinned search_path;
--
-- and, only where 0505 is installed, each in a rolled-back subtransaction:
--
--   M1. MUTATION: the guard without its reports clause lets the seller delete
--       the listing that has only a report;
--   N1. NEGATIVE CONTROL: with the guard disabled, the seller's delete of the
--       listing with the order lands and the order goes with it.
--
-- Everything is rolled back.
--
-- HELD with 0505: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/marketplace-records-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0505 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8505-0000000000a1','m0505-seller@example.com'),
  ('00000000-0000-4000-8505-0000000000b1','m0505-buyer@example.com'),
  ('00000000-0000-4000-8505-0000000000c1','m0505-closing@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8505-0000000000f1','Seller House','00000000-0000-4000-8505-0000000000a1'),
  ('00000000-0000-4000-8505-0000000000f2','Buyer House','00000000-0000-4000-8505-0000000000b1'),
  -- A household that closes itself: its listing has an offer and a report
  -- from Buyer House and no order (an order's seller_member is a fixed term of
  -- the deal, which keeps a family with orders from being deleted already).
  ('00000000-0000-4000-8505-0000000000f3','Closing House','00000000-0000-4000-8505-0000000000c1');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8505-0000000000a1','00000000-0000-4000-8505-0000000000b1','00000000-0000-4000-8505-0000000000c1');

-- Records are written as the server writes them (no session), so this probe
-- tests the delete, not each table's own insert rules.
do $$
declare
  seller_f constant uuid := '00000000-0000-4000-8505-0000000000f1';
  buyer_f  constant uuid := '00000000-0000-4000-8505-0000000000f2';
  seller_m uuid := (select id from public.family_members where family_id = '00000000-0000-4000-8505-0000000000f1' and user_id = '00000000-0000-4000-8505-0000000000a1');
  buyer_m  uuid := (select id from public.family_members where family_id = '00000000-0000-4000-8505-0000000000f2' and user_id = '00000000-0000-4000-8505-0000000000b1');
  neg      uuid;
begin
  insert into public.marketplace_listings (id, family_id, member_id, title, kind, price_cents, status) values
    ('00000000-0000-4000-8505-0000000000d1', seller_f, seller_m, 'Bike (an order)',          'sell', 5000, 'claimed'),
    ('00000000-0000-4000-8505-0000000000d2', seller_f, seller_m, 'Lamp (an offer)',          'sell', 2000, 'available'),
    ('00000000-0000-4000-8505-0000000000d3', seller_f, seller_m, 'Desk (a question)',        'sell', 3000, 'available'),
    ('00000000-0000-4000-8505-0000000000d4', seller_f, seller_m, 'Guitar (a bid)',           'sell', 4000, 'available'),
    ('00000000-0000-4000-8505-0000000000d5', seller_f, seller_m, 'Tent (a negotiation)',     'sell', 6000, 'available'),
    ('00000000-0000-4000-8505-0000000000d6', seller_f, seller_m, 'Phone (only a report)',    'sell', 9000, 'available'),
    ('00000000-0000-4000-8505-0000000000d7', seller_f, seller_m, 'Chair (nobody dealt)',     'sell', 1000, 'available'),
    ('00000000-0000-4000-8505-0000000000d8', seller_f, seller_m, 'Rug (service role)',       'sell', 1000, 'available'),
    ('00000000-0000-4000-8505-0000000000d9', seller_f, seller_m, 'Mirror (no session)',      'sell', 1000, 'available'),
    ('00000000-0000-4000-8505-0000000000da', seller_f, seller_m, 'Sofa (to withdraw)',       'sell', 7000, 'claimed');
  insert into public.marketplace_listings (id, family_id, member_id, title, kind, price_cents, status) values
    ('00000000-0000-4000-8505-0000000000db', '00000000-0000-4000-8505-0000000000f3',
     (select id from public.family_members where family_id = '00000000-0000-4000-8505-0000000000f3' and user_id = '00000000-0000-4000-8505-0000000000c1'),
     'Bookcase (its family closes)', 'sell', 2500, 'available');
  insert into public.marketplace_orders (family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents) values
    (buyer_f, '00000000-0000-4000-8505-0000000000d1', buyer_m, seller_m, 'buy', 'confirmed', 5000),
    (buyer_f, '00000000-0000-4000-8505-0000000000d8', buyer_m, seller_m, 'buy', 'confirmed', 1000),
    (buyer_f, '00000000-0000-4000-8505-0000000000d9', buyer_m, seller_m, 'buy', 'confirmed', 1000),
    (buyer_f, '00000000-0000-4000-8505-0000000000da', buyer_m, seller_m, 'buy', 'confirmed', 7000);
  insert into public.marketplace_reports (family_id, listing_id, reporter_member, reason, status) values
    (buyer_f, '00000000-0000-4000-8505-0000000000d1', buyer_m, 'scam', 'open'),
    (buyer_f, '00000000-0000-4000-8505-0000000000d6', buyer_m, 'scam', 'open'),
    (buyer_f, '00000000-0000-4000-8505-0000000000da', buyer_m, 'scam', 'open'),
    (buyer_f, '00000000-0000-4000-8505-0000000000db', buyer_m, 'spam', 'open');
  insert into public.marketplace_offers (family_id, listing_id, member_id, kind, status) values
    (buyer_f, '00000000-0000-4000-8505-0000000000d2', buyer_m, 'interest', 'open'),
    (buyer_f, '00000000-0000-4000-8505-0000000000db', buyer_m, 'interest', 'open');
  insert into public.marketplace_questions (family_id, listing_id, asker_member, question) values
    (buyer_f, '00000000-0000-4000-8505-0000000000d3', buyer_m, 'Does it still work?');
  insert into public.marketplace_bids (listing_id, family_id, bidder_member_id, bidder_family_id, amount_cents, max_cents) values
    ('00000000-0000-4000-8505-0000000000d4', seller_f, buyer_m, buyer_f, 3500, 3500);
  insert into public.marketplace_negotiations (family_id, listing_id, buyer_member_id, buyer_family_id, status, current_amount_cents, last_actor, rounds_count)
    values (seller_f, '00000000-0000-4000-8505-0000000000d5', buyer_m, buyer_f, 'open', 5000, 'buyer', 1)
    returning id into neg;
  insert into public.marketplace_negotiation_rounds (negotiation_id, listing_id, actor_member_id, actor_role, kind, amount_cents)
    values (neg, '00000000-0000-4000-8505-0000000000d5', buyer_m, 'buyer', 'offer', 5000);
end
$$;

-- One statement as one signed-in user, and exactly what happened.
create or replace function pg_temp.m0505_as(p_uid text, p_sql text) returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', p_uid, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  return got;
end
$fn$;

-- How many records of each kind a listing has, as the server sees them.
create or replace function pg_temp.m0505_records(p_listing uuid) returns int
language sql as $fn$
  select (select count(*) from public.marketplace_orders where listing_id = p_listing)
       + (select count(*) from public.marketplace_offers where listing_id = p_listing)
       + (select count(*) from public.marketplace_questions where listing_id = p_listing)
       + (select count(*) from public.marketplace_bids where listing_id = p_listing)
       + (select count(*) from public.marketplace_negotiations where listing_id = p_listing)
       + (select count(*) from public.marketplace_negotiation_rounds where listing_id = p_listing)
       + (select count(*) from public.marketplace_handoffs where listing_id = p_listing)
       + (select count(*) from public.marketplace_reports where listing_id = p_listing);
$fn$;

do $$
declare
  seller    constant text := '00000000-0000-4000-8505-0000000000a1';
  refused   constant text := '42501: A listing other families hold records of is withdrawn, not removed';
  installed boolean := to_regprocedure('public.marketplace_listing_keeps_others_records()') is not null;
  failures  text[] := '{}';
  t         record;
  got       text;
  n         int;
  before_n  int;
begin
  -- 1. The seller's delete of each listing other families hold a record of.
  for t in select * from (values
      ('00000000-0000-4000-8505-0000000000d1'::uuid, 'an order and a report', 2),
      ('00000000-0000-4000-8505-0000000000d2'::uuid, 'an offer', 1),
      ('00000000-0000-4000-8505-0000000000d3'::uuid, 'a question', 1),
      ('00000000-0000-4000-8505-0000000000d4'::uuid, 'a bid', 1),
      ('00000000-0000-4000-8505-0000000000d5'::uuid, 'a negotiation and its round', 2),
      ('00000000-0000-4000-8505-0000000000d6'::uuid, 'only a report, which the seller cannot see', 1)
    ) as v(listing, what, records) loop
    got := pg_temp.m0505_as(seller, format('delete from public.marketplace_listings where id = %L', t.listing));
    if got is distinct from refused then
      failures := array_append(failures, format('the seller deleted their listing with %s (%s)', t.what, got));
    end if;
    select count(*) into n from public.marketplace_listings where id = t.listing;
    if n <> 1 or pg_temp.m0505_records(t.listing) <> t.records then
      failures := array_append(failures, format('after the seller''s delete, the listing with %s is %s and holds %s of its %s records',
        t.what, case when n = 1 then 'there' else 'gone' end, pg_temp.m0505_records(t.listing), t.records));
    end if;
  end loop;

  -- 2. Withdrawing keeps the records (a listing of its own, so this control
  --    does not depend on the refusals above).
  got := pg_temp.m0505_as(seller, format('select public.marketplace_set_listing_status(%L, %L)', '00000000-0000-4000-8505-0000000000da', 'withdrawn'));
  select count(*) into n from public.marketplace_listings where id = '00000000-0000-4000-8505-0000000000da' and status = 'withdrawn';
  if got is distinct from 'OK 1' or n <> 1 or pg_temp.m0505_records('00000000-0000-4000-8505-0000000000da') <> 2 then
    failures := array_append(failures, format('CONTROL: the seller could not withdraw the listing with an order and a report, keeping both (%s; %s withdrawn; %s records)',
      got, n, pg_temp.m0505_records('00000000-0000-4000-8505-0000000000da')));
  end if;

  -- 3. A listing nobody dealt with still deletes.
  got := pg_temp.m0505_as(seller, format('delete from public.marketplace_listings where id = %L', '00000000-0000-4000-8505-0000000000d7'));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the seller could not delete a listing nobody has dealt with (%s)', got));
  end if;

  -- 4. The exemptions, each counted: the service role carrying the seller's
  --    user id (only the service-role branch can exempt it), and a writer with
  --    no session (null uid).
  begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claim.sub', seller, true);
    perform set_config('request.jwt.claims', json_build_object('sub', seller, 'role', 'service_role')::text, true);
    if auth.uid() is null then
      failures := array_append(failures, 'CONTROL (service role): auth.uid() is null, so this does not separate the service-role exemption from the null-uid one');
    end if;
    delete from public.marketplace_listings where id = '00000000-0000-4000-8505-0000000000d8';
    get diagnostics n = row_count;
    perform set_config('role', 'postgres', true);
    if n <> 1 or pg_temp.m0505_records('00000000-0000-4000-8505-0000000000d8') <> 0 then
      failures := array_append(failures, format('CONTROL (service role): its delete removed %s listing(s), leaving %s records', n, pg_temp.m0505_records('00000000-0000-4000-8505-0000000000d8')));
    end if;
  exception when others then
    perform set_config('role', 'postgres', true);
    failures := array_append(failures, format('CONTROL (service role): refused (%s: %s)', sqlstate, sqlerrm));
  end;
  begin
    perform set_config('role', 'postgres', true);
    perform set_config('request.jwt.claim.sub', '', true);
    perform set_config('request.jwt.claims', '', true);
    if auth.uid() is not null then
      failures := array_append(failures, 'CONTROL (session-less writer): auth.uid() is not null, so this is not the null-uid case');
    end if;
    delete from public.marketplace_listings where id = '00000000-0000-4000-8505-0000000000d9';
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures, format('CONTROL (session-less writer, null uid): its delete removed %s listing(s), not 1', n));
    end if;
  exception when others then
    failures := array_append(failures, format('CONTROL (session-less writer, null uid): refused (%s: %s)', sqlstate, sqlerrm));
  end;

  -- 6. Wiring.
  if not exists (select 1 from pg_trigger tr
                  where tr.tgrelid = 'public.marketplace_listings'::regclass
                    and tr.tgfoid = to_regprocedure('public.marketplace_listing_keeps_others_records()')
                    and tr.tgenabled <> 'D'
                    and (tr.tgtype & 2) = 2 and (tr.tgtype & 1) = 1 and (tr.tgtype & 8) = 8) then
    failures := array_append(failures, 'marketplace_listings carries no enabled BEFORE DELETE guard for other families'' records');
  end if;
  if installed and not exists (select 1 from pg_proc f
                                where f.oid = to_regprocedure('public.marketplace_listing_keeps_others_records()')
                                  and f.prosecdef
                                  and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    failures := array_append(failures, 'the guard is not SECURITY DEFINER with a pinned search_path');
  end if;

  if installed then
    -- M1. Without the reports clause, the listing with only a report goes.
    begin
      execute replace(pg_get_functiondef(to_regprocedure('public.marketplace_listing_keeps_others_records()')),
        '
     or exists (select 1 from public.marketplace_reports x where x.listing_id = old.id)', '');
      got := pg_temp.m0505_as(seller, format('delete from public.marketplace_listings where id = %L', '00000000-0000-4000-8505-0000000000d6'));
      if got is distinct from 'OK 1' then
        failures := array_append(failures, format('MUTATION M1: without the reports clause the listing with only a report still was not deleted (%s), so its refusal is not that clause''s', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- N1. With the guard disabled, the order goes with the listing.
    begin
      alter table public.marketplace_listings disable trigger trg_marketplace_listing_keeps_others_records;
      got := pg_temp.m0505_as(seller, format('delete from public.marketplace_listings where id = %L', '00000000-0000-4000-8505-0000000000d2'));
      if got is distinct from 'OK 1' or pg_temp.m0505_records('00000000-0000-4000-8505-0000000000d2') <> 0 then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guard disabled the seller''s delete of the listing with an offer did not take it (%s), so this fixture cannot see the cascade', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  -- 5. RECORDED LIMIT: a family's own deletion still takes its listings,
  --    records included (the family-gone branch): Closing House's listing has
  --    an offer and a report. Pinned so a change to it is seen, not endorsed.
  got := pg_temp.m0505_as('00000000-0000-4000-8505-0000000000c1', format('delete from public.families where id = %L', '00000000-0000-4000-8505-0000000000f3'));
  select count(*) into n from public.marketplace_listings where id = '00000000-0000-4000-8505-0000000000db';
  if got is distinct from 'OK 1' or n <> 0 or pg_temp.m0505_records('00000000-0000-4000-8505-0000000000db') <> 0 then
    failures := array_append(failures, format('RECORDED LIMIT changed: Closing House''s own deletion did not take its listing with an offer and a report as recorded (%s; %s listing(s), %s records left); re-read the retention limit',
      got, n, pg_temp.m0505_records('00000000-0000-4000-8505-0000000000db')));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a listing other families hold records of can be erased:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-listing-others-hold-records-of-is-withdrawn-not-erased: OK (the seller''s delete of their listing with an order, an offer, a question, a bid, a negotiation with its round, and one with only a report they cannot see was each refused with the guard''s own sentence (42501, exact), and every listing and record is still there (counted); the seller withdrew the listing with the order and the report and both remain; a listing nobody dealt with still deletes (OK 1); the service role (with a user id) and, separately, a null-uid writer each deleted a listing with records (1 row each); a family''s own deletion took its listing, records included; the guard is an enabled BEFORE DELETE row trigger, SECURITY DEFINER; mutation M1 and negative control N1 each let the refused delete land)';
end $$;

rollback;

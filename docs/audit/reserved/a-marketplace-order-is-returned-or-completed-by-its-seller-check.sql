-- ── A marketplace order is returned or completed by its seller (0518) ───────
--
-- setOrderStatusAction makes `returned` and `completed` the seller's steps,
-- but marketplace_orders_update (0483) lets either party write `status` (and
-- `returned_at`) directly through PostgREST. The held 0518 refuses a client's
-- change of status to returned or completed, or of returned_at, unless the
-- caller is the order's seller_member.
--
-- What this probe asserts, through PostgREST's role, each outcome exact
-- (`OK <rows>` or the SQLSTATE and the guard's own sentence). Seller House
-- lends a ladder and sells lamps; Buyer House's parent is the buyer:
--
--   1. the buyer's direct UPDATE of their active borrow to `returned`, of their
--      active sale to `completed`, of their returned borrow to `completed`, of
--      `returned_at` on their active borrow, and of a borrow whose seller's
--      member row is gone to `returned`, is each refused with 42501 and the
--      guard's sentence, and each row is unchanged (read back);
--   2. a buyer inside the seller's own family (an in-family order) is refused
--      the same way: the rule is the seller member, not the seller's family;
--   3. a non-party is filtered by the update policy (OK 0, row unchanged): the
--      buyer's sibling, the seller's co-parent (a manager of the seller's
--      family who is not the seller), and a parent of a third family;
--   4. control: the seller marks their order returned, then completed, and
--      stamps returned_at on another (OK 1 each, read back);
--   5. control: the buyer's own steps still land: confirm, start, and edit the
--      arrangements on one order, cancel another, and edit the notes on one
--      the seller already marked returned (OK 1 each);
--   6. control: the buyer completes an order in person with the hand-off code
--      (marketplace_complete_handoff, SECURITY DEFINER), and it is completed;
--   7. control: the service role (carrying the buyer's user id, so only the
--      service-role branch can exempt it) and, separately, a session-less
--      writer (null uid) each complete an order the buyer could not (OK 1);
--   8. wiring: an enabled BEFORE UPDATE row trigger, SECURITY INVOKER (keyed
--      on current_user, which a definer would make the owner) with an empty
--      pinned search_path;
--
-- and, only where 0518 is installed, each in a rolled-back subtransaction:
--
--   M1. MUTATION: the guard without its returned_at clause lets the buyer stamp
--       returned_at;
--   M2. MUTATION: the guard keyed on membership of the seller's family instead
--       of the seller member lets the in-family buyer complete their order;
--   N1. NEGATIVE CONTROL: with the guard disabled, the buyer's `returned` on
--       their active borrow lands.
--
-- Everything is rolled back.
--
-- HELD with 0518: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/marketplace-order-finish-runtime.yml runs it there to show
-- the failure, then applies the held migration and requires it to pass. It
-- moves back to docs/audit/ when 0518 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8518-0000000000a1','m0518-seller@example.com'),
  ('00000000-0000-4000-8518-0000000000a2','m0518-coparent@example.com'),
  ('00000000-0000-4000-8518-0000000000a3','m0518-infamily-buyer@example.com'),
  ('00000000-0000-4000-8518-0000000000b1','m0518-buyer@example.com'),
  ('00000000-0000-4000-8518-0000000000b2','m0518-sibling@example.com'),
  ('00000000-0000-4000-8518-0000000000c1','m0518-outsider@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8518-0000000000f1','Seller House','00000000-0000-4000-8518-0000000000a1'),
  ('00000000-0000-4000-8518-0000000000f2','Buyer House','00000000-0000-4000-8518-0000000000b1'),
  ('00000000-0000-4000-8518-0000000000f3','Other House','00000000-0000-4000-8518-0000000000c1');
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8518-0000000000a1','00000000-0000-4000-8518-0000000000b1','00000000-0000-4000-8518-0000000000c1');
-- Written as the server writes them (no session), so this probe tests the
-- order update, not each table's own insert rules.
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8518-0000000000f1','00000000-0000-4000-8518-0000000000a2','Co-parent','parent',true),
  ('00000000-0000-4000-8518-0000000000f1','00000000-0000-4000-8518-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8518-0000000000f2','00000000-0000-4000-8518-0000000000b2','Sibling','teen',true);

do $$
declare
  seller_f constant uuid := '00000000-0000-4000-8518-0000000000f1';
  buyer_f  constant uuid := '00000000-0000-4000-8518-0000000000f2';
  seller_m uuid := (select id from public.family_members where family_id = '00000000-0000-4000-8518-0000000000f1' and user_id = '00000000-0000-4000-8518-0000000000a1');
  teen_m   uuid := (select id from public.family_members where family_id = '00000000-0000-4000-8518-0000000000f1' and user_id = '00000000-0000-4000-8518-0000000000a3');
  buyer_m  uuid := (select id from public.family_members where family_id = '00000000-0000-4000-8518-0000000000f2' and user_id = '00000000-0000-4000-8518-0000000000b1');
begin
  insert into public.marketplace_listings (id, family_id, member_id, title, kind, price_cents, status) values
    ('00000000-0000-4000-8518-0000000000d1', seller_f, seller_m, 'Ladder (lent)', 'borrow', 0,    'claimed'),
    ('00000000-0000-4000-8518-0000000000d2', seller_f, seller_m, 'Lamps (sold)',  'sell',   2000, 'claimed');
  insert into public.marketplace_orders (id, family_id, buyer_family_id, listing_id, buyer_member, seller_member, kind, status, amount_cents, ends_on) values
    -- Cross-family, Buyer House buying from Seller House.
    ('00000000-0000-4000-8518-000000000e01', seller_f, buyer_f, '00000000-0000-4000-8518-0000000000d1', buyer_m, seller_m, 'borrow', 'active',    0,    current_date - 3),
    ('00000000-0000-4000-8518-000000000e02', seller_f, buyer_f, '00000000-0000-4000-8518-0000000000d2', buyer_m, seller_m, 'buy',    'active',    2000, null),
    ('00000000-0000-4000-8518-000000000e03', seller_f, buyer_f, '00000000-0000-4000-8518-0000000000d1', buyer_m, seller_m, 'borrow', 'returned',  0,    current_date - 1),
    ('00000000-0000-4000-8518-000000000e04', seller_f, buyer_f, '00000000-0000-4000-8518-0000000000d1', buyer_m, seller_m, 'borrow', 'active',    0,    current_date - 3),
    ('00000000-0000-4000-8518-000000000e05', seller_f, buyer_f, '00000000-0000-4000-8518-0000000000d2', buyer_m, seller_m, 'buy',    'requested', 2000, null),
    ('00000000-0000-4000-8518-000000000e06', seller_f, buyer_f, '00000000-0000-4000-8518-0000000000d1', buyer_m, seller_m, 'borrow', 'confirmed', 0,    current_date + 7),
    ('00000000-0000-4000-8518-000000000e07', seller_f, buyer_f, '00000000-0000-4000-8518-0000000000d2', buyer_m, seller_m, 'buy',    'active',    2000, null),
    ('00000000-0000-4000-8518-000000000e09', seller_f, buyer_f, '00000000-0000-4000-8518-0000000000d1', buyer_m, seller_m, 'borrow', 'returned',  0,    current_date - 1),
    -- The lender's member row is gone (seller_member is set null): nobody is
    -- left to say it came back, and the buyer still may not.
    ('00000000-0000-4000-8518-000000000e0a', seller_f, buyer_f, '00000000-0000-4000-8518-0000000000d1', buyer_m, null,     'borrow', 'active',    0,    current_date - 3),
    -- In-family: Seller House's teen buys from Seller House's parent.
    ('00000000-0000-4000-8518-000000000e08', seller_f, seller_f, '00000000-0000-4000-8518-0000000000d2', teen_m, seller_m, 'buy',   'active',    2000, null);
  -- A confirmed pickup for the in-person code.
  insert into public.marketplace_handoffs (order_id, family_id, listing_id, proposed_by, proposer_role, status, confirm_code, confirmed_at)
    values ('00000000-0000-4000-8518-000000000e07', seller_f, '00000000-0000-4000-8518-0000000000d2', seller_m, 'seller', 'confirmed', 'K7Q2M9', now());
end
$$;

-- One statement as one signed-in user, and exactly what happened.
create or replace function pg_temp.m0518_as(p_uid text, p_sql text) returns text
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

-- An order's status and whether it carries returned_at, as the server sees it.
create or replace function pg_temp.m0518_state(p_order uuid) returns text
language sql as $fn$
  select status || case when returned_at is null then '' else ' (returned_at set)' end
    from public.marketplace_orders where id = p_order;
$fn$;

do $$
declare
  seller    constant text := '00000000-0000-4000-8518-0000000000a1';
  coparent  constant text := '00000000-0000-4000-8518-0000000000a2';
  teen      constant text := '00000000-0000-4000-8518-0000000000a3';
  buyer     constant text := '00000000-0000-4000-8518-0000000000b1';
  sibling   constant text := '00000000-0000-4000-8518-0000000000b2';
  outsider  constant text := '00000000-0000-4000-8518-0000000000c1';
  o_lent    constant uuid := '00000000-0000-4000-8518-000000000e01';
  o_sold    constant uuid := '00000000-0000-4000-8518-000000000e02';
  o_back    constant uuid := '00000000-0000-4000-8518-000000000e03';
  o_stamp   constant uuid := '00000000-0000-4000-8518-000000000e04';
  o_new     constant uuid := '00000000-0000-4000-8518-000000000e05';
  o_off     constant uuid := '00000000-0000-4000-8518-000000000e06';
  o_code    constant uuid := '00000000-0000-4000-8518-000000000e07';
  o_inhouse constant uuid := '00000000-0000-4000-8518-000000000e08';
  o_kept    constant uuid := '00000000-0000-4000-8518-000000000e09';
  o_orphan  constant uuid := '00000000-0000-4000-8518-000000000e0a';
  refused   constant text := '42501: Only the seller marks a marketplace order returned or completed';
  installed boolean := to_regprocedure('public.marketplace_order_is_finished_by_its_seller()') is not null;
  failures  text[] := '{}';
  t         record;
  got       text;
  def       text;
  mutated   text;
  n         int;
begin
  -- 1-2. The buyer finishing an order themselves, directly.
  for t in select * from (values
      (buyer, o_lent,    'set status = ''returned''',   'the buyer marked their active borrow returned',   'active'),
      (buyer, o_sold,    'set status = ''completed''',  'the buyer marked their active sale completed',    'active'),
      (buyer, o_back,    'set status = ''completed''',  'the buyer marked their returned borrow completed', 'returned'),
      (buyer, o_stamp,   'set returned_at = now()',      'the buyer stamped their active borrow returned_at', 'active'),
      (buyer, o_orphan,  'set status = ''returned''',   'the buyer marked their active borrow with no seller left returned', 'active'),
      (teen,  o_inhouse, 'set status = ''completed''',  'the in-family buyer marked their active sale completed', 'active')
    ) as v(who, ord, change, what, kept) loop
    got := pg_temp.m0518_as(t.who, format('update public.marketplace_orders %s where id = %L', t.change, t.ord));
    if got is distinct from refused then
      failures := array_append(failures, format('%s (%s)', t.what, got));
    end if;
    if pg_temp.m0518_state(t.ord) is distinct from t.kept then
      failures := array_append(failures, format('after that, the order is %s, not %s', pg_temp.m0518_state(t.ord), t.kept));
    end if;
  end loop;

  -- 3. A non-party never reaches the guard: the update policy filters them.
  def := pg_temp.m0518_state(o_sold);
  for t in select * from (values
      (sibling,  'the buyer''s sibling'),
      (coparent, 'the seller''s co-parent, a manager of the seller''s family'),
      (outsider, 'a parent of a third family')
    ) as v(who, what) loop
    got := pg_temp.m0518_as(t.who, format('update public.marketplace_orders set status = ''completed'' where id = %L', o_sold));
    if got is distinct from 'OK 0' then
      failures := array_append(failures, format('CONTROL: %s, party to nothing, was not filtered from the sale (%s)', t.what, got));
    end if;
  end loop;
  if pg_temp.m0518_state(o_sold) is distinct from def then
    failures := array_append(failures, format('CONTROL: the sale went from %s to %s while only non-parties wrote it', def, pg_temp.m0518_state(o_sold)));
  end if;

  if installed then
    def := pg_get_functiondef(to_regprocedure('public.marketplace_order_is_finished_by_its_seller()'));

    -- M1. Without the returned_at clause, the buyer's stamp lands.
    begin
      mutated := replace(def, '
     or new.returned_at is distinct from old.returned_at then', ' then');
      if mutated = def then
        failures := array_append(failures, 'MUTATION M1: the returned_at clause was not found in the guard, so this mutation tests nothing');
      end if;
      execute mutated;
      got := pg_temp.m0518_as(buyer, format('update public.marketplace_orders set returned_at = now() where id = %L', o_stamp));
      if got is distinct from 'OK 1' then
        failures := array_append(failures, format('MUTATION M1: without the returned_at clause the buyer''s stamp still did not land (%s), so its refusal is not that clause''s', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M2. Keyed on the seller's family instead of the seller, the in-family
    --     buyer completes their own order.
    begin
      mutated := replace(def, 'public.marketplace_member_id(new.family_id) is distinct from new.seller_member',
                              'not public.is_family_member(new.family_id)');
      if mutated = def then
        failures := array_append(failures, 'MUTATION M2: the seller-member test was not found in the guard, so this mutation tests nothing');
      end if;
      execute mutated;
      got := pg_temp.m0518_as(teen, format('update public.marketplace_orders set status = ''completed'' where id = %L', o_inhouse));
      if got is distinct from 'OK 1' then
        failures := array_append(failures, format('MUTATION M2: keyed on the seller''s family, the in-family buyer still could not complete their order (%s)', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- N1. With the guard disabled, the buyer's `returned` lands.
    begin
      alter table public.marketplace_orders disable trigger trg_marketplace_orders_finished_by_its_seller;
      got := pg_temp.m0518_as(buyer, format('update public.marketplace_orders set status = ''returned'' where id = %L', o_lent));
      if got is distinct from 'OK 1' or pg_temp.m0518_state(o_lent) is distinct from 'returned' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the guard disabled the buyer''s returned did not land (%s; %s), so this fixture cannot see the defect', got, pg_temp.m0518_state(o_lent)));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  -- 4. The seller finishes their own orders.
  got := pg_temp.m0518_as(seller, format('update public.marketplace_orders set status = ''returned'' where id = %L', o_lent));
  if got is distinct from 'OK 1' or pg_temp.m0518_state(o_lent) is distinct from 'returned' then
    failures := array_append(failures, format('CONTROL: the seller could not mark their lent ladder returned (%s; %s)', got, pg_temp.m0518_state(o_lent)));
  end if;
  got := pg_temp.m0518_as(seller, format('update public.marketplace_orders set status = ''completed'' where id = %L', o_lent));
  if got is distinct from 'OK 1' or pg_temp.m0518_state(o_lent) is distinct from 'completed' then
    failures := array_append(failures, format('CONTROL: the seller could not then mark it completed (%s; %s)', got, pg_temp.m0518_state(o_lent)));
  end if;
  got := pg_temp.m0518_as(seller, format('update public.marketplace_orders set returned_at = now() where id = %L', o_stamp));
  if got is distinct from 'OK 1' or pg_temp.m0518_state(o_stamp) is distinct from 'active (returned_at set)' then
    failures := array_append(failures, format('CONTROL: the seller could not stamp returned_at (%s; %s)', got, pg_temp.m0518_state(o_stamp)));
  end if;

  -- 5. The buyer's own steps.
  for t in select * from (values
      (o_new, 'set status = ''confirmed''',                          'confirm',                  'confirmed'),
      (o_new, 'set status = ''active''',                             'start',                    'active'),
      (o_new, 'set notes = ''by the shed'', ends_on = current_date', 'edit the arrangements on', 'active'),
      (o_off, 'set status = ''cancelled''',                          'cancel',                   'cancelled'),
      (o_kept, 'set notes = ''left on the porch''',                  'edit the notes on',        'returned')
    ) as v(ord, change, what, became) loop
    got := pg_temp.m0518_as(buyer, format('update public.marketplace_orders %s where id = %L', t.change, t.ord));
    if got is distinct from 'OK 1' or pg_temp.m0518_state(t.ord) is distinct from t.became then
      failures := array_append(failures, format('CONTROL: the buyer could not %s their own order (%s; %s)', t.what, got, pg_temp.m0518_state(t.ord)));
    end if;
  end loop;

  -- 6. In person, with the code: the RPC's own write is the definer's.
  got := pg_temp.m0518_as(buyer, format(
    'select 1 where (public.marketplace_complete_handoff(%L, %L) ->> ''ok'')::boolean', o_code, 'K7Q2M9'));
  if got is distinct from 'OK 1' or pg_temp.m0518_state(o_code) is distinct from 'completed' then
    failures := array_append(failures, format('CONTROL: the buyer could not complete the order in person with the hand-off code (%s; %s)', got, pg_temp.m0518_state(o_code)));
  end if;

  -- 7. The exemptions, each counted.
  begin
    perform set_config('role', 'service_role', true);
    perform set_config('request.jwt.claim.sub', buyer, true);
    perform set_config('request.jwt.claims', json_build_object('sub', buyer, 'role', 'service_role')::text, true);
    if auth.uid() is null then
      failures := array_append(failures, 'CONTROL (service role): auth.uid() is null, so this does not separate the service-role exemption from the null-uid one');
    end if;
    update public.marketplace_orders set status = 'completed' where id = o_sold;
    get diagnostics n = row_count;
    perform set_config('role', 'postgres', true);
    if n <> 1 or pg_temp.m0518_state(o_sold) is distinct from 'completed' then
      failures := array_append(failures, format('CONTROL (service role): its update completed %s order(s); the sale is %s', n, pg_temp.m0518_state(o_sold)));
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
    update public.marketplace_orders set status = 'completed' where id = o_back;
    get diagnostics n = row_count;
    if n <> 1 or pg_temp.m0518_state(o_back) is distinct from 'completed' then
      failures := array_append(failures, format('CONTROL (session-less writer, null uid): its update completed %s order(s); the borrow is %s', n, pg_temp.m0518_state(o_back)));
    end if;
  exception when others then
    failures := array_append(failures, format('CONTROL (session-less writer, null uid): refused (%s: %s)', sqlstate, sqlerrm));
  end;

  -- 8. Wiring.
  if not exists (select 1 from pg_trigger tr
                  where tr.tgrelid = 'public.marketplace_orders'::regclass
                    and tr.tgfoid = to_regprocedure('public.marketplace_order_is_finished_by_its_seller()')
                    and tr.tgenabled <> 'D'
                    and (tr.tgtype & 2) = 2 and (tr.tgtype & 1) = 1 and (tr.tgtype & 16) = 16) then
    failures := array_append(failures, 'marketplace_orders carries no enabled BEFORE UPDATE guard for the seller''s steps');
  end if;
  if installed and not exists (select 1 from pg_proc f
                                where f.oid = to_regprocedure('public.marketplace_order_is_finished_by_its_seller()')
                                  and not f.prosecdef
                                  and exists (select 1 from unnest(f.proconfig) c where c = 'search_path=""')) then
    failures := array_append(failures, 'the guard is not SECURITY INVOKER with an empty pinned search_path');
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a marketplace order can be finished by someone other than its seller:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-marketplace-order-is-returned-or-completed-by-its-seller: OK (the buyer''s direct returned on an active borrow, completed on an active sale and on a returned borrow, and returned_at stamp, and returned on a borrow with no seller left, were each refused with the guard''s own sentence (42501, exact), as was an in-family buyer''s completed, and each order is unchanged (read back); the buyer''s sibling, the seller''s co-parent and a third family were filtered (OK 0); the seller marked returned, then completed, and stamped returned_at; the buyer still confirmed, started, edited and cancelled their own orders, edited the notes on a returned one, and completed one in person with the hand-off code; the service role (with a user id) and a null-uid writer each completed an order; the guard is an enabled BEFORE UPDATE row trigger, SECURITY INVOKER with search_path pinned empty; mutations M1 and M2 and negative control N1 each let the refused write land)';
end $$;

rollback;

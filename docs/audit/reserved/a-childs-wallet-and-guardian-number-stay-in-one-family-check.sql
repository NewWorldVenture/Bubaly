-- ── A child's wallet and a Guardian number stay in one family ──────────────
--
-- 0311's class, second wave. Each of these write policies checks only the
-- row's own family_id, so family A's parent could write A's family_id beside
-- family B's member, wallet or medication. Something running as the service
-- role then acted on that foreign id by itself: Guardian dialled and named B's
-- member, the public gift page named B's child, card issuing would send B's
-- child's name to Stripe as the cardholder, and the morning brief embedded
-- B's medication's name through a schedule.
--
-- For each of the five bindings, as family A's parent through PostgREST's
-- role, this probe asserts:
--
--   1. INSERT of a row naming B's object is refused BY THE GUARD: sqlstate
--      42501 with reference_shares_family's own sentence ("points at a row in
--      another family"), not merely any refusal and not merely no row;
--   2. control: the same INSERT naming A's own object lands (counted);
--   3. UPDATE of that own row's reference to B's object is refused by the
--      guard, and the row is unchanged;
--   4. UPDATE of that own row's family_id to B is refused by the guard (the
--      trigger fires on family_id too, before RLS's WITH CHECK);
--
-- and, once for the class:
--
--   5. control: the service role (role service_role, its own claims) is
--      exempt, and its foreign row lands (counted);
--   6. control: a session-less writer (postgres, empty claims: a migration,
--      seed or backfill) is exempt, separately, and its foreign row lands;
--   7. each of the five references is wired to 0311's helper, exactly;
--   8. NEGATIVE CONTROL: with the gift link trigger disabled inside the
--      transaction, A's foreign gift link lands. That proves the fixture
--      reaches the defect.
--
-- Everything is rolled back.
--
-- HELD with 0497: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/family-reference-wave-two-runtime.yml runs it there to
-- show the failure, then applies the held migration and requires it to pass.
-- It moves back to docs/audit/ when 0497 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8497-0000000000a1','m0497-parent-a@example.com'),
  ('00000000-0000-4000-8497-0000000000b1','m0497-parent-b@example.com')
  on conflict do nothing;
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8497-0000000000f1','Wallet House A','00000000-0000-4000-8497-0000000000a1'),
  ('00000000-0000-4000-8497-0000000000f2','Wallet House B','00000000-0000-4000-8497-0000000000b1')
  on conflict do nothing;
update public.family_members set role = 'parent', is_active = true
 where user_id in ('00000000-0000-4000-8497-0000000000a1','00000000-0000-4000-8497-0000000000b1');
insert into public.family_members (id, family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8497-0000000000d1','00000000-0000-4000-8497-0000000000f1',null,'A Kid','child',true),
  ('00000000-0000-4000-8497-0000000000d3','00000000-0000-4000-8497-0000000000f1',null,'A Second Kid','child',true),
  ('00000000-0000-4000-8497-0000000000d2','00000000-0000-4000-8497-0000000000f2',null,'B Kid','child',true);
insert into public.child_wallets (id, family_id, member_id) values
  ('00000000-0000-4000-8497-0000000000c1','00000000-0000-4000-8497-0000000000f1','00000000-0000-4000-8497-0000000000d1'),
  ('00000000-0000-4000-8497-0000000000c2','00000000-0000-4000-8497-0000000000f2','00000000-0000-4000-8497-0000000000d2');
insert into public.medications (id, family_id, name, is_active) values
  ('00000000-0000-4000-8497-0000000000e1','00000000-0000-4000-8497-0000000000f1','A medication',true),
  ('00000000-0000-4000-8497-0000000000e2','00000000-0000-4000-8497-0000000000f2','B medication',true);

do $$
declare
  fam_a   uuid := '00000000-0000-4000-8497-0000000000f1';
  fam_b   uuid := '00000000-0000-4000-8497-0000000000f2';
  parent  uuid := '00000000-0000-4000-8497-0000000000a1';
  kid_a   uuid := '00000000-0000-4000-8497-0000000000d1';
  kid_a2  uuid := '00000000-0000-4000-8497-0000000000d3';
  kid_b   uuid := '00000000-0000-4000-8497-0000000000d2';
  wal_a   uuid := '00000000-0000-4000-8497-0000000000c1';
  wal_b   uuid := '00000000-0000-4000-8497-0000000000c2';
  med_a   uuid := '00000000-0000-4000-8497-0000000000e1';
  med_b   uuid := '00000000-0000-4000-8497-0000000000e2';
  guard   constant text := '42501: % points at a row in another family';
  failures text[] := '{}';
  b   record;
  got text;
  n   int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', parent, 'role', 'authenticated')::text, true);
  if not public.can_manage_family(fam_a) or public.is_family_member(fam_b) then
    raise exception 'CONTROL: not acting as a manager of A who is not a member of B; nothing below is a boundary';
  end if;

  for b in select * from (values
      ('Guardian profile', 'guardian_member_profiles', 'member_id', 'naming family B''s member',
       format('insert into public.guardian_member_profiles (family_id, member_id, guardian_phone) values (%L, %L, %L)', fam_a, kid_b, '+15550497001'),
       format('insert into public.guardian_member_profiles (family_id, member_id, guardian_phone) values (%L, %L, %L)', fam_a, kid_a, '+15550497002'),
       format('member_id = %L', kid_a), kid_b::text),
      ('gift link', 'gift_links', 'child_wallet_id', 'carrying family B''s child wallet',
       format('insert into public.gift_links (family_id, token, child_wallet_id) values (%L, %L, %L)', fam_a, 'm0497-foreign', wal_b),
       format('insert into public.gift_links (family_id, token, child_wallet_id) values (%L, %L, %L)', fam_a, 'm0497-own', wal_a),
       format('token = %L', 'm0497-own'), wal_b::text),
      ('pay handle', 'pay_handles', 'child_wallet_id', 'carrying family B''s child wallet',
       format('insert into public.pay_handles (family_id, handle, child_wallet_id) values (%L, %L, %L)', fam_a, 'm0497_foreign', wal_b),
       format('insert into public.pay_handles (family_id, handle, child_wallet_id) values (%L, %L, %L)', fam_a, 'm0497_own', wal_a),
       format('handle = %L', 'm0497_own'), wal_b::text),
      ('child wallet', 'child_wallets', 'member_id', 'naming family B''s member',
       format('insert into public.child_wallets (family_id, member_id) values (%L, %L)', fam_a, kid_b),
       format('insert into public.child_wallets (family_id, member_id) values (%L, %L)', fam_a, kid_a2),
       format('member_id = %L', kid_a2), kid_b::text),
      ('medication schedule', 'medication_schedules', 'medication_id', 'naming family B''s medication',
       format('insert into public.medication_schedules (family_id, medication_id, time_of_day) values (%L, %L, %L)', fam_a, med_b, '08:00'),
       format('insert into public.medication_schedules (family_id, medication_id, time_of_day) values (%L, %L, %L)', fam_a, med_a, '09:00'),
       format('medication_id = %L', med_a), med_b::text)
    ) as v(label, tbl, col, tail, foreign_sql, own_sql, own_pred, foreign_ref) loop

    -- 1. The foreign INSERT, refused by the guard itself.
    begin execute b.foreign_sql; got := 'landed';
    exception when others then got := sqlstate || ': ' || sqlerrm; end;
    if got = 'landed' then
      failures := array_append(failures, format('family A''s parent wrote a %s %s', b.label, b.tail));
    elsif got not like guard then
      failures := array_append(failures, format('the foreign %s was refused, but not by the same-family guard (%s)', b.label, got));
    end if;

    -- 2. The same INSERT for A's own object lands.
    begin execute b.own_sql;
    exception when others then
      failures := array_append(failures, format('CONTROL: A''s own %s was refused (%s: %s)', b.label, sqlstate, sqlerrm));
    end;
    execute format('select count(*) from public.%I where family_id = %L and %s', b.tbl, fam_a, b.own_pred) into n;
    if n <> 1 then
      failures := array_append(failures, format('CONTROL: A''s own %s did not land (%s rows)', b.label, n));
      continue;
    end if;

    -- 3. Moving that own row's reference onto B's object.
    begin
      execute format('update public.%I set %I = %L where family_id = %L and %s', b.tbl, b.col, b.foreign_ref, fam_a, b.own_pred);
      get diagnostics n = row_count;
      got := format('updated %s row(s)', n);
    exception when others then got := sqlstate || ': ' || sqlerrm; end;
    if got not like guard then
      failures := array_append(failures, format('moving A''s own %s onto B''s object was not refused by the guard (%s)', b.label, got));
    end if;

    -- 4. Moving that own row into family B.
    begin
      execute format('update public.%I set family_id = %L where family_id = %L and %s', b.tbl, fam_b, fam_a, b.own_pred);
      get diagnostics n = row_count;
      got := format('updated %s row(s)', n);
    exception when others then got := sqlstate || ': ' || sqlerrm; end;
    if got not like guard then
      failures := array_append(failures, format('moving A''s own %s into family B was not refused by the guard (%s)', b.label, got));
    end if;

    -- The own row is exactly as it was written.
    perform set_config('role','postgres', true);
    execute format('select count(*) from public.%I where family_id = %L and %s', b.tbl, fam_a, b.own_pred) into n;
    perform set_config('role','authenticated', true);
    if n <> 1 then
      failures := array_append(failures, format('A''s own %s was changed by a refused update (%s rows left as written)', b.label, n));
    end if;
  end loop;

  -- 5. The service role, with its own claims, is exempt.
  perform set_config('role','service_role', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  begin
    insert into public.gift_links (family_id, token, child_wallet_id) values (fam_a, 'm0497-service', wal_b);
  exception when others then
    failures := array_append(failures, format('CONTROL: the service role''s write was refused (%s: %s)', sqlstate, sqlerrm));
  end;

  -- 6. A session-less writer (postgres, no claims) is exempt, separately.
  perform set_config('role','postgres', true);
  perform set_config('request.jwt.claims', '', true);
  begin
    insert into public.gift_links (family_id, token, child_wallet_id) values (fam_a, 'm0497-server', wal_b);
  exception when others then
    failures := array_append(failures, format('CONTROL: a session-less write was refused (%s: %s)', sqlstate, sqlerrm));
  end;
  select count(*) into n from public.gift_links where token in ('m0497-service', 'm0497-server') and child_wallet_id = wal_b;
  if n <> 2 then
    failures := array_append(failures, format('CONTROL: %s of the 2 exempt writes landed', n));
  end if;

  -- 7. Wiring: each reference runs 0311's helper, exactly.
  select count(*) into n
    from pg_trigger t
   where t.tgfoid = 'public.reference_shares_family()'::regprocedure
     and t.tgenabled <> 'D'
     and (t.tgrelid, encode(t.tgargs, 'escape')) in (
       ('public.guardian_member_profiles'::regclass, E'member_id\\000family_members\\000'),
       ('public.gift_links'::regclass,               E'child_wallet_id\\000child_wallets\\000'),
       ('public.pay_handles'::regclass,              E'child_wallet_id\\000child_wallets\\000'),
       ('public.child_wallets'::regclass,            E'member_id\\000family_members\\000'),
       ('public.medication_schedules'::regclass,     E'medication_id\\000medications\\000'));
  if n <> 5 then failures := array_append(failures, format('%s of 5 references are wired to reference_shares_family', n)); end if;

  -- 8. NEGATIVE CONTROL: without the gift link trigger, the foreign link lands.
  if exists (select 1 from pg_trigger where tgrelid = 'public.gift_links'::regclass and tgname = 'trg_gift_links_child_wallet_id_family') then
    alter table public.gift_links disable trigger trg_gift_links_child_wallet_id_family;
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub', parent::text, true);
    perform set_config('request.jwt.claims', json_build_object('sub', parent, 'role', 'authenticated')::text, true);
    begin insert into public.gift_links (family_id, token, child_wallet_id) values (fam_a, 'm0497-unguarded', wal_b); exception when others then null; end;
    perform set_config('role','postgres', true);
    alter table public.gift_links enable trigger trg_gift_links_child_wallet_id_family;
    select count(*) into n from public.gift_links where token = 'm0497-unguarded';
    if n <> 1 then
      failures := array_append(failures, 'NEGATIVE CONTROL: with the trigger disabled the foreign gift link still did not land, so this fixture cannot see the defect');
    end if;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a family''s row can name another family''s member or wallet:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-childs-wallet-and-guardian-number-stay-in-one-family: OK (for each of the five bindings, as family A''s parent: the foreign INSERT, the reference UPDATE onto B''s object and the family_id UPDATE into B were each refused by the guard itself (42501, its own sentence), and A''s own row landed and stayed as written; the service role and a session-less writer were each exempt and their foreign rows landed; all five references run reference_shares_family; negative control: with the gift link trigger disabled the foreign link landed)';
end $$;

rollback;

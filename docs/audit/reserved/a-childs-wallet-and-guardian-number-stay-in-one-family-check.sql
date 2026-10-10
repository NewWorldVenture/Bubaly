-- ── A child's wallet and a Guardian number stay in one family ──────────────
--
-- 0311's class, second wave. Each of these write policies checks only the
-- row's own family_id, so family A's parent could write A's family_id beside
-- family B's member or wallet. Something running as the service role then
-- acted on that foreign id by itself: Guardian dialled and named B's member,
-- the public gift page named B's child, and card issuing would send B's
-- child's name to Stripe as the cardholder.
--
-- What this probe asserts, as family A's parent through PostgREST's role:
--
--   1. a Guardian profile naming B's member is refused;
--   2. a gift link carrying B's child wallet is refused;
--   3. a pay handle carrying B's child wallet is refused;
--   4. a child wallet naming B's member is refused;
--   5. moving A's own gift link onto B's wallet (UPDATE) is refused;
--   6. control: each of the four, with A's own member or wallet, still lands;
--   7. control: a session-less writer (the server, a migration, a seed) is
--      still exempt, as 0311 made it;
--   8. each of the four references is wired to 0311's helper.
--
-- Judged on ROW COUNTS, as 0311's probe is: a write refused by nothing simply
-- lands, and an exception-only assertion would report a boundary that is not
-- there.
--
-- NEGATIVE CONTROL. Inside this transaction the gift link trigger is disabled,
-- and A's foreign gift link must then land. That proves the fixture reaches
-- the defect. Everything is rolled back.
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
  failures text[] := '{}';
  n int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', parent, 'role', 'authenticated')::text, true);
  if not public.can_manage_family(fam_a) or public.is_family_member(fam_b) then
    raise exception 'CONTROL: not acting as a manager of A who is not a member of B; nothing below is a boundary';
  end if;

  -- Each foreign write, as A's parent. Refusal is measured by what lands.
  begin insert into public.guardian_member_profiles (family_id, member_id, guardian_phone) values (fam_a, kid_b, '+15550497001'); exception when others then null; end;
  begin insert into public.gift_links (family_id, token, child_wallet_id) values (fam_a, 'm0497-foreign', wal_b); exception when others then null; end;
  begin insert into public.pay_handles (family_id, handle, child_wallet_id) values (fam_a, 'm0497_foreign', wal_b); exception when others then null; end;
  begin insert into public.child_wallets (family_id, member_id) values (fam_a, kid_b); exception when others then null; end;

  -- Controls: the same four with A's own member and wallet.
  begin insert into public.guardian_member_profiles (family_id, member_id, guardian_phone) values (fam_a, kid_a, '+15550497002'); exception when others then failures := array_append(failures, 'CONTROL: A''s own Guardian profile was refused: ' || sqlerrm); end;
  begin insert into public.gift_links (family_id, token, child_wallet_id) values (fam_a, 'm0497-own', wal_a); exception when others then failures := array_append(failures, 'CONTROL: A''s own gift link was refused: ' || sqlerrm); end;
  begin insert into public.pay_handles (family_id, handle, child_wallet_id) values (fam_a, 'm0497_own', wal_a); exception when others then failures := array_append(failures, 'CONTROL: A''s own pay handle was refused: ' || sqlerrm); end;
  begin insert into public.child_wallets (family_id, member_id) values (fam_a, kid_a2); exception when others then failures := array_append(failures, 'CONTROL: A''s own child wallet was refused: ' || sqlerrm); end;

  -- Moving A's own gift link onto B's wallet.
  begin update public.gift_links set child_wallet_id = wal_b where token = 'm0497-own'; exception when others then null; end;

  perform set_config('role','postgres', true);
  select count(*) into n from public.guardian_member_profiles where family_id = fam_a and member_id = kid_b;
  if n <> 0 then failures := array_append(failures, 'family A''s parent wrote a Guardian profile naming family B''s member'); end if;
  select count(*) into n from public.gift_links where family_id = fam_a and child_wallet_id = wal_b and token = 'm0497-foreign';
  if n <> 0 then failures := array_append(failures, 'family A''s parent wrote a gift link carrying family B''s child wallet'); end if;
  select count(*) into n from public.pay_handles where family_id = fam_a and child_wallet_id = wal_b;
  if n <> 0 then failures := array_append(failures, 'family A''s parent wrote a pay handle carrying family B''s child wallet'); end if;
  select count(*) into n from public.child_wallets where family_id = fam_a and member_id = kid_b;
  if n <> 0 then failures := array_append(failures, 'family A''s parent wrote a child wallet naming family B''s member'); end if;
  select count(*) into n from public.gift_links where token = 'm0497-own' and child_wallet_id = wal_b;
  if n <> 0 then failures := array_append(failures, 'family A''s parent moved its own gift link onto family B''s child wallet'); end if;
  select count(*) into n from public.guardian_member_profiles where family_id = fam_a and member_id = kid_a;
  if n <> 1 then failures := array_append(failures, 'CONTROL: A''s own Guardian profile did not land'); end if;
  select count(*) into n from public.child_wallets where family_id = fam_a and member_id = kid_a2;
  if n <> 1 then failures := array_append(failures, 'CONTROL: A''s own child wallet did not land'); end if;

  -- Control: a session-less writer is still exempt (0311's rule).
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  begin
    insert into public.gift_links (family_id, token, child_wallet_id) values (fam_a, 'm0497-server', wal_b);
  exception when others then
    failures := array_append(failures, 'CONTROL: a session-less (server) write was refused: ' || sqlerrm);
  end;

  -- Wiring: each reference runs 0311's helper.
  select count(*) into n
    from pg_trigger t
   where t.tgfoid = 'public.reference_shares_family()'::regprocedure
     and t.tgenabled <> 'D'
     and (t.tgrelid, encode(t.tgargs, 'escape')) in (
       ('public.guardian_member_profiles'::regclass, E'member_id\\000family_members\\000'),
       ('public.gift_links'::regclass,               E'child_wallet_id\\000child_wallets\\000'),
       ('public.pay_handles'::regclass,              E'child_wallet_id\\000child_wallets\\000'),
       ('public.child_wallets'::regclass,            E'member_id\\000family_members\\000'));
  if n <> 4 then failures := array_append(failures, format('%s of 4 references are wired to reference_shares_family', n)); end if;

  -- NEGATIVE CONTROL: without the gift link trigger, the foreign link lands.
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
  raise notice 'a-childs-wallet-and-guardian-number-stay-in-one-family: OK (as family A''s parent: a Guardian profile naming B''s member, a gift link and a pay handle carrying B''s child wallet, a child wallet naming B''s member, and moving A''s gift link onto B''s wallet are all refused; A''s own four land; a session-less server write is still exempt; all four references run reference_shares_family; negative control: with the gift link trigger disabled the foreign link landed)';
end $$;

rollback;

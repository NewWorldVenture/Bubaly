-- 0524 — A guest adds nothing to the areas withheld from them.
-- 0464's guard, on nine tables a guest can no longer read. Requested on #771
-- in comment 6402627160, before any SQL. Follows ROLE-M03 (0464: a guest views
-- the household; it does not rewrite it) and ROLE-SCOPE-001 (held 0509 and
-- 0520: these areas are withheld from a guest, page and rows).
--
-- 0509 and 0520 refuse a guest the READ of the household's insurance, utility
-- bills, storage locations, driving, travel medical details, wallet hub and
-- Communications Hub, and lib/auth/guest-scope.ts sends a guest away from
-- their pages. The tables still take a guest's INSERT: measured on a replay of
-- main with every held file through 0522 applied, as an active guest, one row
-- each, rolled back, OK 1 in all nine:
--
--   auto_insurance_policies   driving_trips          family_communications
--   home_locations            utility_bills          vacation_medical_information
--   wallet_cards              wallet_passes          wallet_rewards
--
-- so a guest who cannot see the household's bills or insurance can still add
-- to them: a planted bill, policy, card or Hub message the parents then read
-- as the household's own. (The other tables 0509 guards already refuse a
-- guest's insert: a manager's insert, or a member's own row.)
--
-- This wires 0464's own function onto the nine tables, as 0498 and the held
-- 0522 did on others: trg_<table>_not_a_guests, BEFORE INSERT, UPDATE and
-- DELETE, refusing a caller whose role in the row's family is `guest` with
-- 42501 ("A guest can see the household but not change it"). No new function.
-- Every other role writes as before; the service role and session-less writers
-- stay exempt. A guest's update or delete of these rows is already refused by
-- the held 0523 where they cannot read them; this refuses a guest's own rows
-- too, as 0464 does everywhere.
--
-- No application change: every page over these tables is withheld from a
-- guest (lib/auth/guest-scope.ts), so no screen offers a guest these writes.
--
-- HELD: 0524, requested on #771 in comment 6402627160 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-guest-adds-nothing-to-the-areas-withheld-from-them-check.sql
-- and .github/workflows/guest-withheld-writes-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  t text;
begin
  if to_regprocedure('public.household_write_is_not_a_guests()') is null then
    raise exception '0524 needs household_write_is_not_a_guests() from 0464';
  end if;
  foreach t in array array['auto_insurance_policies', 'driving_trips', 'family_communications', 'home_locations',
                           'utility_bills', 'vacation_medical_information', 'wallet_cards', 'wallet_passes',
                           'wallet_rewards'] loop
    if to_regclass('public.' || t) is null then
      raise exception '0524: public.% does not exist', t;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = t and column_name = 'family_id') then
      raise exception '0524: public.%.family_id does not exist', t;
    end if;
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_not_a_guests', t);
    execute format('create trigger %I before insert or update or delete on public.%I '
                   'for each row execute function public.household_write_is_not_a_guests()',
                   'trg_' || t || '_not_a_guests', t);
  end loop;
end
$$;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger
   where tgfoid = 'public.household_write_is_not_a_guests()'::regprocedure
     and tgenabled <> 'D'
     and tgrelid in ('public.auto_insurance_policies'::regclass, 'public.driving_trips'::regclass,
                     'public.family_communications'::regclass, 'public.home_locations'::regclass,
                     'public.utility_bills'::regclass, 'public.vacation_medical_information'::regclass,
                     'public.wallet_cards'::regclass, 'public.wallet_passes'::regclass, 'public.wallet_rewards'::regclass)
     and (tgtype & 1) = 1                     -- FOR EACH ROW
     and (tgtype & 2) = 2                     -- BEFORE
     and (tgtype & 28) = 28;                  -- INSERT (4), DELETE (8), UPDATE (16)
  if n <> 9 then
    raise exception '0524: % of 9 tables carry the guest guard on insert, update and delete', n;
  end if;
end
$$;

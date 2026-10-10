-- 0497 — A child's wallet and a Guardian number stay in one family.
-- The second wave of 0311's family-scoped references. Found and reproduced
-- 2026-10-10 on a replay of every runnable migration.
--
-- 0311 named the class: every family-scoped INSERT policy checks the row's OWN
-- family_id, and the foreign keys beside it name parent(id) alone, so a member
-- may write their family_id beside a reference into another family. It wired
-- its helper, reference_shares_family(), onto three references and said the
-- next would "cost one line". A replay counts 447 single-column foreign keys
-- between family-scoped tables, 6 of them wired. Most are harmless, because
-- nothing acts on the foreign id: the notification roster, the wallet balance
-- sums and the card hold all key by the caller's own family as well. These
-- four are the ones where something running as the service role acts on the
-- foreign id by itself:
--
--   * guardian_member_profiles.member_id. The Guardian voice and screening
--     callbacks dial that member's phone and greet with their name, so one
--     household's Guardian number rang another household's child.
--   * gift_links.child_wallet_id, and pay_handles.child_wallet_id, which
--     resolves to a gift link. The public gift page and its AI assistant named
--     the wallet's child under the link's household.
--   * child_wallets.member_id. issueCardAction reads the wallet member's name
--     with the service client and sends it to Stripe as the cardholder.
--   * medication_schedules.medication_id. The morning brief (the notifications
--     cron, service role) embeds medications(name, ...) through it, so a
--     schedule naming another family's medication put that family's drug name
--     into this family's brief. A session read hides it (RLS on medications);
--     the embed under the service role does not.
--
-- Measured as family A's parent under RLS, every one of the five writes
-- landed. The first two consumers are already fixed in code (they now read
-- within the row's family); this makes the database refuse the row itself, so
-- the next consumer does not have to remember to.
--
-- In-app writers use only the family's own members and wallets, so nothing
-- legitimate changes. The helper exempts the service role and a session-less
-- caller (migrations, seeds, backfills), as 0311 does. Rows written before
-- this are not touched; the code fixes above already ignore them.
--
-- No new function: this only wires 0311's helper, validating each table first,
-- because a parent table without family_id would make the trigger raise 42703
-- on every authenticated write (0311's own warning).
--
-- HELD: proposed as 0497 (the first number above 0496; requested on #771 in
-- comment 6092501825, not yet confirmed) in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-childs-wallet-and-guardian-number-stay-in-one-family-check.sql
-- and .github/workflows/family-reference-wave-two-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  w record;
begin
  if to_regprocedure('public.reference_shares_family()') is null then
    raise exception '0497 needs reference_shares_family() from 0311';
  end if;
  for w in
    select *
    from (values
      ('guardian_member_profiles', 'member_id',       'family_members'),
      ('gift_links',               'child_wallet_id', 'child_wallets'),
      ('pay_handles',              'child_wallet_id', 'child_wallets'),
      ('child_wallets',            'member_id',       'family_members'),
      ('medication_schedules',     'medication_id',   'medications')
    ) as v(child, col, parent)
  loop
    if to_regclass('public.' || w.child) is null or to_regclass('public.' || w.parent) is null then
      raise exception '0497: public.% or public.% does not exist', w.child, w.parent;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.child and column_name = 'family_id') then
      raise exception '0497: %.family_id does not exist', w.child;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.child and column_name = w.col) then
      raise exception '0497: %.% does not exist', w.child, w.col;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.parent and column_name = 'family_id') then
      raise exception
        '0497: parent %.family_id does not exist, so the guard on %.% would raise 42703 on every authenticated write',
        w.parent, w.child, w.col;
    end if;
    execute format('drop trigger if exists %I on public.%I',
                   'trg_' || w.child || '_' || w.col || '_family', w.child);
    execute format(
      'create trigger %I before insert or update of %I, family_id on public.%I '
      || 'for each row execute function public.reference_shares_family(%L, %L)',
      'trg_' || w.child || '_' || w.col || '_family', w.col, w.child, w.col, w.parent);
  end loop;
end
$$;

do $$
declare
  n int;
begin
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
  if n <> 5 then
    raise exception '0497: % of 5 references are wired to reference_shares_family', n;
  end if;
end
$$;

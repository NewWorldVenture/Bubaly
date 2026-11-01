-- 0523 — A member changes only the rows they can read.
-- Requested on #771 in comment 6402627160, before any SQL. Follows the read
-- decisions already made (0509 and 0520 for a guest; 0514, 0515 and 0517 for
-- the household's money and personal records); asks for none of its own.
--
-- Those decisions are SELECT policies. An UPDATE or DELETE with no WHERE
-- clause and no column read is checked against its own command's policies
-- only, and PostgREST sends exactly that statement for an unfiltered PATCH or
-- DELETE. Where those write policies are still is_family_member(family_id), a
-- member who reads none of a household's rows still rewrites or deletes every
-- one of them. Measured on a replay of main with every held file through 0522
-- applied, one unfiltered statement each, rolled back:
--
--   as a child, who reads 0 rows of each:
--     home_warranties, vehicle_registrations (0514)  update OK 1, delete OK 1
--     vacation_documents (0517)                       update OK 1, delete OK 1
--     voice_commands (0517)                           delete OK 1
--     wallet_cards, wallet_passes, wallet_rewards     update OK 1, delete OK 1
--       (0515: the teen's)
--   as a guest, who reads 0 rows (0509, 0520):
--     auto_insurance_policies, home_locations, utility_bills,
--     vacation_medical_information                    update OK 1, delete OK 1
--     family_communications                           update OK 1
--
-- The rule this enforces is the one those decisions imply and every screen
-- already keeps: a row you are not shown is not yours to change. A BEFORE
-- UPDATE OR DELETE trigger asks, as the caller, whether the caller reads the
-- row being changed, and an AFTER UPDATE trigger whether they read the row the
-- update leaves (so a teen cannot hand their own card to a sibling either); a
-- no refuses with 42501. The question is the table's own read, asked through
-- the caller's row security, so it follows whatever read rule is installed and
-- needs no copy of any predicate.
--
-- A trigger rather than restrictive UPDATE and DELETE policies, for 0464's
-- reasons: a restrictive policy FILTERS (the write matches nothing and
-- PostgREST answers error: null), where a raise is an answer a screen can
-- show; and docs/audit/gated-write-tables-check.sql and the client guard in
-- tests/a-filtered-delete-is-not-a-deletion.test.ts inventory the policies
-- that filter a member's write, which this leaves exactly as they were.
--
-- Nothing widens and no read changes. The service role and session-less
-- writers are exempt (no auth.uid()), as in 0464; a SECURITY DEFINER function
-- or a cascade runs as the table owner, who reads every row. Inserts are not
-- touched (0524 is a guest's). On a schema where these tables still read with
-- plain membership, every member reads every row and this refuses nothing.
--
-- HELD: 0523, requested on #771 in comment 6402627160 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-member-changes-only-the-rows-they-can-read-check.sql
-- and .github/workflows/blind-writes-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

create or replace function public.a_row_you_cannot_read_is_not_yours_to_change()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  readable boolean;
begin
  if auth.uid() is null then
    return case when tg_op = 'DELETE' then old else new end; -- service role / server-side jobs
  end if;
  -- Asked as the caller, so the table's own read decides.
  execute format('select exists (select 1 from %s where id = $1)', tg_relid::regclass)
    into readable
    using case when tg_when = 'BEFORE' then old.id else new.id end;
  if not readable then
    raise exception 'A record you cannot see is not yours to change'
      using errcode = '42501';
  end if;
  if tg_when = 'AFTER' then
    return null;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$$;

comment on function public.a_row_you_cannot_read_is_not_yours_to_change() is
  'Refuses (42501) a signed-in caller''s UPDATE or DELETE of a row they cannot read, and an UPDATE that leaves a row they cannot read (0523). SECURITY INVOKER: the table''s own read, through the caller''s row security, decides. The service role and session-less writers are exempt.';

revoke all on function public.a_row_you_cannot_read_is_not_yours_to_change() from public, anon;

do $$
declare
  t text;
begin
  foreach t in array array['auto_insurance_policies', 'family_communications', 'home_locations', 'utility_bills',
                           'vacation_medical_information', 'wallet_cards', 'wallet_passes', 'wallet_rewards',
                           'home_warranties', 'vehicle_registrations', 'vacation_documents', 'voice_commands'] loop
    if to_regclass('public.' || t) is null
       or not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = t and column_name = 'id') then
      raise exception '0523 needs public.% with an id', t;
    end if;
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_read_before_change', t);
    execute format('drop trigger if exists %I on public.%I', 'trg_' || t || '_read_after_change', t);
    execute format('create trigger %I before update or delete on public.%I '
                   'for each row execute function public.a_row_you_cannot_read_is_not_yours_to_change()',
                   'trg_' || t || '_read_before_change', t);
    execute format('create trigger %I after update on public.%I '
                   'for each row execute function public.a_row_you_cannot_read_is_not_yours_to_change()',
                   'trg_' || t || '_read_after_change', t);
  end loop;
end
$$;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_trigger g
   where g.tgfoid = 'public.a_row_you_cannot_read_is_not_yours_to_change()'::regprocedure
     and g.tgenabled <> 'D' and (g.tgtype & 1) = 1
     and ((g.tgname like 'trg\_%\_read\_before\_change' and (g.tgtype & 2) = 2 and (g.tgtype & 24) = 24 and (g.tgtype & 4) = 0)
          or (g.tgname like 'trg\_%\_read\_after\_change' and (g.tgtype & 2) = 0 and (g.tgtype & 16) = 16 and (g.tgtype & 12) = 0));
  if n <> 24 then
    raise exception '0523: % of 24 triggers (12 tables, before and after) are in place', n;
  end if;
  if exists (select 1 from pg_proc p where p.oid = 'public.a_row_you_cannot_read_is_not_yours_to_change()'::regprocedure
              and (p.prosecdef or p.proconfig is null)) then
    raise exception '0523: the guard must be SECURITY INVOKER with a pinned search_path';
  end if;
end
$$;

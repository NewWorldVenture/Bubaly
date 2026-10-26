-- 0520 — A guest does not read the front desk's call history or the
-- Communications Hub.
-- Follows the account holder's decision on ROLE-SCOPE-001 (held 0509, #771
-- comment 6101674181): a guest does not see the household inbox. Requested on
-- #771 in comment 6402247950, before any SQL.
--
-- That decision withholds three pages from a guest, and lib/auth/guest-scope.ts
-- says why it is three and not one: "the Contact Center lists every message
-- (email, SMS, voicemail transcript) and the AI Front Desk lists the calls".
-- 0509 guards the table behind the Contact Center (family_inbox_messages), but
-- not the other two tables those pages read:
--
--   call_logs              /dashboard/front-desk's call history: the caller,
--                          the transcript, the voicemail URL, the AI summary
--   family_communications  /dashboard/inbox's Communications Hub: subjects,
--                          bodies, summaries and action items of what the
--                          household logged
--
-- Both still read with any active membership (0092's call_logs_select, 00900's
-- comms_family_select), both are in the realtime publication, and measured on
-- a replay of main with every held file through 0518 applied, a guest read the
-- household's rows in both. The pages send a guest away; the rows did not.
-- (paperwork_items, the inbox's third source, is already narrowed by 0514.)
--
-- Each table gets 0509's guard, by 0509's name and in its shape: one
-- RESTRICTIVE SELECT policy, "A guest does not read <table>", USING
-- not is_family_guest(family_id). Neither table has a member_id, so there is no
-- row about the guest to keep. Restrictive, so it narrows the read already
-- there and widens nothing; a guest's update of a row it cannot see changes
-- nothing. Every other role reads as before, and a guest here who is a parent
-- of another household reads that household's rows as before.
--
-- Needs the held 0509 first: is_family_guest() is 0509's (SECURITY DEFINER,
-- pinned search_path, one membership row per family and user). This file
-- refuses to run without it rather than defining a second copy.
--
-- Shipped with the source: the three pages already send a guest to their
-- landing page (lib/auth/guest-scope.ts); the home dashboard stops offering a
-- guest its Front Desk and Inbox tiles, which linked to two of them and showed
-- the household's unread-call and unread-message counts.
--
-- HELD: 0520, requested on #771 in comment 6402247950 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-guest-does-not-read-the-front-desks-call-history-check.sql
-- and .github/workflows/front-desk-guest-runtime.yml. Not applied to production
-- by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  t text;
begin
  if to_regprocedure('public.is_family_guest(uuid)') is null then
    raise exception '0520 needs public.is_family_guest(uuid), which the held 0509 creates; apply 0509 first';
  end if;
  foreach t in array array['call_logs', 'family_communications'] loop
    if to_regclass('public.' || t) is null
       or not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = t and column_name = 'family_id') then
      raise exception '0520 needs public.% with a family_id', t;
    end if;
    execute format('drop policy if exists %I on public.%I', 'A guest does not read ' || t, t);
    execute format('create policy %I on public.%I as restrictive for select to authenticated using (not public.is_family_guest(family_id))',
                   'A guest does not read ' || t, t);
  end loop;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array['call_logs', 'family_communications'] loop
    if not exists (select 1 from pg_policies p
                    where p.schemaname = 'public' and p.tablename = t
                      and p.policyname = 'A guest does not read ' || t
                      and p.permissive = 'RESTRICTIVE' and p.cmd = 'SELECT'
                      and p.roles = '{authenticated}'::name[]
                      and p.qual = '(NOT is_family_guest(family_id))') then
      raise exception '0520: public.% does not carry the guest read guard', t;
    end if;
    if not exists (select 1 from pg_class c where c.oid = ('public.' || t)::regclass and c.relrowsecurity) then
      raise exception '0520: public.% has row security off', t;
    end if;
  end loop;
  if not exists (select 1 from pg_proc f
                  where f.oid = 'public.is_family_guest(uuid)'::regprocedure
                    and f.prosecdef
                    and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    raise exception '0520: is_family_guest is not SECURITY DEFINER with a pinned search_path';
  end if;
end
$$;

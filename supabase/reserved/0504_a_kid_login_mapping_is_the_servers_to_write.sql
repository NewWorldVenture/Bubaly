-- 0504 — A kid login mapping is the server's to write.
-- `child_logins` becomes server-written. Decided by the account holder on the
-- lead in #771 comment 6092615411; found 2026-10-09 during 0495.
--
-- child_logins maps a kid login's username to its synthetic auth user and to the
-- member row it signs in as. 0297 left a manager write policy on it ("Managers
-- manage child_logins", FOR ALL, can_manage_family on both halves), and the
-- table's grants give anon and authenticated every DML verb. Nothing in the
-- application uses that policy: every mapping is written through the service
-- role (app/(app)/family/child-login-actions.ts creates, resets and rolls back;
-- app/(auth)/actions.ts only reads), and the one session read
-- (/dashboard/family-access) is covered by "Members can view child_logins".
--
-- What the policy still allowed is the limit 0495 recorded: a household's parent
-- demotes one of its own adult members to a non-manager role, writes a
-- child_logins row for them, and that adult's invitations elsewhere are then
-- refused as a kid login's. With only the server writing mappings, the mapping
-- clause 0495 relies on is authoritative on its own. It also settles, at the
-- root, 0297's original sibling-tampering concern and the bare-row trust in
-- Support's ensureActiveFamily branch.
--
-- This drops the manager write policy and revokes INSERT, UPDATE and DELETE on
-- child_logins from anon and authenticated. SELECT and the members' read policy
-- are unchanged, so the family-access page and the kid surfaces read as before.
-- The service role keeps every privilege (it bypasses RLS). A household can no
-- longer write a mapping directly, which nothing in the application does.
--
-- Released probe changed with it: docs/audit/child-login-mapping-is-managers-
-- only-check.sql asserted that a parent can still write a mapping, as 0297
-- decided. It now reads which rule is installed: under 0297's, it proves what it
-- always did; with this migration applied, it proves that nobody but the server
-- writes (the parent and the child are each refused, reads stay open). It passes
-- with and without 0504.
--
-- HELD: 0504, the first number above 0503, requested on #771 in comment
-- 6100826185 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-kid-login-mapping-is-the-servers-to-write-check.sql and
-- .github/workflows/kid-login-mapping-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regclass('public.child_logins') is null then
    raise exception '0504 needs public.child_logins';
  end if;
end
$$;

drop policy if exists "Managers manage child_logins" on public.child_logins;
revoke insert, update, delete on public.child_logins from anon, authenticated;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_policy p
   where p.polrelid = 'public.child_logins'::regclass
     and p.polpermissive
     and p.polcmd in ('*', 'a', 'w', 'd')
     and (p.polroles = array[0::oid]
          or p.polroles && array[(select oid from pg_roles where rolname = 'authenticated'),
                                 (select oid from pg_roles where rolname = 'anon')]);
  if n <> 0 then
    raise exception '0504: child_logins still carries % permissive write policies for a client role', n;
  end if;
  if has_table_privilege('authenticated', 'public.child_logins', 'insert')
     or has_table_privilege('authenticated', 'public.child_logins', 'update')
     or has_table_privilege('authenticated', 'public.child_logins', 'delete')
     or has_table_privilege('anon', 'public.child_logins', 'insert')
     or has_table_privilege('anon', 'public.child_logins', 'update')
     or has_table_privilege('anon', 'public.child_logins', 'delete') then
    raise exception '0504: a client role still holds INSERT, UPDATE or DELETE on child_logins';
  end if;
  if not has_table_privilege('authenticated', 'public.child_logins', 'select')
     or not exists (select 1 from pg_policy p
                     where p.polrelid = 'public.child_logins'::regclass and p.polcmd = 'r') then
    raise exception '0504: the members'' read of child_logins is gone; it must stay';
  end if;
end
$$;

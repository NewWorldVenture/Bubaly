-- 0521 — A call in the front desk's history is written by no member.
-- `call_logs` becomes read-only to the household, as the application already
-- treats it. Found 2026-10-25 beside 0520; requested on #771 in comment
-- 6402247950, before any SQL.
--
-- call_logs is the AI Front Desk's history from before the Contact Center
-- (0214): every real call is now filed as a `voice` row in
-- family_inbox_messages, and the front desk says of the old table "No
-- mark-read, no delete, no hand-entered call: `call_logs` is frozen history
-- now" (components/modules/front-desk-module.tsx). Nothing in app/, lib/,
-- components/ or shared/ writes it, and no SQL function does; only the seeds,
-- as the table owner.
--
-- 0092 still says otherwise: "any active member can read/write their family's
-- calls". call_logs_insert (WITH CHECK any active membership) and
-- call_logs_update (USING any active membership, no WITH CHECK) let a child, a
-- caregiver or a guest plant a call that looks like telephony, or rewrite the
-- caller, transcript, voicemail URL or AI summary of one the parents read.
-- Measured on a replay of main with every held file through 0518 applied: each
-- of them added a call and rewrote a doctor's voicemail transcript (OK 1).
--
-- This drops those two policies and revokes INSERT and UPDATE on call_logs
-- from anon and authenticated. The members' read (call_logs_select, and the
-- held 0520's guest guard beside it), the managers' delete (call_logs_delete,
-- can_manage_family) and their DELETE privilege are unchanged; the service
-- role keeps every privilege (it bypasses RLS).
--
-- Released probe it touches: docs/audit/gated-write-tables-check.sql records
-- call_logs as a table whose RLS can filter a member's write; it still is (the
-- delete is a manager's, and no member update is admitted at all).
--
-- HELD: 0521, requested on #771 in comment 6402247950 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/a-call-in-the-front-desk-history-is-written-by-no-member-check.sql
-- and .github/workflows/call-history-writes-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regclass('public.call_logs') is null then
    raise exception '0521 needs public.call_logs';
  end if;
end
$$;

drop policy if exists "call_logs_insert" on public.call_logs;
drop policy if exists "call_logs_update" on public.call_logs;
revoke insert, update on public.call_logs from anon, authenticated;

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_policy p
   where p.polrelid = 'public.call_logs'::regclass
     and p.polpermissive
     and p.polcmd in ('*', 'a', 'w')
     and (p.polroles = array[0::oid]
          or p.polroles && array[(select oid from pg_roles where rolname = 'authenticated'),
                                 (select oid from pg_roles where rolname = 'anon')]);
  if n <> 0 then
    raise exception '0521: call_logs still carries % permissive insert or update policies for a client role', n;
  end if;
  if has_table_privilege('authenticated', 'public.call_logs', 'insert')
     or has_table_privilege('authenticated', 'public.call_logs', 'update')
     or has_table_privilege('anon', 'public.call_logs', 'insert')
     or has_table_privilege('anon', 'public.call_logs', 'update') then
    raise exception '0521: a client role still holds INSERT or UPDATE on call_logs';
  end if;
  if not has_table_privilege('authenticated', 'public.call_logs', 'select')
     or not exists (select 1 from pg_policy p
                     where p.polrelid = 'public.call_logs'::regclass and p.polpermissive and p.polcmd = 'r') then
    raise exception '0521: the members'' read of call_logs is gone; it must stay';
  end if;
  if not has_table_privilege('authenticated', 'public.call_logs', 'delete')
     or not exists (select 1 from pg_policy p
                     where p.polrelid = 'public.call_logs'::regclass and p.polname = 'call_logs_delete' and p.polcmd = 'd'
                       and pg_get_expr(p.polqual, p.polrelid) = 'can_manage_family(family_id)') then
    raise exception '0521: the managers'' delete of call_logs is not what it was; it must stay';
  end if;
end
$$;

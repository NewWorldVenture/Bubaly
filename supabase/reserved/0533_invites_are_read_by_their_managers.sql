-- 0533 — Invites are read by their household's managers and the person invited.
-- Requested on #771 in comment 6561178776, before any SQL: COVER-O1 (N9), the
-- register's owner action, with its per-role read matrix (DB-TBL-194).
--
-- invites_select (0004, recreated by 0118) is is_family_member(family_id) or
-- the invitee's own email, so any member of a household (a child or teen kid
-- login, a caregiver, a guest) read every invite in it over PostgREST: the
-- invitee's email, the role, the bearer token and the expiry. The app shows
-- that list to managers only, and every user-client reader is a manager's:
-- Home's referral count reads only for a manager, PendingInvites only for
-- isManager, /api/email/invite refuses anyone else before it reads, and the
-- invite form's insert-and-return is a manager's. The join, onboarding,
-- member-invite and admin paths read through the service client.
--
-- Exactly the register's owner action: invites_select becomes
-- can_manage_family(family_id) or the invitee's own email. The invitee-email
-- arm keeps the join preview working, managers read as before, and
-- invites_insert, invites_update and invites_delete (0298, 0482) are
-- untouched. No application change.
--
-- HELD: 0533, requested on #771 in comment 6561178776 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by docs/audit/reserved/invites-are-read-by-their-managers-check.sql
-- and .github/workflows/invite-reading-runtime.yml. Not applied to production
-- by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
begin
  if to_regclass('public.invites') is null then
    raise exception '0533 needs public.invites (0002)';
  end if;
  if to_regprocedure('public.can_manage_family(uuid)') is null then
    raise exception '0533 needs public.can_manage_family(uuid)';
  end if;
end
$$;

drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites for select
  using (public.can_manage_family(family_id) or lower(email) = lower(coalesce(auth.jwt()->>'email','')));

do $$
declare
  qual text;
begin
  select pg_get_expr(p.polqual, p.polrelid) into qual
    from pg_policy p
   where p.polrelid = 'public.invites'::regclass and p.polname = 'invites_select'
     and p.polcmd = 'r' and p.polpermissive;
  if qual is distinct from '(can_manage_family(family_id) OR (lower(email) = lower(COALESCE((auth.jwt() ->> ''email''::text), ''''::text))))' then
    raise exception '0533: invites_select is not the managers'' and the invitee''s read (%)', qual;
  end if;
  if (select count(*) from pg_policy p
       where p.polrelid = 'public.invites'::regclass and p.polcmd in ('r', '*') and p.polpermissive) <> 1 then
    raise exception '0533: another permissive read on invites would widen invites_select';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.invites'::regclass) then
    raise exception '0533: invites must have row-level security enabled';
  end if;
end
$$;

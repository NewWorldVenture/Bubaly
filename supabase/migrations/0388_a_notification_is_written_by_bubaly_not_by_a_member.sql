-- Bubaly :: 0388 - a member's session writes a notification only to themselves
--
-- A row in `notifications` is not an in-app note. The notification cron turns
-- every row into a device push and an email from Bubaly's own sender. 0301
-- pinned the recipient to the caller's family, but left the text alone, so any
-- member could, directly against the API, send any other member of their
-- family, or the whole family (user_id NULL), a push and an email with any
-- title and body, looking exactly like Bubaly ("Your account is locked, sign
-- in here: ...").
--
-- The application never needed that. Every notification addressed to someone
-- else is built server-side: `notify()` (lib/services/notifications) now
-- resolves recipients under the caller's own RLS and writes the rows with the
-- service role, and the on-demand generator (/api/notifications/generate) runs
-- as the service role like the cron. The guardian, contact-centre, approval
-- and cron writers were already service role. So a member's own INSERT is
-- narrowed to a row addressed to the member themselves, in a family they
-- belong to. 0301's column grant (UPDATE is_read only) is unchanged.
--
-- Pinned by docs/audit/notification-authorship-check.sql (0301's probe,
-- re-controlled for this rule), and by
-- tests/a-notification-for-someone-else-is-written-by-bubaly.test.ts.

drop policy if exists notif_insert on public.notifications;
create policy notif_insert on public.notifications for insert
  to authenticated
  with check (
    public.is_family_member(family_id)
    and user_id = auth.uid()
  );

revoke insert on public.notifications from anon;

do $$
begin
  if not exists (
    select 1 from pg_policy p
     where p.polrelid = 'public.notifications'::regclass
       and p.polname = 'notif_insert' and p.polcmd = 'a' and p.polpermissive
       and pg_get_expr(p.polwithcheck, p.polrelid) like '%user_id = auth.uid()%'
  ) then
    raise exception '0388: notif_insert does not pin the recipient to the caller';
  end if;
  if exists (
    select 1 from pg_policy p
     where p.polrelid = 'public.notifications'::regclass
       and p.polcmd in ('a', '*') and p.polpermissive and p.polname <> 'notif_insert'
  ) then
    raise exception '0388: another permissive INSERT policy on notifications would reopen member-authored notifications';
  end if;
end $$;

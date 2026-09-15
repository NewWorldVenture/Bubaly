-- Bubaly :: 0301 A notification is delivered mail, so who may address and
--                rewrite one is not the browser's choice
-- ----------------------------------------------------------------------------
-- `notifications` is not an in-app list. The cron reads it with the service
-- role and turns each row into an email from Bubaly's own sender
-- (lib/server/notification-emails.ts) and a device push (lib/server/push.ts).
-- Its write policies were written for a list.
--
-- `notif_insert` checked only `is_family_member(family_id)`. `user_id` was
-- unconstrained — a plain FK to auth.users — and the email cron selects by
-- `user_id` with no family filter at all:
--
--   .is('sent_at', null).not('user_id','is',null).lte('send_at', now)
--
-- so the family_id a row claims never reaches the delivery decision. Measured
-- on a replayed database as a CHILD of one family, with a control proving a
-- non-member is refused the same statement:
--
--   insert into notifications (family_id, user_id, type, title, body)
--   values (<my family>, <a user in ANOTHER family>, 'system', …);
--   -> 1 row, and it matches the cron's selection exactly.
--
-- Nothing legitimate does that. `resolveRecipients` in
-- lib/services/notifications/index.ts builds every `user_id` from
-- `family_members` of the scope's own family with `is_active`, or leaves it
-- NULL for the family-wide row. The policy now says what that function already
-- does, so no legitimate write is lost and the cross-family address is gone.
--
-- `notif_update` had a USING clause and no WITH CHECK, so Postgres reused
-- USING as the new-row test, and its second branch is `user_id is null and
-- is_family_member(family_id)` — the family-wide row. Two consequences, both
-- measured:
--
--   update notifications set title='Rent is CANCELLED this month', body='— Bubaly'
--    where user_id is null;              -> any member rewrites a notice the
--                                           product itself generated
--   update notifications set sent_at=null, pushed_at=null where user_id=<me>;
--                                        -> the delivery stamps are the only
--                                           thing making delivery once-only,
--                                           so clearing them re-arms the row
--                                           and the next cron sends it again
--
-- The browser only ever writes one column here: `is_read`, from
-- components/modules/notifications-module.tsx. `sent_at` and `pushed_at` are
-- stamped by the cron under the service role. So the table grant is narrowed to
-- `is_read` rather than the policy being rewritten — a column the client has no
-- use for is a column it should not hold, and this closes the rewrite and the
-- re-delivery loop together without touching who may mark a notice read.
--
-- NOT closed here, and stated rather than implied: a member can still file a
-- notification with an arbitrary title and body for someone in their OWN
-- family, which the cron will email. That one cannot be decided at the RLS
-- layer, because the legitimate paths look identical to it — the AI notify
-- tool, the trip-disruption report and the geofence alert all insert
-- member-authored text through the caller's own session. Closing it means
-- routing every notify() write through the service client, which touches the
-- AI run executor, and that is a change to make deliberately rather than as a
-- rider here.
--
-- Idempotent; no data change.

drop policy if exists notif_insert on public.notifications;
create policy notif_insert on public.notifications for insert
  with check (
    public.is_family_member(family_id)
    and (
      user_id is null
      or exists (
        select 1 from public.family_members m
         where m.family_id = notifications.family_id
           and m.user_id   = notifications.user_id
           and m.is_active
      )
    )
  );

revoke update on public.notifications from anon, authenticated;
grant update (is_read) on public.notifications to authenticated;

-- The state this leaves behind, not the state at the moment it ran.
do $$
declare n int; begin
  select count(*) into n from information_schema.column_privileges
   where table_schema='public' and table_name='notifications'
     and grantee in ('anon','authenticated') and privilege_type='UPDATE'
     and column_name <> 'is_read';
  if n <> 0 then
    raise exception '0301: % client UPDATE grant(s) beyond is_read remain on notifications', n;
  end if;

  select count(*) into n from information_schema.column_privileges
   where table_schema='public' and table_name='notifications'
     and grantee='authenticated' and privilege_type='UPDATE' and column_name='is_read';
  if n <> 1 then
    raise exception '0301: a member can no longer mark a notification read';
  end if;

  if not exists (
    select 1 from pg_policy p join pg_class c on c.oid=p.polrelid
     where c.relname='notifications' and p.polname='notif_insert'
       and pg_get_expr(p.polwithcheck, p.polrelid) like '%family_members%'
  ) then
    raise exception '0301: notif_insert no longer pins the recipient to the family';
  end if;
end $$;

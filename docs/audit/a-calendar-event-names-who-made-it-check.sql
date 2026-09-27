-- ── A calendar event names who actually made it (0339, AUTHZ-021) ───────────
--
-- `public.calendar_events` carried no attribution boundary.
-- 01050_calendar_events_rls_repair.sql is the whole of its policy set and every
-- verb is the same role-blind, identity-blind sentence,
-- `public.is_family_member(family_id)`. So a CHILD could INSERT an event
-- carrying a PARENT's uid in `created_by`, and could REWRITE or ERASE an
-- existing row's author afterwards.
--
-- It reaches a screen: app/(app)/dashboard/workload/page.tsx:29 selects
-- `created_by`, components/modules/workload-module.tsx:50 maps it to a member,
-- and lib/workload/balance.ts:117 scores each organized event as 12 minutes of
-- "invisible labour" — so forged rows move the household's mental-load share.
--
-- 0339 adds a RESTRICTIVE INSERT guard that ANDs with 01050's permissive
-- policy, plus a preserving BEFORE UPDATE trigger. The predicate is 0272's
-- shape, NOT a bare `= auth.uid()` pin: three earlier migrations pinned that
-- and were rejected, because `scopeForApprovedWork`
-- (lib/services/approvals/index.ts:618) runs approved AI work as the ASKER
-- while the session stays the APPROVER's, so `created_by <> auth.uid()` there
-- BY DESIGN.
--
-- Asserts, in BOTH directions:
--
--   1. a child can STILL create an event in their own name — a boundary that
--      stops the honest caller is the wrong boundary;
--   2. a child can STILL create one with NO created_by, because
--      app/api/calendar/sync/route.ts:132 (ICS import) and
--      lib/server/calendar-feeds.ts:54 (subscribed-feed sync) both write no
--      such key through the caller's OWN cookie-bound client;
--   3. a child CANNOT create an event naming the PARENT — the measured defect;
--   4. a MANAGER CAN still name another member. This is asserted POSITIVELY
--      and on purpose. The rejected 0339's probe asserted the opposite ("a
--      manager may not sign for the child"), which encoded the legitimate
--      approval-replay path as a bug and made a green probe evidence that
--      approved AI work was broken;
--   5. the insert-NULL-then-UPDATE defeat is closed;
--   6. a child cannot REWRITE an existing row's author;
--   7. a child cannot ERASE one either (`created_by := NULL`). The rejected
--      draft preserved only a non-NULL rewrite and left this open while its
--      header claimed the author was fixed at insert;
--   8. `INSERT … ON CONFLICT DO UPDATE` — what supabase-js `.upsert()` emits —
--      cannot write past the guard, which an INSERT WITH CHECK never sees;
--   9. a child can STILL edit a parent-created event's CONTENT, which 01050
--      allows on purpose and which is why UPDATE is a preserving trigger and
--      not a checking policy;
--  10. reads stay `is_family_member`;
--  11. `anon` holds no INSERT;
--  12. deleting an auth user STILL nulls `created_by` and leaves NO dangling
--      reference. `created_by` is `ON DELETE SET NULL` (0002_tables.sql:99) and
--      that referential action is itself an UPDATE, so an UNCONDITIONAL
--      preserve silently reverts it. The trigger therefore guards its preserve
--      on `pg_trigger_depth() = 1`;
--  13. NEGATIVE CONTROL: put the broken state back inside this transaction —
--      drop the guard AND restore the unconditional preserve — and require the
--      forgery to land again AND the account-deletion erasure to break again.
--      A probe that has never been shown to fail is decoration.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-calendar-event-names-who-made-it-check.sql

\set FE '00000000-0000-4000-8000-0000000ca1e0'
\set UP '00000000-0000-4000-8000-0000000ca1e1'
\set UK '00000000-0000-4000-8000-0000000ca1e2'
\set MP '00000000-0000-4000-8000-0000000ca1e3'
\set MK '00000000-0000-4000-8000-0000000ca1e4'
\set EV '00000000-0000-4000-8000-0000000ca1e5'
\set UD '00000000-0000-4000-8000-0000000ca1e9'

begin;

insert into auth.users (id, email) values (:'UP','cal-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','cal-kid@example.com')    on conflict do nothing;
-- A third account, deleted in assertion 12, so the FK test never removes a
-- member the rest of the probe depends on.
insert into auth.users (id, email) values (:'UD','cal-doomed@example.com') on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FE','Calendar House',:'UP') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values (:'MK',:'FE',:'UK','Kid','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FE' and user_id = :'UP';
-- The owner row `handle_new_family` created gets our fixed id, so the probe can
-- name it without guessing.
update public.family_members set id = :'MP' where family_id = :'FE' and user_id = :'UP';

-- A genuine parent-authored event, exactly as the calendar UI writes one
-- (lib/services/calendar/index.ts:113, `created_by: scope.userId`).
insert into public.calendar_events (id, family_id, title, starts_at, created_by)
  values (:'EV', :'FE', 'Parent booked the dentist', now(), :'UP');

do $$
declare
  n         int;
  v         uuid;
  failures  text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-0000000ca1e0';
  parent_u  constant uuid := '00000000-0000-4000-8000-0000000ca1e1';
  kid_u     constant uuid := '00000000-0000-4000-8000-0000000ca1e2';
  genuine   constant uuid := '00000000-0000-4000-8000-0000000ca1e5';
  doomed_u  constant uuid := '00000000-0000-4000-8000-0000000ca1e9';
  nulled    constant uuid := '00000000-0000-4000-8000-0000000ca1e6';
  doomed_ev constant uuid := '00000000-0000-4000-8000-0000000ca1e7';
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  -- 1. The honest caller. Creating events is the feature.
  begin
    insert into public.calendar_events (family_id, title, starts_at, created_by)
      values (fam, 'Football practice', now(), kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures,
      'a child can no longer create an event IN THEIR OWN NAME — creating events is the feature and this broke it');
  end;

  -- 2. NULL stays accepted: ICS import and subscribed-feed sync send no author
  --    through the caller's own cookie-bound client. Refusing NULL breaks
  --    calendar import for every user, and the feed cron would have survived on
  --    service role, making the breakage look intermittent.
  begin
    insert into public.calendar_events (id, family_id, title, starts_at)
      values (nulled, fam, 'Imported from a public ICS feed', now());
  exception when insufficient_privilege then
    failures := array_append(failures,
      'calendar_events refused a NULL created_by — app/api/calendar/sync/route.ts:132 and lib/server/calendar-feeds.ts:54 both write one under RLS, so this refuses legitimate imports');
  end;

  -- 3. THE MEASURED DEFECT.
  begin
    insert into public.calendar_events (family_id, title, starts_at, created_by)
      values (fam, 'Forged into the parent''s name', now(), parent_u);
    failures := array_append(failures,
      'a CHILD created an event attributed to the PARENT — /dashboard/workload credits the parent 12 minutes of invisible labour per forged row');
  exception when insufficient_privilege then null;
  end;

  -- 5. The two-statement defeat of an INSERT-only guard: born NULL (admitted
  --    above), then rewritten under 01050's role-blind UPDATE policy.
  update public.calendar_events set created_by = parent_u where id = nulled;
  select created_by into v from public.calendar_events where id = nulled;
  if v is not null then
    failures := array_append(failures,
      'a child inserted an unattributed event and then UPDATEd its created_by to the parent — an INSERT-only guard on this table guards nothing');
  end if;

  -- 6. Rewriting somebody else's author on an existing row.
  update public.calendar_events set created_by = kid_u where id = genuine;
  select created_by into v from public.calendar_events where id = genuine;
  if v is distinct from parent_u then
    failures := array_append(failures,
      'a child RE-SIGNED an existing parent-created event through a direct UPDATE — the attribution is not immutable');
  end if;

  -- 7. Erasure, not only rewriting. The rejected draft preserved a non-NULL
  --    rewrite only and left exactly this open.
  update public.calendar_events set created_by = null where id = genuine;
  select created_by into v from public.calendar_events where id = genuine;
  if v is distinct from parent_u then
    failures := array_append(failures,
      'a child ERASED an event''s author by setting created_by = NULL — a half-guard that preserves only a non-NULL rewrite');
  end if;

  -- 8. The upsert path. INSERT WITH CHECK is applied only to rows appended by
  --    the INSERT path, so ON CONFLICT DO UPDATE would otherwise walk round it.
  insert into public.calendar_events (id, family_id, title, starts_at, created_by)
    values (genuine, fam, 'upserted', now(), kid_u)
    on conflict (id) do update set title = excluded.title, created_by = excluded.created_by;
  select created_by into v from public.calendar_events where id = genuine;
  if v is distinct from parent_u then
    failures := array_append(failures,
      'INSERT … ON CONFLICT DO UPDATE rewrote created_by — supabase-js .upsert() emits exactly this and the INSERT guard never sees it');
  end if;

  -- 9. The child may still EDIT a parent's event. 01050 allows this and the
  --    product relies on it (app/(app)/dashboard/conflicts/actions.ts:26
  --    reschedules by id + family_id with no role check). This is why UPDATE is
  --    a preserving trigger rather than a checking policy.
  begin
    update public.calendar_events set title = 'Dentist moved to Thursday' where id = genuine;
    get diagnostics n = row_count;
    if n = 0 then
      failures := array_append(failures,
        'a child could not edit a parent-created event — 01050 allows this and rescheduleEventAction depends on it');
    end if;
  exception when insufficient_privilege then
    failures := array_append(failures,
      'a child was REFUSED an edit of a parent-created event — this guard broke a legitimate path');
  end;

  -- 10. Reads are unchanged. Seeing the household's calendar is the point.
  select count(*) into n from public.calendar_events where id = genuine;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ the household calendar');
  end if;

  -- 4. A MANAGER may still name another member, because that is what lets an
  --    approval replay attribute Bubaly's work to the ASKER. Asserted
  --    positively: the rejected probe asserted the reverse and so made its own
  --    green run evidence that approved AI work was broken.
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.calendar_events (family_id, title, starts_at, created_by)
      values (fam, 'Approved AI work, attributed to the asker', now(), kid_u);
  exception when insufficient_privilege then
    failures := array_append(failures,
      'a MANAGER could not name another member — this is the approval-replay path (scopeForApprovedWork runs approved work as the ASKER under the APPROVER''s session) and this guard breaks it');
  end;

  -- 11. The grant layer, which a `to authenticated` policy cannot reach.
  perform set_config('role','postgres', true);
  if has_table_privilege('anon', 'public.calendar_events', 'INSERT') then
    failures := array_append(failures, 'anon still holds INSERT on calendar_events');
  end if;

  -- 12. The FK's own referential action must still fire. `created_by` is
  --     ON DELETE SET NULL, and that action is an UPDATE, so an unconditional
  --     preserve reverts it — silently, because OLD and NEW then compare equal.
  insert into public.calendar_events (id, family_id, title, starts_at, created_by)
    values (doomed_ev, fam, 'Made by an account about to be deleted', now(), doomed_u);
  begin
    delete from auth.users where id = doomed_u;
  exception when foreign_key_violation then
    failures := array_append(failures,
      'deleting an auth user RAISED a foreign-key violation on calendar_events — the attribution trigger is reverting the column''s own ON DELETE SET NULL, so account erasure is blocked');
  end;
  select created_by into v from public.calendar_events where id = doomed_ev;
  if v is not null then
    failures := array_append(failures,
      'a deleted account is STILL stamped on its calendar events — the trigger reverted ON DELETE SET NULL and left a dangling reference, so erasure is not erasure');
  end if;

  -- ── 13. NEGATIVE CONTROL ────────────────────────────────────────────────
  -- Put the defect back, inside this transaction, and require the probe to see
  -- it. Both halves: the policy AND the depth guard.
  drop policy if exists calendar_events_author_guard on public.calendar_events;
  create or replace function public.calendar_attribution_is_immutable()
  returns trigger language plpgsql as $fn$
  begin
    new.created_by := old.created_by;
    return new;
  end $fn$;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  begin
    insert into public.calendar_events (family_id, title, starts_at, created_by)
      values (fam, 'control forgery', now(), parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures,
      'with the guard removed the child STILL could not name the parent — this probe is decoration, not a boundary');
  end;

  perform set_config('role','postgres', true);
  select count(*) into n from public.calendar_events
   where family_id = fam and title = 'control forgery' and created_by = parent_u;
  if n <> 1 then
    failures := array_append(failures,
      'with the guard removed no forged row landed under the parent''s uid — the INSERT half of this probe has never been shown to fail');
  end if;

  -- And the FK half: with the preserve made unconditional again, deleting an
  -- account must FAIL to erase it. The re-stamp has to happen with the trigger
  -- OFF, because the very preserve under test would otherwise freeze it — which
  -- is itself a reminder that after 0339 no application path can correct a
  -- wrong created_by.
  drop trigger if exists calendar_events_attribution_immutable on public.calendar_events;
  insert into auth.users (id, email) values (doomed_u, 'cal-doomed-again@example.com') on conflict do nothing;
  update public.calendar_events set created_by = doomed_u where id = doomed_ev;
  create trigger calendar_events_attribution_immutable
    before update on public.calendar_events
    for each row execute function public.calendar_attribution_is_immutable();

  select created_by into v from public.calendar_events where id = doomed_ev;
  if v is distinct from doomed_u then
    failures := array_append(failures,
      'the negative control could not re-stamp the doomed account, so its FK half proves nothing');
  else
    begin
      delete from auth.users where id = doomed_u;
      select created_by into v from public.calendar_events where id = doomed_ev;
      if v is null then
        failures := array_append(failures,
          'with the preserve made unconditional the ON DELETE SET NULL STILL fired — the pg_trigger_depth guard has never been shown to matter');
      end if;
    exception when foreign_key_violation then
      -- Expected in this control: the unconditional preserve reverts the SET
      -- NULL and the referential check then refuses. Inside a transaction that
      -- is this error; in autocommit the same defect instead COMMITS a dangling
      -- reference with no error at all (both measured). Either way the control
      -- has demonstrated the break the depth guard exists to prevent.
      null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'a calendar event does not say who made it:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-calendar-event-names-who-made-it: OK (a child still creates events in their own name and still imports unattributed ones, cannot name the parent, cannot rewrite or erase an author by UPDATE or by ON CONFLICT DO UPDATE, can still edit and read a parent''s event; a manager can still name another member, which is what lets an approval replay attribute to the asker; anon holds no INSERT; deleting an account still nulls created_by with no dangling reference; negative control landed the forgery and broke the erasure)';
end $$;

rollback;

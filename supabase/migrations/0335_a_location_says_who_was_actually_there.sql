-- Bubaly :: 0335 - member_locations / location_events: the row named a member,
--                  and the member it named was the writer's choice
--
-- ── the defect ──────────────────────────────────────────────────────────────
-- `00420_family_location.sql` gave both locator tables one policy each:
--
--   CREATE POLICY "Members can manage member_locations" ... FOR ALL
--     TO authenticated USING  (public.is_family_member(family_id))
--                      WITH CHECK (public.is_family_member(family_id));
--   CREATE POLICY "Members can manage location_events"  ... FOR ALL  (identical)
--
-- `public.is_family_member` reads the roster and nothing else — it is blind to
-- `member_id`. So the predicate says "this row belongs to a family you are in",
-- and the application says something strictly narrower. The header of
-- `updateMyLocation` (app/(app)/dashboard/locator/actions.ts L29) states it:
-- "Strictly self-only — a member can only post their own location", and both
-- writers hard-pin the column, `member_id: member.id` from `requireUserContext`
-- (lib/supabase/auth.ts L118-121 resolves `active.member` from
-- `family_members.user_id = auth.uid()`; there is no profile impersonation).
--
-- A server action is not a boundary against a JWT holder. Children have real
-- logins and a request to /rest/v1/member_locations never passes through app/.
-- The gap closed here is therefore SELF-ONLY vs ROLE-BLIND — it is NOT the
-- manager-only class, and the guard below is deliberately not a role gate. See
-- "why this shape" below, which measures the manager-only alternative failing.
--
-- ── measured, on the replayed database, all 346 migrations applied ──────────
-- Each experiment inside BEGIN … ROLLBACK, `set local role authenticated` with
-- `request.jwt.claim.sub` set to a CHILD's auth user. Preconditions confirmed
-- first: auth.uid() = the child, is_family_member = t, can_manage_family = f.
--
--   update member_locations set is_sharing=false, latitude=null
--    where member_id = <the PARENT's member id>            -> UPDATE 1
--        (the child takes the parent off the family map)
--   insert into location_events (family_id, member_id, place_name, event_type,
--                                latitude, longitude)
--   values (<my family>, <the PARENT's member id>, 'FORGED Bar', 'arrived',9,9)
--                                                          -> INSERT 0 1
--        (an arrival in the parent's name, at coordinates the child chose)
--   delete from location_events  where family_id = <my family> -> 2 rows
--   delete from member_locations where family_id = <my family> -> 2 rows
--        (the whole household's history and every live position, in two calls;
--         on the 500-row seed family the same DELETE removed all 500)
--
--   CONTROL: the same inserts against ANOTHER family's id are refused —
--   "new row violates row-level security policy". Cross-tenant isolation was
--   never in question and is not what this file changes.
--
-- ── what that is worth, sized honestly ──────────────────────────────────────
-- A falsified and erasable safety display. NOT a privilege escalation and NOT a
-- read escalation: SELECT is already family-wide, correctly so, and this
-- migration leaves it exactly as it is. The child gains no fact they could not
-- already see, and the raw PostgREST write fires NO push — `notify()` is only
-- reached from the server action, so nobody's phone buzzes with a fake arrival.
--
-- The forged rows are nonetheless rendered as genuine:
--   * components/family/find-phone-view.tsx shows the row's place/address
--     (L52), the green "sharing" dot (L60), the battery badge (L71-75) and an
--     "Open in Maps" link on the coordinates (L79);
--   * components/modules/locator-module.tsx computes `liveMembers` from
--     `is_sharing` + coords (L125) and plots them, feeds events into
--     `arrivalAlerts(events, 6)` (L134) and `groupHistoryByDay` (L136);
--   * both tables are in the `supabase_realtime` publication
--     (lib/realtime/published-tables.ts L30), so a forged write lands on every
--     open family screen immediately.
-- The erasure is the more material half: the app keeps no second copy of the
-- arrival/departure timeline, so one DELETE empties it for the household, and
-- Find Phone then reads "No recent location" for everybody.
--
-- ── every writer, enumerated by BARE TABLE NAME ─────────────────────────────
-- Grepped across app/, lib/, components/, hooks/ (absent), mobile/, scripts/
-- and shared/ for the bare names, not only `.from('…')`. Every hit accounted
-- for.
--
--   member_locations
--     WRITE app/(app)/dashboard/locator/actions.ts L58  `updateMyLocation`
--           upsert, onConflict member_id — caller's own createServer() client,
--           member_id = c.active.member.id, NO role gate.
--     WRITE app/(app)/dashboard/locator/actions.ts L130 `setLocationSharing`
--           upsert — caller's own client, member_id = own, NO role gate.
--     READ  actions.ts L54 (own place_id); components/modules/locator-module.tsx
--           L105; components/family/find-phone-view.tsx L28.
--   location_events
--     WRITE app/(app)/dashboard/locator/actions.ts L76 — the arrival/departure
--           insert inside updateMyLocation, caller's own client, member_id =
--           c.active.member.id, NO role gate. No UPDATE and no DELETE anywhere.
--     READ  components/modules/locator-module.tsx L113.
--   NON-CODE references (no write): actions.ts L80 log string and L111
--     `relatedType` label; lib/notifications/actions.ts L95 href map;
--     lib/ai/context/policy.ts L75-76 (AI-context DENYLIST — never fed to the
--     model); lib/realtime/published-tables.ts L30; lib/database.types.ts.
--   SERVICE-ROLE writers: NONE. There is no createServiceClient() call in
--     app/(app)/dashboard/locator/, and no file importing it names either table.
--   DB-SIDE writers: NONE. `select count(*) from pg_proc where prosrc like
--     '%member_locations%' or prosrc like '%location_events%'` returns 0.
--   Superuser-only: supabase/seed_location.sql, seed_location_one_family.sql,
--     SEED_ALL.sql. They run as postgres, and the guards below name
--     `authenticated`, so a policy is not even consulted for them.
--   mobile/ has no location feature at all — zero hits under mobile/src, mobile/app.
--
-- Every legitimate writer writes ONLY the caller's own member_id, on the
-- caller's own RLS-bound client. So a self-pin costs no live path.
--
-- ── why THIS guard shape and not another ────────────────────────────────────
-- NOT manager-only. This is the mistake the census already made once, on
-- `autopilot_suggestions` (0327): a manager-only guard is wrong where the
-- feature genuinely belongs to the member. Measured here rather than assumed —
-- with `member_locations` carrying a restrictive INSERT of
-- `can_manage_family(family_id)`, the child's OWN post returned
--
--   ERROR: new row violates row-level security policy "ml_mgr"
--          for table "member_locations"
--
-- i.e. every child's "Share Now" and sharing toggle would 500, and every child
-- crossing a geofence would lose the timeline entry the feature exists to
-- write. 0215_safety_write_rls_hardening.sql had already reached this
-- conclusion and recorded it in its own header — it hardened `family_places`
-- (the geofences, genuinely a manager's) with can_manage_family and says
-- "self-location (member_locations) … intentionally NOT changed". That
-- judgement stands; what 0215 did not do is pin the column that carries the
-- self.
--
-- NOT a trigger. A trigger would have to re-derive the caller's member row per
-- statement; `public.is_self_member(uuid)` (0272, security definer, stable)
-- already exists for exactly this and is already the pin on `event_rsvps` and
-- `driver_licenses` (0297). Reusing it keeps one definition of "is this member
-- row me".
--
-- NOT by replacing 00420's policies. They belong to 00420 and
-- tests/safety-write-rls-hardening.test.ts reads that generation's shape at
-- source level. A RESTRICTIVE policy ANDs with the union of the permissive
-- ones, so this narrows without restating — and, for the reason 0254/0306/
-- 0322/0329 all give, no future permissive `FOR ALL` written out of habit can
-- grant past it. That habit is exactly how both tables got here.
--
-- Measured with the guards below in place, same harness: the child's own upsert
-- OK; the same upsert again taking the ON CONFLICT DO UPDATE branch (the
-- sharing toggle) OK; the child's own arrival event OK; the forged parent
-- location refused; the parent-off-the-map UPDATE 0 rows; the forged parent
-- event refused; the history wipe 0 rows; the child still reads the whole
-- family's rows; the PARENT's own upsert OK; and the parent forging the CHILD's
-- location refused — this is identity, not role, so it binds a manager too.
-- On the real 500-row seed family, same child JWT, the family-wide
-- `delete from location_events` removed 0 rows with these guards applied and
-- all 500 with `location_events_no_client_delete_guard` dropped — measured in
-- one transaction and rolled back, history and guards re-checked after.
--
-- Two asymmetries, both deliberate:
--   * member_locations DELETE is self-pinned, not forbidden. No client path
--     deletes, but a member can already blank their own row through
--     setLocationSharing(false), and the row returns on their next post, so
--     forbidding self-delete would buy nothing.
--   * location_events UPDATE and DELETE are forbidden outright for clients, in
--     the line of 0224/0328 on the money trail. No application path performs
--     either verb, and self-delete is NOT equivalent to anything a member can
--     legitimately do here: it would leave a child able to erase precisely the
--     arrival record kept about them, which is the erasure half of the defect.
--
-- ── what does NOT change ────────────────────────────────────────────────────
-- READS. No restrictive SELECT policy is created and 00420's SELECT path is
-- untouched: `is_family_member(family_id)` still governs, because the family
-- map, Find Phone, the alerts strip and the day-grouped history all render for
-- whoever is signed in, and a child's device must read them too. Narrowing
-- SELECT would be a product decision and is not this migration's business.
-- Cross-family isolation is unchanged (it already held). 00420's two permissive
-- policies are left byte-for-byte as written. family_places is untouched —
-- 0215 owns it. No table, column, index, trigger or publication is altered.
--
-- Agents must NOT apply this to production (docs/PENDING_PROD_MIGRATIONS.md).
--
-- Idempotent: every policy is dropped by name and recreated; the revokes are
-- no-ops once applied; the whole block no-ops on a tree without the tables.

-- ── a live position is posted only by the member who is at it ───────────────
do $$
begin
  if to_regclass('public.member_locations') is null then
    return;
  end if;

  drop policy if exists member_locations_self_insert_guard on public.member_locations;
  create policy member_locations_self_insert_guard on public.member_locations
    as restrictive for insert to authenticated
    with check (public.is_self_member(member_id));

  drop policy if exists member_locations_self_update_guard on public.member_locations;
  create policy member_locations_self_update_guard on public.member_locations
    as restrictive for update to authenticated
    using (public.is_self_member(member_id))
    with check (public.is_self_member(member_id));

  drop policy if exists member_locations_self_delete_guard on public.member_locations;
  create policy member_locations_self_delete_guard on public.member_locations
    as restrictive for delete to authenticated
    using (public.is_self_member(member_id));
end $$;

-- ── an arrival is logged by the member who arrived, and never rewritten ─────
do $$
begin
  if to_regclass('public.location_events') is null then
    return;
  end if;

  drop policy if exists location_events_self_insert_guard on public.location_events;
  create policy location_events_self_insert_guard on public.location_events
    as restrictive for insert to authenticated
    with check (public.is_self_member(member_id));

  -- Append-only for clients: no application path updates or deletes a location
  -- event, and a self-delete would let a child erase the record kept about them.
  drop policy if exists location_events_no_client_update_guard on public.location_events;
  create policy location_events_no_client_update_guard on public.location_events
    as restrictive for update to authenticated
    using (false) with check (false);

  drop policy if exists location_events_no_client_delete_guard on public.location_events;
  create policy location_events_no_client_delete_guard on public.location_events
    as restrictive for delete to authenticated
    using (false);
end $$;

comment on policy member_locations_self_insert_guard on public.member_locations is
  '0335. 00420 gave this table one FOR ALL policy on is_family_member(family_id), which is blind to member_id, while both writers (updateMyLocation, setLocationSharing) pin member_id to the caller''s own member row and the action header says "strictly self-only". Measured: a child could plant a live position for a sibling or a parent, and Find Phone renders it. Self-pin rather than can_manage_family, because posting your own location IS the child''s feature — a manager-only policy refused the child''s own write. SELECT is untouched: the family map needs it.';

comment on policy location_events_no_client_delete_guard on public.location_events is
  '0335. No application path deletes a location event; measured, a signed-in child could DELETE the household''s entire arrival/departure history in one PostgREST call (500 rows on the seed family), and the app keeps no second copy. Append-only for clients, in the line of 0224/0328 on the money trail. SELECT is untouched.';

-- ── close the anon grant a `to authenticated` guard cannot reach ────────────
-- A restrictive policy is only ANDed for a request made AS a role it names, so
-- for an anonymous request these guards are simply absent and the grant layer
-- is the last line. Supabase's default privileges hand `anon` arwdDxt on every
-- table in `public`, and on a replayed database `anon` does still hold
-- INSERT/UPDATE/DELETE/TRUNCATE on both. Not exploitable as it stands — no
-- permissive policy names `anon`, so RLS refuses for want of one — and this
-- does not claim otherwise; it restores the defence in depth 0290/0322/0333
-- argue for, so one future policy written `TO public` cannot open a path no
-- restrictive guard would catch. SELECT is deliberately left alone.
revoke insert, update, delete, truncate on public.member_locations from anon;
revoke insert, update, delete, truncate on public.location_events  from anon;

do $$
declare
  n int;
begin
  if to_regclass('public.member_locations') is null and to_regclass('public.location_events') is null then
    return;
  end if;

  -- A migration that silently created nothing is worse than one that failed:
  -- the probe would be asserting a boundary that only looks present.
  if to_regclass('public.member_locations') is not null then
    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = 'member_locations'
       and permissive = 'RESTRICTIVE'
       and policyname in ('member_locations_self_insert_guard',
                          'member_locations_self_update_guard',
                          'member_locations_self_delete_guard');
    if n <> 3 then
      raise exception '0335: member_locations is missing restrictive self guards (found % of 3)', n;
    end if;

    if has_table_privilege('anon', 'public.member_locations', 'INSERT') then
      raise exception '0335: anon still holds INSERT on member_locations';
    end if;

    -- Reads are the thing this file must NOT have changed.
    if exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = 'member_locations'
         and permissive = 'RESTRICTIVE' and cmd in ('SELECT', 'ALL')
    ) then
      raise exception '0335: a restrictive policy is filtering SELECT on member_locations — the family map reads for every member';
    end if;

    -- 00420 owns the permissive policy these AND with. If it has gone, the
    -- family-scoping these guards rely on has gone with it.
    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = 'member_locations'
       and permissive = 'PERMISSIVE' and policyname = 'Members can manage member_locations';
    if n <> 1 then
      raise exception '0335: 00420''s permissive member_locations policy is missing (found %)', n;
    end if;
  end if;

  if to_regclass('public.location_events') is not null then
    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = 'location_events'
       and permissive = 'RESTRICTIVE'
       and policyname in ('location_events_self_insert_guard',
                          'location_events_no_client_update_guard',
                          'location_events_no_client_delete_guard');
    if n <> 3 then
      raise exception '0335: location_events is missing restrictive guards (found % of 3)', n;
    end if;

    if has_table_privilege('anon', 'public.location_events', 'INSERT') then
      raise exception '0335: anon still holds INSERT on location_events';
    end if;

    if exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = 'location_events'
         and permissive = 'RESTRICTIVE' and cmd in ('SELECT', 'ALL')
    ) then
      raise exception '0335: a restrictive policy is filtering SELECT on location_events — the history list reads for every member';
    end if;

    select count(*) into n from pg_policies
     where schemaname = 'public' and tablename = 'location_events'
       and permissive = 'PERMISSIVE' and policyname = 'Members can manage location_events';
    if n <> 1 then
      raise exception '0335: 00420''s permissive location_events policy is missing (found %)', n;
    end if;
  end if;

  -- The pin itself. If 0272's helper is gone the guards above are syntactically
  -- fine and semantically empty.
  if to_regprocedure('public.is_self_member(uuid)') is null then
    raise exception '0335: public.is_self_member(uuid) is missing — the self-pin has nothing to evaluate';
  end if;
end $$;

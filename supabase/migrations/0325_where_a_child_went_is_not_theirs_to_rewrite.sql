-- 0325 — The record of where a member went belongs to the family, not to its subject.
--
-- 0215 hardened the safety tables and stated the threat in its own header:
--
--   "a future missed gate or a direct PostgREST call by a signed-in child could
--    still tamper with the call/message screening rules or the geofences that
--    drive location safety alerts."
--
-- It fixed `family_places` — the geofences, which are the INPUT to that system.
-- It said `member_locations` was "intentionally NOT changed" because a member
-- must be able to write their own position. And it does not mention
-- `location_events` at all: the OUTPUT of the geofence system, the
-- arrival/departure timeline a parent reads, kept the policy 00420 shipped:
--
--   CREATE POLICY "Members can manage location_events" ON public.location_events
--     FOR ALL TO authenticated USING (public.is_family_member(family_id))
--                              WITH CHECK (public.is_family_member(family_id));
--
-- Two things follow, both measured as a signed-in child against a replayed
-- schema (docs/audit/location-trail-boundary-check.sql):
--
--   * a child DELETEs their own arrival/departure rows — the 02:00 "left home"
--     that the alert was for is gone, and the parent's history rail with it;
--   * "self-location" was never self-scoped. `is_family_member` is family-wide,
--     so the same policy let that child move a SIBLING's live pin and switch a
--     SIBLING's location sharing off. The parent's map of a different child,
--     falsified by the one standing next to them.
--
-- 00420's own header claims "location sharing is strictly opt-in
-- (member_locations.is_sharing)". A flag anyone in the family may flip is not
-- opt-in, and this migration is what makes that sentence true.
--
-- The shape of the fix is already in this repository. 0272 hit the identical
-- problem on `event_rsvps` — one FOR ALL policy where a per-member one was
-- meant — and added `public.is_self_member(member_id)` for it. This reuses that
-- function rather than inventing a second convention.
--
-- DELIBERATELY NOT GRANTED: an UPDATE or DELETE path on `location_events`.
-- Nothing in the application deletes or edits one, and this document has
-- already recorded what happens when a policy is written for a capability that
-- is never wired (`call_logs`, whose manager-delete policy 0092 wrote has no
-- caller anywhere). A trail is append-only until someone decides otherwise on
-- purpose. Family deletion is unaffected: both tables cascade from `families`,
-- and a foreign-key cascade is not subject to RLS.
--
-- Additive and idempotent. Audit C1-S8-02.

-- ── location_events — you may add to your own trail; nobody edits one ───────
alter table public.location_events enable row level security;

-- Permissive policies are OR'd, so the FOR ALL policy must go first or every
-- narrower rule below is decoration. (C1-S6-09's lesson, applied up front.)
drop policy if exists "Members can manage location_events" on public.location_events;
drop policy if exists location_events_select on public.location_events;
drop policy if exists location_events_insert on public.location_events;
drop policy if exists location_events_update on public.location_events;
drop policy if exists location_events_delete on public.location_events;

-- Every family member reads the family's timeline — that is the product.
create policy location_events_select on public.location_events
  for select to authenticated
  using (public.is_family_member(family_id));

-- updateMyLocation() inserts on the MEMBER'S OWN session, so self-insert must
-- stay open. A manager may also file one (a parent logging a child's arrival
-- from their own device is the same act the geofence performs automatically).
-- The content of an event is self-asserted either way — you control the GPS you
-- post — so the boundary that means anything is WHOSE row you may write.
create policy location_events_insert on public.location_events
  for insert to authenticated
  with check (
    public.is_family_member(family_id)
    and (public.is_self_member(member_id) or public.can_manage_family(family_id))
    -- A member id from another family would otherwise satisfy is_self_member
    -- while carrying this family's family_id.
    and exists (
      select 1 from public.family_members m
       where m.id = location_events.member_id and m.family_id = location_events.family_id
    )
  );

-- ── member_locations — your pin is yours ────────────────────────────────────
alter table public.member_locations enable row level security;

drop policy if exists "Members can manage member_locations" on public.member_locations;
drop policy if exists member_locations_select on public.member_locations;
drop policy if exists member_locations_insert on public.member_locations;
drop policy if exists member_locations_update on public.member_locations;
drop policy if exists member_locations_delete on public.member_locations;

create policy member_locations_select on public.member_locations
  for select to authenticated
  using (public.is_family_member(family_id));

create policy member_locations_insert on public.member_locations
  for insert to authenticated
  with check (
    public.is_family_member(family_id)
    and public.is_self_member(member_id)
    and exists (
      select 1 from public.family_members m
       where m.id = member_locations.member_id and m.family_id = member_locations.family_id
    )
  );

-- `using` AND `with check`, both. C1-S6-08 was exactly this: an ownership test
-- written in `using` alone governs the row you STARTED from and says nothing
-- about the row you produce. Here the two are not the same question — the
-- predicate reads `member_id`, which is the column an attacker would change —
-- so `with check` is what refuses re-pointing your own row at a sibling.
create policy member_locations_update on public.member_locations
  for update to authenticated
  using (public.is_self_member(member_id))
  with check (
    public.is_self_member(member_id)
    and public.is_family_member(family_id)
  );

-- No DELETE policy: nothing deletes one, and turning sharing off is an UPDATE
-- that nulls the coordinates (setLocationSharing), not a delete.

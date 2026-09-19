-- Bubaly :: 0319 - a location row belongs to the member it names
--
-- app/(app)/dashboard/locator/actions.ts says so itself, in the comment above
-- `updateMyLocation`:
--
--   * Strictly self-only — a member can only post their own location.
--
-- and the action is true to it: `member.id` comes from `requireUserContext()`,
-- never from the caller's input. The claim is exactly right, and it is enforced
-- in exactly one place.
--
-- `member_locations` and `location_events` each carried a single policy:
--
--   Members can manage member_locations  ALL  using/with check: is_family_member(family_id)
--   Members can manage location_events   ALL  using/with check: is_family_member(family_id)
--
-- `FOR ALL`, family-scoped, with NO member_id condition on either side — and
-- `authenticated` holds INSERT, UPDATE and DELETE on both tables. So "self-only"
-- describes the server action, not the table. Anything holding a family member's
-- JWT writes any member's row directly, and the browser already holds one:
-- both tables are listed in lib/realtime/published-tables.ts, and
-- components/modules/locator-module.tsx subscribes to them straight from the
-- client.
--
-- This is the premise gap, not the scope gap: the guard is real, it works, and
-- it sits beside a road that goes around it.
--
-- ── measured, acting as a child of the family, with the control passing ─────
--
--   BREACH: a child rewrote the PARENT's live location (rows: 1)
--   BREACH: a child DELETED the parent's live location row (rows: 1)
--   BREACH: a child fabricated a location EVENT attributed to the parent (rows: 1)
--   NOTE:   a child posted their own location directly, bypassing updateMyLocation
--
-- The fourth is the one that empties the feature of meaning: a child who can
-- write their own row at will can sit anywhere and report being at school, and
-- `updateMyLocation`'s geofence, its arrived/left classification and the alert
-- it raises to the rest of the family are all computed from a number the child
-- chose. The first three are worse in kind: the map can be made to lie about
-- where a PARENT is, a parent can be removed from it entirely, and
-- `location_events` — which lib/notifications/actions.ts links as the family's
-- safety timeline, and which lib/ai/context/policy.ts feeds to a model as
-- "location history" — can be given entries that never happened, attributed to
-- someone else.
--
-- ── what this does NOT change ──────────────────────────────────────────────
--
-- SELECT stays open to every family member on both tables. A shared family map
-- is the product, not a defect, and narrowing reads here would close the
-- feature rather than the hole. What changes is who may WRITE a given member's
-- row.
--
-- The rule is `can_manage_family OR is_self_member`, not managers-only: a
-- device posting its own position is the ordinary path, and `updateMyLocation`
-- runs under the member's own JWT, so a manager-only guard would break location
-- reporting for every non-manager in the family — closing the product instead
-- of the hole. That shape is already the house pattern for member-owned rows:
-- `driver_licenses` and `event_rsvps` carry
-- `is_family_member(family_id) AND (can_manage_family(family_id) OR is_self_member(member_id))`
-- on all four verbs.
--
-- UPDATE carries the rule on BOTH `using` and `with check`. `using` alone would
-- stop a child editing the parent's row but still let them move their OWN row
-- to `member_id = <parent>`, which reaches the same place by re-attribution
-- rather than by edit.
--
-- Restrictive guards, 0254's mechanism: they AND with the union of the
-- permissive policies, so no permissive policy — present or added later,
-- whatever it is called — can grant past them.

do $$
begin
  if to_regclass('public.member_locations') is not null then
    drop policy if exists member_locations_owner_insert_guard on public.member_locations;
    create policy member_locations_owner_insert_guard on public.member_locations
      as restrictive for insert to authenticated
      with check (public.can_manage_family(family_id) or public.is_self_member(member_id));

    drop policy if exists member_locations_owner_update_guard on public.member_locations;
    create policy member_locations_owner_update_guard on public.member_locations
      as restrictive for update to authenticated
      using (public.can_manage_family(family_id) or public.is_self_member(member_id))
      with check (public.can_manage_family(family_id) or public.is_self_member(member_id));

    drop policy if exists member_locations_owner_delete_guard on public.member_locations;
    create policy member_locations_owner_delete_guard on public.member_locations
      as restrictive for delete to authenticated
      using (public.can_manage_family(family_id) or public.is_self_member(member_id));
  end if;

  if to_regclass('public.location_events') is not null then
    drop policy if exists location_events_owner_insert_guard on public.location_events;
    create policy location_events_owner_insert_guard on public.location_events
      as restrictive for insert to authenticated
      with check (public.can_manage_family(family_id) or public.is_self_member(member_id));

    drop policy if exists location_events_owner_update_guard on public.location_events;
    create policy location_events_owner_update_guard on public.location_events
      as restrictive for update to authenticated
      using (public.can_manage_family(family_id) or public.is_self_member(member_id))
      with check (public.can_manage_family(family_id) or public.is_self_member(member_id));

    drop policy if exists location_events_owner_delete_guard on public.location_events;
    create policy location_events_owner_delete_guard on public.location_events
      as restrictive for delete to authenticated
      using (public.can_manage_family(family_id) or public.is_self_member(member_id));
  end if;
end
$$;

comment on table public.member_locations is
  'Live position per family member. Readable by the whole family (the shared map is the feature); writable only by that member or a manager — restrictive guards, 0319. updateMyLocation enforced this in the server action alone, and both tables are client-subscribed, so the action could be walked around.';
comment on table public.location_events is
  'Arrived/left timeline per family member. Readable by the whole family; writable only by that member or a manager — restrictive guards, 0319. Feeds family notifications and the AI assistant''s location history, so a fabricated row is repeated as fact.';

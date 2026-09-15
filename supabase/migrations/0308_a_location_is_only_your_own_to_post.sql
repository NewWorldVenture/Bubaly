-- Bubaly :: 0308 - a location is only your own to post
-- ----------------------------------------------------------------------------
-- `app/(app)/dashboard/locator/actions.ts:30` states the rule in as many words:
--
--   "Strictly self-only — a member can only post their own location."
--
-- And the action keeps it: `updateMyLocation` and `setLocationSharing` both
-- write `member_id: member.id`, taken from `requireUserContext()`. The claim is
-- true of the server action and false of the database. `member_locations`,
-- `location_events` and `safety_check_ins` were all reachable by any member of
-- the family — `for all using (is_family_member(family_id))` on the first two,
-- and the same predicate on every write verb of the third.
--
-- The locator module talks to PostgREST directly (`components/modules/
-- locator-module.tsx`, `components/family/{check-in,find-phone}-view.tsx` all
-- use `createClient()`), and a child is a real Supabase auth user, so the
-- server action was never the boundary. What the anon key bought:
--
--   upsert member_locations (member_id = <a parent>, lat, lng)
--       -> move somebody else's dot on the family map
--   upsert member_locations (member_id = <a parent>, is_sharing = false)
--       -> take somebody else off the map entirely
--   insert location_events (member_id = <a sibling>, 'arrived', 'School')
--       -> fabricate an arrival, which notifies the whole family as urgent
--   delete from location_events where member_id = <self>
--       -> erase the record of having left
--   delete from safety_check_ins where id = <a sibling's>
--       -> delete somebody's "I am safe"
--
-- The last two are the ones that matter most, and they are why this is not
-- simply "make it self-only". A trail you can delete is not a trail, and the
-- check-in view's `remove(id)` deletes by id with no author check at all.
--
-- THREE SHAPES:
--
--   member_locations  — where you are NOW, one row per member. Only you post
--       it; a manager may delete a stale row (a member who has left the
--       family), which is the only write the product needs from anyone else.
--
--   location_events   — the arrival/departure TRAIL. Append-only, in the idiom
--       of wallet_audit_logs (0088): only you append your own, nobody updates,
--       and only a manager deletes. A child erasing their own "left School"
--       event is precisely the thing a geofence exists to prevent.
--
--   safety_check_ins  — "I am safe". `member_id` is NULLABLE here (the view
--       writes `selfMember?.id ?? null`), so self is established by
--       `created_by = auth.uid()` as well as by member_id; requiring member_id
--       would break a check-in from anyone without a member row. Correcting or
--       withdrawing one is the author's or a manager's.
--
-- READS stay family-wide on all three: seeing where the family is IS the
-- feature, and every one of these surfaces renders the whole family's rows.

do $$
declare
  tbl       text;
  pol       record;
  swept     int := 0;
  remaining int;
  keep      text[];
begin
  -- ── member_locations ─────────────────────────────────────────────────────
  tbl := 'member_locations';
  if to_regclass('public.' || tbl) is not null then
    alter table public.member_locations enable row level security;
    keep := array['member_locations_read','member_locations_self_insert',
                  'member_locations_self_update','member_locations_delete'];

    drop policy if exists member_locations_read on public.member_locations;
    create policy member_locations_read on public.member_locations
      for select to authenticated using (public.is_family_member(family_id));
    drop policy if exists member_locations_self_insert on public.member_locations;
    create policy member_locations_self_insert on public.member_locations
      for insert to authenticated
      with check (public.is_family_member(family_id) and public.is_self_member(member_id));
    drop policy if exists member_locations_self_update on public.member_locations;
    create policy member_locations_self_update on public.member_locations
      for update to authenticated
      using (public.is_self_member(member_id))
      with check (public.is_family_member(family_id) and public.is_self_member(member_id));
    drop policy if exists member_locations_delete on public.member_locations;
    create policy member_locations_delete on public.member_locations
      for delete to authenticated
      using (public.can_manage_family(family_id) or public.is_self_member(member_id));

    for pol in
      select p.polname from pg_policy p join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and c.relname=tbl
        and p.polpermissive and p.polcmd in ('a','w','d','*') and not (p.polname = any(keep))
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, tbl);
      swept := swept + 1;
      raise notice '0308: dropped stray permissive write policy %.%', tbl, pol.polname;
    end loop;
  end if;

  -- ── location_events: append-only ─────────────────────────────────────────
  tbl := 'location_events';
  if to_regclass('public.' || tbl) is not null then
    alter table public.location_events enable row level security;
    keep := array['location_events_read','location_events_self_append','location_events_manager_delete'];

    drop policy if exists location_events_read on public.location_events;
    create policy location_events_read on public.location_events
      for select to authenticated using (public.is_family_member(family_id));
    drop policy if exists location_events_self_append on public.location_events;
    create policy location_events_self_append on public.location_events
      for insert to authenticated
      with check (public.is_family_member(family_id) and public.is_self_member(member_id));
    -- No UPDATE policy at all: an event is a fact about a moment, and nothing
    -- in the app has ever updated one.
    drop policy if exists location_events_manager_delete on public.location_events;
    create policy location_events_manager_delete on public.location_events
      for delete to authenticated using (public.can_manage_family(family_id));

    for pol in
      select p.polname from pg_policy p join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and c.relname=tbl
        and p.polpermissive and p.polcmd in ('a','w','d','*') and not (p.polname = any(keep))
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, tbl);
      swept := swept + 1;
      raise notice '0308: dropped stray permissive write policy %.%', tbl, pol.polname;
    end loop;
  end if;

  -- ── safety_check_ins ─────────────────────────────────────────────────────
  tbl := 'safety_check_ins';
  if to_regclass('public.' || tbl) is not null then
    alter table public.safety_check_ins enable row level security;
    keep := array['safety_check_ins_read','safety_check_ins_self_insert',
                  'safety_check_ins_owner_update','safety_check_ins_owner_delete'];

    drop policy if exists safety_check_ins_read on public.safety_check_ins;
    create policy safety_check_ins_read on public.safety_check_ins
      for select to authenticated using (public.is_family_member(family_id));
    drop policy if exists safety_check_ins_self_insert on public.safety_check_ins;
    create policy safety_check_ins_self_insert on public.safety_check_ins
      for insert to authenticated
      with check (
        public.is_family_member(family_id)
        and (public.is_self_member(member_id) or member_id is null)
        and (created_by is null or created_by = auth.uid())
      );
    drop policy if exists safety_check_ins_owner_update on public.safety_check_ins;
    create policy safety_check_ins_owner_update on public.safety_check_ins
      for update to authenticated
      using (public.can_manage_family(family_id) or created_by = auth.uid() or public.is_self_member(member_id))
      with check (public.can_manage_family(family_id) or created_by = auth.uid() or public.is_self_member(member_id));
    drop policy if exists safety_check_ins_owner_delete on public.safety_check_ins;
    create policy safety_check_ins_owner_delete on public.safety_check_ins
      for delete to authenticated
      using (public.can_manage_family(family_id) or created_by = auth.uid() or public.is_self_member(member_id));

    for pol in
      select p.polname from pg_policy p join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname='public' and c.relname=tbl
        and p.polpermissive and p.polcmd in ('a','w','d','*') and not (p.polname = any(keep))
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, tbl);
      swept := swept + 1;
      raise notice '0308: dropped stray permissive write policy %.%', tbl, pol.polname;
    end loop;
  end if;

  select count(*) into remaining
  from pg_policy p join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname='public' and c.relname in ('member_locations','location_events','safety_check_ins')
    and p.polpermissive and p.polcmd in ('a','w','d','*')
    and p.polname not in (
      'member_locations_self_insert','member_locations_self_update','member_locations_delete',
      'location_events_self_append','location_events_manager_delete',
      'safety_check_ins_self_insert','safety_check_ins_owner_update','safety_check_ins_owner_delete');
  if remaining <> 0 then
    raise exception '0308 FAILED: % permissive write policy(ies) still on the locator tables after the sweep', remaining;
  end if;

  raise notice '0308 OK: % stray write policy(ies) swept; a location is only your own to post', swept;
end $$;

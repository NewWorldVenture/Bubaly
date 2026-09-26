-- Bubaly :: 0367 - a location is only your own to post
-- ----------------------------------------------------------------------------
-- Renumbered from 0308. main landed seven migrations at once — 0304 economy
-- invest decision guard, 0305 chore award amounts, 0306 money instructions,
-- 0307 chore prices, 0308 reward catalogue, 0309 prescriptions, 0310 UI-only
-- manager gates — colliding with this branch's whole 0304-0310 block. The NINTH
-- collision event between the two sessions and by far the largest; every merge
-- since 0300 has brought one. Only the numbers changed: this branch's seven
-- moved together to 0363-0369, keeping their order relative to each other.
--
-- Main's seven are RESTRICTIVE guards (`as restrictive`, 0254's mechanism), so
-- they AND with everything here and nothing in this block can loosen them by
-- running later. The two sets are defence in depth over the same tables rather
-- than one overwriting the other, and the probes are run against the combined
-- chain to say so rather than to assume it.
-- ----------------------------------------------------------------------------
-- RECONCILED WITH MAIN'S 0335, and narrowed to the one table it does not reach.
--
-- This migration was written for three tables. Main then landed
-- 0335_a_location_says_who_was_actually_there.sql, which closes the first two
-- — member_locations self-only, location_events append-only — as RESTRICTIVE
-- guards over 00420's permissive policy, and asserts that permissive policy is
-- still there. Run after it, this file's sweep DROPPED that policy (it is a
-- permissive write policy not on this file's keep-list), so 0335's own probe
-- found its negative control could no longer fail: two layers enforcing one
-- rule, one of which had quietly replaced the other's foundation.
--
-- The two also disagreed on one point, and main's answer is the one kept: this
-- file let a MANAGER clear a trail and remove a stale dot; 0335 lets no client
-- delete a location event and lets a member delete only their own dot. No
-- application path deletes either (checked: nothing under app/, components/ or
-- lib/ calls .delete() on them), so the stricter rule costs no feature, and
-- 0335 is already on production.
--
-- So the member_locations and location_events halves are removed from this
-- file, and it now does only what 0335 does not: safety_check_ins, where "I am
-- safe" is withdrawn by its author or its subject and nobody else.
-- docs/audit/locator-write-boundary-check.sql asserts the combined result.
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
      raise notice '0367: dropped stray permissive write policy %.%', tbl, pol.polname;
    end loop;
  end if;

  select count(*) into remaining
  from pg_policy p join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname='public' and c.relname = 'safety_check_ins'
    and p.polpermissive and p.polcmd in ('a','w','d','*')
    and p.polname not in (
      'safety_check_ins_self_insert','safety_check_ins_owner_update','safety_check_ins_owner_delete');
  if remaining <> 0 then
    raise exception '0367 FAILED: % permissive write policy(ies) still on safety_check_ins after the sweep', remaining;
  end if;

  raise notice '0367 OK: % stray write policy(ies) swept; a check-in is only its author''s or its subject''s to change', swept;
end $$;

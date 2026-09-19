-- Bubaly :: 0310 - four modules that say "manager" and a database that does not
--
-- 0308 and 0309 each closed one instance of this shape: a client component
-- declares `canEdit = isManager(role)` and then writes its table STRAIGHT FROM
-- THE BROWSER with the viewer's own JWT, so the only thing enforcing the rule is
-- whether a button renders. This closes the rest of the set, found by sweeping
-- every 'use client' component that writes a table and cross-checking the
-- table's policies against the gate the component claims:
--
--   rides-module.tsx     -> rides         (add/edit/delete/mark-completed, all
--                                          inside `canEdit` at line 247)
--   renewals-module.tsx  -> renewals      (add/edit/delete/mark-renewed, 210)
--   signups-module.tsx   -> opportunities (add/edit/delete/mark-registered, 235)
--   trips-module.tsx     -> trips         (add/edit/delete, 223)
--                        -> trip_items    (add 255, remove 277)
--
-- None of these carried a manager-checked or restrictive write policy. Measured
-- on a replayed database with every migration applied, acting as a child of the
-- family, with both controls passing: the child RESCHEDULED AND CANCELLED a
-- ride, DELETED a renewal reminder, REGISTERED the family for a signup, CHANGED
-- the family trip's destination and dates, and REWROTE, ADDED and DELETED trip
-- items. See docs/audit/ui-only-manager-gate-check.sql.
--
-- These reach no money, payout, prescription or credential — which is why they
-- are one migration behind 0307-0309 rather than folded in with them. What they
-- reach is a family coordinating: a cancelled ride nobody drives to, a renewal
-- reminder that never fires again.
--
-- ── trip_items is not a straight manager table ──────────────────────────────
--
-- Its done-tick, `toggleItem` at line 267, sits OUTSIDE `canEdit`: any member
-- may check a packing item off, and a blanket guard would have closed that. So
-- INSERT and DELETE are manager-only and UPDATE is guarded by COLUMN — is_done
-- is anyone's, the item's content is a manager's. The probe asserts the tick as
-- a positive control for exactly this reason.
--
-- Restrictive policies, 0254's mechanism: they AND with the union of the
-- permissive policies, so none can grant past them. Nothing legitimate breaks —
-- the modules already refuse a non-manager everything guarded here, so this only
-- makes the database agree with the rule the application already states, which
-- is what matters for anyone calling PostgREST directly.

-- ── the four straight manager tables ────────────────────────────────────────
do $$
declare
  t text;
begin
  foreach t in array array['rides', 'renewals', 'opportunities', 'trips'] loop
    if to_regclass('public.' || t) is null then
      continue;
    end if;
    execute format('drop policy if exists %I on public.%I', t || '_manager_insert_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for insert to authenticated '
      || 'with check (public.can_manage_family(family_id))', t || '_manager_insert_guard', t);

    execute format('drop policy if exists %I on public.%I', t || '_manager_update_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for update to authenticated '
      || 'using (public.can_manage_family(family_id)) '
      || 'with check (public.can_manage_family(family_id))', t || '_manager_update_guard', t);

    execute format('drop policy if exists %I on public.%I', t || '_manager_delete_guard', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete to authenticated '
      || 'using (public.can_manage_family(family_id))', t || '_manager_delete_guard', t);
  end loop;
end
$$;

-- ── trip_items: the tick stays open, the content does not ───────────────────
do $$
begin
  if to_regclass('public.trip_items') is null then
    return;
  end if;

  drop policy if exists trip_items_manager_insert_guard on public.trip_items;
  create policy trip_items_manager_insert_guard on public.trip_items
    as restrictive for insert to authenticated
    with check (public.can_manage_family(family_id));

  drop policy if exists trip_items_manager_delete_guard on public.trip_items;
  create policy trip_items_manager_delete_guard on public.trip_items
    as restrictive for delete to authenticated
    using (public.can_manage_family(family_id));

  create or replace function public.trip_item_content_guard()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
  as $guard$
  begin
    -- Anything other than the done-tick (and the stamp that rides along with
    -- it) is the item's content.
    if new.family_id is not distinct from old.family_id
       and new.trip_id is not distinct from old.trip_id
       and new.kind is not distinct from old.kind
       and new.label is not distinct from old.label
       and new.details is not distinct from old.details
       and new.assignee_id is not distinct from old.assignee_id
       and new.due_at is not distinct from old.due_at
       and new.sort_order is not distinct from old.sort_order
       and new.created_by is not distinct from old.created_by then
      return new;
    end if;

    if current_user = 'service_role'
       or coalesce(auth.role(), '') = 'service_role'
       or auth.uid() is null
       or public.can_manage_family(new.family_id) then
      return new;
    end if;

    raise exception
      'a trip item''s details may only be changed by a family manager'
      using errcode = '42501';
  end;
  $guard$;

  comment on function public.trip_item_content_guard() is
    'A member may tick a trip item done (toggleItem sits outside canEdit in trips-module.tsx) but not rewrite what the item is. INSERT and DELETE are manager-only by restrictive policy; this guards the columns UPDATE can reach.';

  drop trigger if exists trg_trip_item_content_guard on public.trip_items;
  create trigger trg_trip_item_content_guard
    before update on public.trip_items
    for each row execute function public.trip_item_content_guard();
end
$$;

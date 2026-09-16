-- Bubaly :: 0312 - a prescription is a parent's to write
-- ----------------------------------------------------------------------------
-- Renumbered from 0300. A parallel session landed
-- `0300_entitlement_is_not_client_writable.sql` on main for a different
-- finding while this was in flight — the FIFTH migration-number collision
-- between the two sessions, after 0297, 0298 (twice) and 0299. The number is
-- all that changed; nothing here depends on running before the migrations
-- around it, which touch different tables. (The numbers this sentence used to
-- name have since moved: main landed 0304-0310 of its own and this branch's
-- seven were renumbered to 0320-0326.)
-- ----------------------------------------------------------------------------
-- `medications` and `medication_schedules` resolve to membership-only policies:
-- SELECT/UPDATE/DELETE `using (is_family_member(family_id))`, INSERT
-- `with check (is_family_member(family_id))`. Both are written DIRECTLY FROM THE
-- BROWSER (components/modules/medications-module.tsx uses the anon client), and
-- the module's own idea of who may write is a React boolean:
--
--     const canEdit = isManager(role);            // medications-module.tsx:77
--
-- which gates the Add / Edit / Delete controls and nothing else. A child is a
-- real Supabase auth user here — app/(app)/family/child-login-actions.ts creates
-- one with admin.auth.admin.createUser — so a child session can call PostgREST
-- directly and RLS is the only boundary. Proven on a full migration replay as a
-- child: `update medications set dosage='500mg'` -> UPDATE 1, and
-- `delete from medications` -> DELETE 1.
--
-- Deleting a schedule also silences the medication reminder
-- (lib/server/notifications.ts), so this is not only a record being altered.
--
-- This migration moves the database to where the module already stands. It is
-- the same shape as 0266 (document vault), 0296 (credential vault), 0297
-- (invites) and 0298 (allowance rules): the claim was made where a user could
-- see it and not in the layer that enforces it.
--
-- DELIBERATELY NOT INCLUDED — recorded so the omissions read as decisions:
--
--   medication_doses  Marking a dose taken or skipped is NOT gated by canEdit
--                     in the module (logDose, line 147, is called from buttons
--                     rendered for everyone), and that is the point of adherence
--                     tracking: the person taking the medicine records it.
--                     Manager-only here would break the feature.
--   immunizations,    Their modules carry NO role gate at all — every member is
--   health_visits     offered the Add button. Tightening the database alone
--                     would leave a UI whose primary control fails. That is a
--                     product decision, not a drift repair, and it is filed
--                     rather than taken.
--
-- READS ARE UNCHANGED. A child can still read a parent's prescription, which is
-- a real privacy gap (lib/ai/context/policy.ts already classes these tables as
-- SENSITIVE and 0264 makes the AI refuse medical detail to a child). Narrowing
-- SELECT is expressible — `medications.member_id` exists — but it would hide
-- family-wide rows (member_id is null) from children and change what the module
-- shows. Filed for an owner decision rather than guessed at here.

do $$
declare
  t         text;
  pol       record;
  swept     int := 0;
  remaining int;
  clinical  text[] := array['medications', 'medication_schedules'];
begin
  foreach t in array clinical loop
    if to_regclass('public.' || t) is null then continue; end if;

    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (public.is_family_member(family_id))', t);
    execute format('drop policy if exists %1$s_mng_insert on public.%1$I', t);
    execute format('create policy %1$s_mng_insert on public.%1$I for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_mng_update on public.%1$I', t);
    execute format('create policy %1$s_mng_update on public.%1$I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_mng_delete on public.%1$I', t);
    execute format('create policy %1$s_mng_delete on public.%1$I for delete to authenticated using (public.can_manage_family(family_id))', t);

    -- RESTRICTIVE guards are ANDed with every permissive policy, so a stray one
    -- re-added later cannot reopen the boundary by itself. This is what 0254
    -- gave the wallet ledger and what 0217's by-name narrowing lacked.
    execute format('drop policy if exists %1$s_manager_insert_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_insert_guard on public.%1$I as restrictive for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_update_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_update_guard on public.%1$I as restrictive for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_delete_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_delete_guard on public.%1$I as restrictive for delete to authenticated using (public.can_manage_family(family_id))', t);

    for pol in
      select p.polname
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = t
        and p.polpermissive
        and p.polcmd in ('a','w','d','*')
        and p.polname not in (t || '_mng_insert', t || '_mng_update', t || '_mng_delete')
    loop
      execute format('drop policy if exists %I on public.%I', pol.polname, t);
      swept := swept + 1;
      raise notice '0300: dropped stray permissive write policy %.%', t, pol.polname;
    end loop;
  end loop;

  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (clinical)
    and p.polpermissive
    and p.polcmd in ('a','w','d','*')
    and p.polname not in (c.relname || '_mng_insert', c.relname || '_mng_update', c.relname || '_mng_delete');

  if remaining <> 0 then
    raise exception '0300 FAILED: % permissive write policy(ies) still on the prescription tables after the sweep', remaining;
  end if;

  raise notice '0300 OK: % stray write policy(ies) swept; prescriptions and their schedules are managers-only to write', swept;
end $$;

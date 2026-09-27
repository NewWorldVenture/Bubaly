-- Bubaly :: 0461 - a table nothing in the product owns is not any member's
--                   to write (AUTHZ-020)
-- ----------------------------------------------------------------------------
-- AUTHZ-020 named sixteen tables that no application file references —
-- searched by bare table name across app/, lib/, components/, hooks/,
-- scripts/, mobile/ and supabase/functions, with lib/database.types.ts (the
-- generated mirror of every table) excluded — each still open to a write from
-- any household member. Re-measured on a database replayed through 0458:
--
--   CLOSED ALREADY, left alone here:
--     sync_calendar_shares, sync_change_logs, sync_conflict_resolutions,
--     sync_event_attendees, sync_note_folders, sync_notes, sync_settings
--         0355 dropped every permissive write policy on the sync engine's
--         tables; members keep SELECT, only the service role writes.
--     social_campaigns, social_post_assets
--         0356 gates their writes on social_has_permission(...), the social
--         command center's own permission model. Not role-blind, so not this
--         finding's shape, and a manager guard over it would be a second
--         authority the module does not know about.
--
--   STILL OPEN, narrowed here (still zero references in the tree):
--     family_stress_predictions   "Members can manage …"  FOR ALL is_family_member
--     vacation_activity_logs      "Members manage …"      FOR ALL is_family_member
--     vacation_activity_tickets   "Members manage …"      FOR ALL is_family_member
--     vacation_checklists         "Members manage …"      FOR ALL is_family_member
--     vacation_destinations       "Members manage …"      FOR ALL is_family_member
--     vacation_notifications      "Members manage …"      FOR ALL is_family_member
--     vacation_audit_logs         vacation_audit_logs_insert  INSERT is_family_member
--
-- Proven before this migration, on the local stack, as an active `child` and
-- as a `teen` of the same family: `insert into family_stress_predictions` and
-- `insert into vacation_audit_logs` both returned INSERT 1 — a child could
-- fabricate a stress prediction about the household and forge an "audit"
-- row. After it, both are refused with 42501 and a parent's identical insert
-- still succeeds.
--
-- WHY MANAGER-ONLY RATHER THAN DROP OR REVOKE. The finding records the repair
-- as a product decision — drop them, or leave them service-role-only — and
-- dropping is not reversible by whoever reads this next. Narrowing to
-- can_manage_family is the smallest change that closes the member write
-- without choosing: nothing in the product writes these tables today (so
-- nothing breaks), the service role and the seeds bypass RLS as before, and a
-- feature that later owns one of them starts from "a parent may write" and
-- has to widen it deliberately rather than inheriting "any member may".
-- tests/authz-020-unreferenced-tables-stay-unreferenced.test.ts remains the
-- tripwire that forces that decision when one is wired up.
--
-- Same shape as 0434: SELECT kept exactly as it was (is_family_member),
-- permissive manager writes, RESTRICTIVE manager guards so a permissive
-- policy re-added later cannot reopen the boundary on its own, then a sweep
-- of any other permissive write policy (the FOR ALL ones included, which is
-- why SELECT is recreated explicitly) and a post-condition that raises.
-- Idempotent: every policy is dropped-if-exists before it is created.
--
-- vacation_audit_logs is APPEND-ONLY and stays so: before this migration its
-- only write policy was INSERT, so no member could rewrite or erase a row.
-- It gets a manager INSERT and no permissive UPDATE/DELETE at all — narrowing
-- who may append must not widen what a manager may do to the history.

do $$
declare
  t         text;
  pol       record;
  swept     int := 0;
  remaining int;
  guarded   int;
  unowned   text[] := array[
    'family_stress_predictions',
    'vacation_activity_logs',
    'vacation_activity_tickets',
    'vacation_audit_logs',
    'vacation_checklists',
    'vacation_destinations',
    'vacation_notifications'
  ];
  -- Members could only ever INSERT an audit row; nobody (below the service
  -- role) could rewrite or erase one. Narrowing the inserter must not hand a
  -- manager the UPDATE and DELETE the table never granted.
  append_only text[] := array['vacation_audit_logs'];
begin
  foreach t in array unowned loop
    if to_regclass('public.' || t) is null then continue; end if;

    execute format('alter table public.%I enable row level security', t);

    -- Reading is unchanged: every member of the family, as before.
    execute format('drop policy if exists %1$s_select on public.%1$I', t);
    execute format('create policy %1$s_select on public.%1$I for select to authenticated using (public.is_family_member(family_id))', t);

    execute format('drop policy if exists %1$s_mng_insert on public.%1$I', t);
    execute format('create policy %1$s_mng_insert on public.%1$I for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_mng_update on public.%1$I', t);
    execute format('drop policy if exists %1$s_mng_delete on public.%1$I', t);
    if not (t = any (append_only)) then
      execute format('create policy %1$s_mng_update on public.%1$I for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
      execute format('create policy %1$s_mng_delete on public.%1$I for delete to authenticated using (public.can_manage_family(family_id))', t);
    end if;

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
      raise notice '0461: dropped member write policy %.%', t, pol.polname;
    end loop;
  end loop;

  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (unowned)
    and p.polpermissive
    and p.polcmd in ('a','w','d','*')
    and p.polname not in (c.relname || '_mng_insert', c.relname || '_mng_update', c.relname || '_mng_delete');

  if remaining <> 0 then
    raise exception '0461 FAILED: % permissive member write policy(ies) still on the unowned tables', remaining;
  end if;

  select count(*) into guarded
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (unowned)
    and not p.polpermissive
    and p.polname = c.relname || '_manager_insert_guard';

  if guarded <> (select count(*) from unnest(unowned) u where to_regclass('public.' || u) is not null) then
    raise exception '0461 FAILED: only % of the unowned tables carry a restrictive manager insert guard', guarded;
  end if;

  raise notice '0461 OK: % member write policy(ies) swept; % unowned table(s) are managers-only to write', swept, guarded;
end $$;

-- 0333 — Guardian screening is a parent's to configure, not the screened person's.
--
-- Guardian screens a family member's incoming calls and texts. Two tables decide
-- what reaches them:
--
--   guardian_contacts         each caller's trust_level, from `blocked` up to
--                             `immediate_family`
--   guardian_member_profiles  how each member's calls route: a default mode per
--                             trust level, the current context, the number
--
-- 01370 gave both ONE policy, `FOR ALL … is_family_member(family_id)`. Every server
-- action in app/(app)/guardian/actions.ts that writes them checks `isManager` first
-- — but PostgREST is reachable with the same JWT, so that check was a UI boundary
-- and never a database one. 0215 hardened guardian_routing_rules the same way; it
-- stopped one table short of the two that matter most. Measured on a full replay as
-- a real `authenticated` child, before this migration:
--
--   update guardian_contacts set trust_level = 'immediate_family' where …  -> UPDATE 1
--   update guardian_member_profiles set default_mode_unknown = 'immediate_ring' …
--                                                                        -> UPDATE 1
--
-- The first lets a number a parent blocked as a scam ring straight through. The
-- second turns screening off for every unknown caller. Either way the protection
-- could be switched off by the person it exists to protect.
--
-- WHY MANAGER-ONLY BREAKS NOTHING. Every writer to these tables is one of:
--   - a Guardian server action, all eleven gated on isManager in code, or
--   - a SERVICE-ROLE path — the inbound SMS/voice/WhatsApp webhooks, the screening
--     route, the decision pipeline, SMS recovery and the learning cron — which
--     bypasses RLS and is unaffected.
-- There is no member-side write to preserve. Reads stay family-wide: a child still
-- sees their own routing and the family's contacts, because a screening rule nobody
-- can see is not one.
--
-- Same shape as 0328: manager-gated permissive policies, RESTRICTIVE guards that
-- are ANDed with every permissive policy so a stray one added later cannot reopen
-- the boundary alone, and a sweep of any other permissive write policy by SHAPE
-- rather than by name — narrowing by name is how 0217 left six tables behind.
--
-- Proved by docs/audit/guardian-screening-write-boundary-check.sql, which fails on
-- the schema before this migration with "a child promoted a blocked caller to
-- immediate_family" and passes after it, including a parent's positive control.
--
-- Agents must NOT apply this to production. It is committed for an operator to
-- apply with the other pending migrations.

do $$
declare
  t         text;
  pol       record;
  swept     int := 0;
  remaining int;
  screening text[] := array['guardian_contacts', 'guardian_member_profiles'];
begin
  foreach t in array screening loop
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

    execute format('drop policy if exists %1$s_manager_insert_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_insert_guard on public.%1$I as restrictive for insert to authenticated with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_update_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_update_guard on public.%1$I as restrictive for update to authenticated using (public.can_manage_family(family_id)) with check (public.can_manage_family(family_id))', t);
    execute format('drop policy if exists %1$s_manager_delete_guard on public.%1$I', t);
    execute format('create policy %1$s_manager_delete_guard on public.%1$I as restrictive for delete to authenticated using (public.can_manage_family(family_id))', t);

    -- By SHAPE: every other permissive write policy goes, whatever it is called —
    -- including 01370's "Family member can manage …" FOR ALL policy.
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
      raise notice '0333: dropped permissive write policy %.%', t, pol.polname;
    end loop;
  end loop;

  select count(*) into remaining
  from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = any (screening)
    and p.polpermissive
    and p.polcmd in ('a','w','d','*')
    and pg_get_expr(coalesce(p.polqual, p.polwithcheck), p.polrelid) !~ 'can_manage_family';
  if remaining <> 0 then
    raise exception '0333: % permissive write policy(ies) on the Guardian screening tables still do not require a manager', remaining;
  end if;

  raise notice '0333: Guardian screening tables are manager-written (% stray policy(ies) swept)', swept;
end $$;

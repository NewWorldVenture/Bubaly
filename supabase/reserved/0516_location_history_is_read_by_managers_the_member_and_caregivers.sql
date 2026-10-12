-- 0516 — Location history is read by a manager, the member and a caregiver.
-- Decided by the account holder this session, recorded and requested on #771
-- in comment 6109587749: the audit's open sensitive-table finding ("55 OPEN,
-- owner decision"), location group.
--
-- location_events, safety_check_ins and driving_trips read with
-- is_family_member(family_id), so a teen or a child reads every other
-- member's places arrived at and left, every check-in with its coordinates,
-- and every driving trip with its score, speeding and phone use.
-- lib/ai/context/policy.ts lists all three as sensitive ("location history",
-- "check-in locations", "driving telemetry"). Live location (member_locations)
-- already carries its own sharing rule and is not touched.
--
-- The decision, in the shape of 0506 and 0510:
--   * a parent or adult reads every row;
--   * the member a row is about reads it;
--   * a caregiver reads the household's: a sitter may need a child's
--     whereabouts;
--   * nobody else.
--
--   is_family_member(family_id)
--   and (can_manage_family(family_id)
--        or is_self_member(member_id)
--        or family_role(family_id) = 'caregiver')
--
-- is_self_member(null) is false, so a row about nobody is a manager's or a
-- caregiver's. The outer is_family_member keeps it to active members
-- (family_role does not read is_active). Every permissive read on the three
-- tables is replaced; restrictive policies already there (0509's guest guard,
-- the no-client-update/delete guards) are kept. Writes are unchanged.
--
-- Shipped with the source (lib/location/history-scope.ts, the same rule): the
-- locator's history and arrival alerts, the check-in feed and the driving log
-- show each viewer the rows this rule gives them, and say so to a viewer who
-- reads only their own. The retention sweep reads through the service role.
--
-- HELD: 0516, requested on #771 in comment 6109587749 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by
-- docs/audit/reserved/location-history-is-read-by-managers-the-member-and-caregivers-check.sql
-- and .github/workflows/location-history-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  t text;
  p record;
begin
  if to_regprocedure('public.family_role(uuid)') is null or to_regprocedure('public.can_manage_family(uuid)') is null
     or to_regprocedure('public.is_self_member(uuid)') is null then
    raise exception '0516 needs family_role, can_manage_family and is_self_member';
  end if;
  foreach t in array array['location_events', 'safety_check_ins', 'driving_trips'] loop
    if to_regclass('public.' || t) is null
       or not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = t and column_name = 'member_id') then
      raise exception '0516 needs public.%.member_id', t;
    end if;
    for p in select polname from pg_policy
              where polrelid = ('public.' || t)::regclass and polpermissive and polcmd in ('r', '*') loop
      execute format('drop policy %I on public.%I', p.polname, t);
    end loop;
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || 'public.is_family_member(family_id) and ('
      || 'public.can_manage_family(family_id) or public.is_self_member(member_id) or public.family_role(family_id) = ''caregiver''))',
      'History is read by a manager, the member or a caregiver', t);
  end loop;
end
$$;

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['location_events', 'safety_check_ins', 'driving_trips'] loop
    select count(*) into n from pg_policy
     where polrelid = ('public.' || t)::regclass and polpermissive and polcmd in ('r', '*');
    if n <> 1 or not exists (select 1 from pg_policy
                              where polrelid = ('public.' || t)::regclass and polpermissive and polcmd = 'r'
                                and polname = 'History is read by a manager, the member or a caregiver') then
      raise exception '0516: public.% carries % permissive read policies, not the one it sets', t, n;
    end if;
  end loop;
end
$$;

-- 0506 — A health record is read by a manager or by the member it is about.
-- 0438's rule ("a manager reads the family's profiles; everybody else reads
-- their own") carried to the eight per-member health tables it stopped short
-- of. Decided by the account holder on the lead in #771 comment 6092825901:
-- every non-manager reads only their own record, caregivers included.
--
-- symptom_logs, health_metrics, health_goals, health_visits, immunizations,
-- sleep_logs, sleep_checkins and nutrition_logs each read with
-- is_family_member(family_id): every member (a teen, a child, a caregiver, a
-- guest) read every other member's symptoms, measurements, goals, visits,
-- immunisations, sleep and meals. Measured on a replay of every runnable
-- migration, as each of those roles: one row about another member, in each
-- table, read (1). lib/ai/context/policy.ts already lists all eight as
-- sensitive, and 0438's header named symptom_logs as "the same per-member
-- shape … a separate change".
--
-- For each table this replaces every permissive SELECT policy with one:
--
--   is_family_member(family_id)
--   and (can_manage_family(family_id)      -- a parent or adult: everyone's
--        or is_self_member(member_id)      -- your own record
--        or created_by = auth.uid())       -- what you wrote yourself
--
-- The third term is beyond 0438's and deliberate: these tables' own UPDATE and
-- DELETE policies already treat the author as entitled to their row
-- (created_by = auth.uid()), and a member who logs a symptom or a meal for a
-- child keeps seeing what they wrote, not the child's record as a whole. The
-- outer is_family_member(family_id) stays, as in 0438, because is_self_member
-- is not bound to the row's family. A row with no member (member_id is null on
-- health_visits, immunizations and nutrition_logs) is a manager's or its
-- author's. Writes are unchanged.
--
-- Screens shipped with the source (no-ops before release, since RLS returns the
-- same rows to a manager): the sleep, nutrition, health-visits and immunisations
-- views offer a non-manager only their own member, as the health module
-- already did. The AI insights route reads through the caller's session, so
-- RLS narrows it; the health coach already grounds a non-manager on their own
-- record.
--
-- Not changed, recorded: behavior_logs and care_log (notes ABOUT a member,
-- written by others; whether the member reads them is a separate decision) and
-- the medication tables (with the 0465 candidate's owner).
--
-- HELD: 0506, the first number above 0505, requested on #771 in comment
-- 6100826185 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-health-record-is-read-by-a-manager-or-its-own-member-check.sql
-- and .github/workflows/health-records-runtime.yml. Not applied to production by
-- an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['symptom_logs', 'health_metrics', 'health_goals', 'health_visits',
                           'immunizations', 'sleep_logs', 'sleep_checkins', 'nutrition_logs'] loop
    if to_regclass('public.' || t) is null then
      raise exception '0506 needs public.%', t;
    end if;
    if (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = t
           and column_name in ('family_id', 'member_id', 'created_by')) <> 3 then
      raise exception '0506: public.% lacks family_id, member_id or created_by', t;
    end if;
    -- Every permissive policy that reads (SELECT or ALL) goes: permissive
    -- policies are OR'd, so one left behind restores the family-wide read.
    for p in select polname from pg_policy
              where polrelid = ('public.' || t)::regclass and polpermissive and polcmd in ('r', '*') loop
      execute format('drop policy %I on public.%I', p.polname, t);
    end loop;
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || 'public.is_family_member(family_id) and ('
      || 'public.can_manage_family(family_id) or public.is_self_member(member_id) or created_by = auth.uid()))',
      'Members read their own ' || t, t);
  end loop;
end
$$;

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['symptom_logs', 'health_metrics', 'health_goals', 'health_visits',
                           'immunizations', 'sleep_logs', 'sleep_checkins', 'nutrition_logs'] loop
    select count(*) into n from pg_policy
     where polrelid = ('public.' || t)::regclass and polpermissive and polcmd in ('r', '*');
    if n <> 1 or not exists (select 1 from pg_policy
                              where polrelid = ('public.' || t)::regclass and polpermissive and polcmd = 'r'
                                and polname = 'Members read their own ' || t) then
      raise exception '0506: public.% carries % permissive read policies, not the one it sets', t, n;
    end if;
  end loop;
end
$$;

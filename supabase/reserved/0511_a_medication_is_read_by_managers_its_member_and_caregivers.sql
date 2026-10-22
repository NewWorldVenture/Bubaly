-- 0511 — A medication is read by a manager, the member it is for and a
-- caregiver.
-- Decided by the account holder this session, recorded and requested on #771
-- in comment 6104294318; the rows with no member decided in a follow-up the
-- same session. It is the read 0434 filed for an owner decision ("READS ARE
-- UNCHANGED. A child can still read a parent's prescription … Filed for an
-- owner decision rather than guessed at here."), and it takes over the closed
-- #674's candidate (a_child_reads_only_their_own_prescriptions, F-G09), with
-- the owner's answer on caregivers added.
--
-- medications_select and medication_schedules_select are
-- is_family_member(family_id) (0434), so a teen or a child reads every
-- prescription in the household, a parent's antidepressant included, with its
-- dosage, instructions and refill date. lib/ai/context/policy.ts lists both as
-- sensitive.
--
-- The decision:
--   * a parent or adult reads every medication;
--   * the member a medication is for reads it;
--   * a caregiver reads the household's medications: they may give them;
--   * a medication saved with no member is read by a parent, an adult or a
--     caregiver, like any other: the Medicines form defaults "For" to "Whole
--     family", so a parent's own prescription is often stored with no member
--     (#674 found a parent's sertraline filed that way), and "no member" is
--     not evidence that the whole household should read it;
--   * nobody else: a teen or a child reads the medicines assigned to them.
--
--   medications:
--     is_family_member(family_id)
--     and (can_manage_family(family_id)              -- a parent or adult
--          or is_self_member(member_id)              -- the member it is for
--          or family_role(family_id) = 'caregiver')  -- who may give it
--
-- is_self_member(null) is false, so a row with no member falls to the first
-- and last terms.
--
--   medication_schedules (no member of its own; it follows its medication):
--     is_family_member(family_id)
--     and exists (select 1 from medications m
--                  where m.id = medication_id and m.family_id = family_id)
--
-- The schedule's subquery is evaluated under the caller's RLS on medications,
-- so a schedule is read exactly when its medication is, by one rule. The outer
-- is_family_member keeps both to active members (family_role does not read
-- is_active). Every permissive read on the two tables is replaced; the
-- restrictive guards already there (0434's manager write guards, the held
-- 0509's guest read guard on both) are kept. Writes are unchanged (0434:
-- managers only), and medication_doses is unchanged (0481: a manager or the
-- member).
--
-- Shipped with the source: the autopilot refill scan wrote "Refill <drug> in 3
-- days" into three places every member reads or receives (the suggestion row,
-- the reminder it auto-creates, and a family-wide notification). The
-- notification now goes to the managers, the caregivers and the member (if
-- any), and names the drug; the suggestion and the reminder, which the whole
-- household reads, say "a prescription". The dose reminder already goes to the
-- member or the managers, and the morning brief to the managers. The Medicines
-- page shows a caregiver the household's medicines, as it shows a manager.
--
-- HELD: 0511, the first number above 0510, requested on #771 in comment
-- 6104294318 and not yet confirmed. It stays in supabase/reserved/ until every
-- number below it has landed. Proven by
-- docs/audit/reserved/a-medication-is-read-by-managers-its-member-and-caregivers-check.sql
-- and .github/workflows/medication-reads-runtime.yml. Not applied to production
-- by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  t text;
  p record;
begin
  if to_regprocedure('public.family_role(uuid)') is null
     or to_regprocedure('public.can_manage_family(uuid)') is null
     or to_regprocedure('public.is_self_member(uuid)') is null then
    raise exception '0511 needs family_role, can_manage_family and is_self_member';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'medications' and column_name = 'member_id')
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'medication_schedules' and column_name = 'medication_id') then
    raise exception '0511 needs medications.member_id and medication_schedules.medication_id';
  end if;
  foreach t in array array['medications', 'medication_schedules'] loop
    for p in select polname from pg_policy
              where polrelid = ('public.' || t)::regclass and polpermissive and polcmd in ('r', '*') loop
      execute format('drop policy %I on public.%I', p.polname, t);
    end loop;
  end loop;

  create policy "A medication is read by a manager, its member or a caregiver"
    on public.medications for select to authenticated
    using (public.is_family_member(family_id)
           and (public.can_manage_family(family_id)
                or public.is_self_member(member_id)
                or public.family_role(family_id) = 'caregiver'));

  create policy "A schedule is read with its medication"
    on public.medication_schedules for select to authenticated
    using (public.is_family_member(family_id)
           and exists (select 1 from public.medications m
                        where m.id = medication_schedules.medication_id
                          and m.family_id = medication_schedules.family_id));
end
$$;

do $$
declare
  x record;
  n int;
begin
  for x in select * from (values ('medications', 'A medication is read by a manager, its member or a caregiver'),
                                 ('medication_schedules', 'A schedule is read with its medication')) as v(t, want) loop
    select count(*) into n from pg_policy
     where polrelid = ('public.' || x.t)::regclass and polpermissive and polcmd in ('r', '*');
    if n <> 1 or not exists (select 1 from pg_policy
                              where polrelid = ('public.' || x.t)::regclass and polpermissive and polcmd = 'r' and polname = x.want) then
      raise exception '0511: public.% carries % permissive read policies, not the one it sets', x.t, n;
    end if;
  end loop;
end
$$;

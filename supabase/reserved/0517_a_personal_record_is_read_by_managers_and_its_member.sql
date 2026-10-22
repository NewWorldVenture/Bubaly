-- 0517 — A personal record is read by a manager and the member it is about.
-- Decided by the account holder this session, recorded and requested on #771
-- in comment 6109587749: the audit's open sensitive-table finding ("55 OPEN,
-- owner decision"), personal-records group.
--
-- Six tables hold records about one member and read with
-- is_family_member(family_id), so a teen or a child reads every other
-- member's:
--
--   insurance_policies, family_insurance_policies   policy numbers
--   vacation_documents                              passport and ticket detail
--   voice_commands                                  verbatim dictated speech
--   vacation_medical_information                    travel medical detail
--   health_providers                                clinicians
--
-- lib/ai/context/policy.ts lists every one as sensitive.
--
-- The decision:
--   * a parent or adult reads every row;
--   * the member a row is about reads it;
--   * for the two medical tables, a caregiver reads the household's too: a
--     sitter may need a child's doctor or travel medical detail;
--   * a row about nobody is a manager's (and, for the medical two, a
--     caregiver's); nobody else reads it.
--
--   personal:  is_family_member(family_id)
--              and (can_manage_family(family_id) or is_self_member(member_id))
--   medical:   ... or family_role(family_id) = 'caregiver'
--
-- Every permissive read on the six tables is replaced. vacation_documents and
-- vacation_medical_information each carried ONE FOR ALL policy ("Members
-- manage …"), so its write half is re-created first, per command, with that
-- policy's own USING and WITH CHECK: writes are exactly what they were.
-- Restrictive policies already there (the held 0509's guest guard on four of
-- them) are kept.
--
-- Shipped with the source (lib/records/personal-scope.ts, the same rule): the
-- insurance hub, the medical and dental records pages (insurance cards and
-- providers), the trip documents and travel medical sections, the trip
-- emergency summary and the voice history show each viewer the rows this rule
-- gives them, and say so to a viewer who reads only their own.
--
-- HELD: 0517, requested on #771 in comment 6109587749 and not yet confirmed.
-- It stays in supabase/reserved/ until every number below it has landed.
-- Proven by
-- docs/audit/reserved/a-personal-record-is-read-by-managers-and-its-member-check.sql
-- and .github/workflows/personal-records-runtime.yml. Not applied to
-- production by an agent; recorded in docs/PENDING_PROD_MIGRATIONS.md.

do $$
declare
  x record;
  p record;
  using_expr text;
  check_expr text;
begin
  if to_regprocedure('public.family_role(uuid)') is null or to_regprocedure('public.can_manage_family(uuid)') is null
     or to_regprocedure('public.is_self_member(uuid)') is null then
    raise exception '0517 needs family_role, can_manage_family and is_self_member';
  end if;
  for x in select * from (values ('insurance_policies', false), ('family_insurance_policies', false),
                                 ('vacation_documents', false), ('voice_commands', false),
                                 ('vacation_medical_information', true), ('health_providers', true)) as v(t, medical) loop
    if to_regclass('public.' || x.t) is null
       or not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = x.t and column_name = 'member_id') then
      raise exception '0517 needs public.%.member_id', x.t;
    end if;
    for p in select polname, polcmd, polroles, pg_get_expr(polqual, polrelid) as qual, pg_get_expr(polwithcheck, polrelid) as chk
               from pg_policy
              where polrelid = ('public.' || x.t)::regclass and polpermissive and polcmd in ('r', '*') loop
      if p.polcmd = '*' then
        -- Keep the write half of a FOR ALL policy, verbatim, per command.
        using_expr := coalesce(p.qual, 'true');
        check_expr := coalesce(p.chk, p.qual, 'true');
        execute format('drop policy if exists %I on public.%I', 'Members add ' || x.t, x.t);
        execute format('drop policy if exists %I on public.%I', 'Members change ' || x.t, x.t);
        execute format('drop policy if exists %I on public.%I', 'Members remove ' || x.t, x.t);
        execute format('create policy %I on public.%I for insert to authenticated with check (%s)', 'Members add ' || x.t, x.t, check_expr);
        execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', 'Members change ' || x.t, x.t, using_expr, check_expr);
        execute format('create policy %I on public.%I for delete to authenticated using (%s)', 'Members remove ' || x.t, x.t, using_expr);
      end if;
      execute format('drop policy %I on public.%I', p.polname, x.t);
    end loop;
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || 'public.is_family_member(family_id) and ('
      || 'public.can_manage_family(family_id) or public.is_self_member(member_id)%s))',
      'A personal record is read by a manager or its member', x.t,
      case when x.medical then ' or public.family_role(family_id) = ''caregiver''' else '' end);
  end loop;
end
$$;

do $$
declare
  t text;
  n int;
begin
  foreach t in array array['insurance_policies', 'family_insurance_policies', 'vacation_documents', 'voice_commands',
                           'vacation_medical_information', 'health_providers'] loop
    select count(*) into n from pg_policy
     where polrelid = ('public.' || t)::regclass and polpermissive and polcmd in ('r', '*');
    if n <> 1 or not exists (select 1 from pg_policy
                              where polrelid = ('public.' || t)::regclass and polpermissive and polcmd = 'r'
                                and polname = 'A personal record is read by a manager or its member') then
      raise exception '0517: public.% carries % permissive read policies, not the one it sets', t, n;
    end if;
    if not exists (select 1 from pg_policy where polrelid = ('public.' || t)::regclass and polpermissive and polcmd = 'a')
       or not exists (select 1 from pg_policy where polrelid = ('public.' || t)::regclass and polpermissive and polcmd = 'w')
       or not exists (select 1 from pg_policy where polrelid = ('public.' || t)::regclass and polpermissive and polcmd = 'd') then
      raise exception '0517: public.% lost a write policy', t;
    end if;
  end loop;
end
$$;

-- Who may actually WRITE the health tables, and what the client is told.
--
-- Pass T swept these tables at the RLS layer. This probe asks the two questions
-- that survive a clean RLS sweep:
--
-- 1. health_providers / insurance_policies / medical_profiles are SELECT
--    is_family_member but UPDATE/DELETE can_manage_family. A teen or caregiver
--    therefore SEES the list and cannot write it — and a blocked write under
--    RLS is not an error: it matches zero rows and returns success. Every
--    client handler in medical-records-module reads `if (error) … else
--    success(...)`, so it reports "Deleted" over a row that is still there.
--    This asserts the zero-row/no-error shape the client misreads.
--
-- 2. `medications` looks unguarded and is not. It carries BOTH a
--    can_manage_family and an is_family_member policy for insert/update/delete,
--    which reads like a manager gate sitting uselessly beside a broad one --
--    permissive policies are OR'd. They are not both permissive: the
--    can_manage_family ones are RESTRICTIVE, so they AND. A listing that omits
--    `polpermissive` shows the same seven rows and supports the wrong reading;
--    this assertion is here so the question is answered by the database.
--
-- Judged on ROW COUNTS, never on exceptions: a blocked write raises nothing.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam  uuid := '00000000-0000-4000-8000-00000000ea01';
  uPar uuid := '00000000-0000-4000-8000-00000000ea0a';
  uTeen uuid := '00000000-0000-4000-8000-00000000ea0b';
  mTeen uuid; mPar uuid;
  provider uuid; policy uuid; med uuid;
  n int; failures int := 0;
begin
  delete from public.families where id = fam;
  insert into auth.users (id, email) values
    (uPar, 'health-parent@example.com'), (uTeen, 'health-teen@example.com')
    on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Health family', uPar)
    on conflict (id) do nothing;
  select id into mPar from public.family_members where family_id = fam and user_id = uPar;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, uTeen, 'Teen', 'teen', true) returning id into mTeen;

  insert into public.health_providers (family_id, kind, name, created_by)
    values (fam, 'medical', 'Dr Ada', uPar) returning id into provider;
  insert into public.insurance_policies (family_id, kind, insurer, created_by)
    values (fam, 'medical', 'BlueCross', uPar) returning id into policy;
  insert into public.medications (family_id, member_id, name, created_by)
    values (fam, mPar, 'Amoxicillin', uPar) returning id into med;

  -- Act as the TEEN.
  perform set_config('request.jwt.claim.sub', uTeen::text, true);
  set local role authenticated;

  -- Control first: the teen really can READ these rows, or "cannot delete"
  -- would just mean "cannot see".
  select count(*) into n from public.health_providers where id = provider;
  if n <> 1 then
    raise warning 'CONTROL FAILED: the teen cannot even read the provider (rows: %)', n;
    failures := failures + 1;
  end if;

  -- 1. The delete the client reports as success.
  delete from public.health_providers where id = provider;
  get diagnostics n = row_count;
  if n <> 0 then
    raise warning 'BREACH: a teen deleted a health provider (rows: %)', n;
    failures := failures + 1;
  end if;

  update public.insurance_policies set insurer = 'Edited by teen' where id = policy;
  get diagnostics n = row_count;
  if n <> 0 then
    raise warning 'BREACH: a teen edited an insurance policy (rows: %)', n;
    failures := failures + 1;
  end if;

  -- 2. medications: the manager gate sits beside a broad is_family_member
  --    policy. Permissive policies OR, so this is expected to SUCCEED — the
  --    assertion records which of the two readings is true.
  delete from public.medications where id = med;
  get diagnostics n = row_count;
  if n <> 0 then
    raise warning 'BREACH: a teen deleted a medication (rows: %) — the restrictive can_manage_family guard is gone', n;
    failures := failures + 1;
  end if;

  -- Closing control: a MANAGER can still do all three, so none of the above
  -- means "nobody can write these tables".
  reset role;
  perform set_config('request.jwt.claim.sub', uPar::text, true);
  set local role authenticated;
  delete from public.health_providers where id = provider;
  get diagnostics n = row_count;
  if n <> 1 then
    raise warning 'CONTROL FAILED: a parent could not delete the provider (rows: %)', n;
    failures := failures + 1;
  end if;

  reset role;
  perform set_config('request.jwt.claim.sub', '', true);

  delete from public.families where id = fam;

  if failures > 0 then
    raise exception 'health-write-gate FAILED: % assertion(s)', failures;
  end if;
  raise notice 'health-write-gate OK: a manager-gated write refuses a non-manager with ZERO ROWS and no error (5 assertions)';
end
$probe$;

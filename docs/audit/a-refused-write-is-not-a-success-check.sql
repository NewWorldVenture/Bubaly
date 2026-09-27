-- A write row-level security refused is not an error.
--
-- Postgres applies a restrictive policy's `using` clause as a FILTER, so an
-- UPDATE or DELETE that it refuses matches nothing and SUCCEEDS. The client
-- receives no error. PostgREST returns the affected rows only when the request
-- asks for them — `.select()` is what appends `Prefer: return=representation` —
-- so without it `data` is null whether one row changed or none did, and the
-- call site cannot tell even in principle.
--
-- Thirty-nine browser-direct writes checked `error`, saw null, and reported
-- success: "Medication deleted", "Bill marked as paid", "Entry deleted". They
-- now send `.select('id')` and treat zero rows as a refusal
-- (lib/supabase/errors.ts → wroteNoRows).
--
-- This probe asserts the property on the REAL schema with the REAL policies
-- (0309), because the behaviour is the whole basis for that change. It judges
-- ROW COUNTS: an exception-only assertion would report a boundary that is not
-- there, since the refusal raises nothing.
\set ON_ERROR_STOP on
set client_min_messages = notice;

do $probe$
declare
  fam        uuid := '00000000-0000-4000-8000-0000000fc011';
  parent_uid uuid := '00000000-0000-4000-8000-0000000fc0a1';
  child_uid  uuid := '00000000-0000-4000-8000-0000000fc0a2';
  child_mid uuid; med uuid; n int; dosage_now text; still int; failures int := 0;
begin
  delete from public.medication_schedules where family_id = fam;
  delete from public.medications where family_id = fam;
  insert into auth.users (id, email) values
    (parent_uid, 'refused-write-parent@example.com'), (child_uid, 'refused-write-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Refused writes', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true), (fam, child_uid, 'Child', 'child', true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;
  insert into public.medications (family_id, member_id, name, dosage, is_active, created_by)
    values (fam, child_mid, 'Methylphenidate', '10 mg', true, parent_uid) returning id into med;

  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- What the browser sent BEFORE the fix. No RETURNING, so PostgREST answers
  -- with no representation and the client sees { data: null, error: null }.
  update public.medications set dosage = '40 mg' where id = med;
  get diagnostics n = row_count;
  if n <> 0 then raise notice 'FAIL: a child changed a prescription (% row)', n; failures := failures + 1;
  else raise notice 'ok: child UPDATE without RETURNING -> 0 rows, no error'; end if;

  delete from public.medications where id = med;
  get diagnostics n = row_count;
  if n <> 0 then raise notice 'FAIL: a child deleted a prescription (% row)', n; failures := failures + 1;
  else raise notice 'ok: child DELETE without RETURNING -> 0 rows, no error'; end if;

  -- What the fix sends. `.select('id')` becomes RETURNING id, and zero rows is
  -- now something the caller can SEE.
  with x as (update public.medications set dosage = '40 mg' where id = med returning id)
    select count(*) into n from x;
  if n <> 0 then raise notice 'FAIL: RETURNING handed back % row(s)', n; failures := failures + 1;
  else raise notice 'ok: child UPDATE with RETURNING -> 0 rows VISIBLE to the caller'; end if;

  reset role;
  select dosage, count(*) over () into dosage_now, still from public.medications where id = med;
  if still <> 1 or dosage_now <> '10 mg' then
    raise notice 'FAIL: the prescription moved (present=%, dosage=%)', still, dosage_now; failures := failures + 1;
  else raise notice 'ok: prescription untouched — still present, still 10 mg'; end if;

  -- Positive control: the fix must not break the manager path it protects.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  with x as (update public.medications set dosage = '20 mg' where id = med returning id)
    select count(*) into n from x;
  reset role;
  if n <> 1 then raise notice 'FAIL: a parent could not update (% rows)', n; failures := failures + 1;
  else raise notice 'ok: parent UPDATE with RETURNING -> 1 row (control)'; end if;

  if failures > 0 then raise exception '% assertion(s) failed', failures; end if;
  raise notice 'a-refused-write-is-not-a-success: all assertions passed';
end $probe$;

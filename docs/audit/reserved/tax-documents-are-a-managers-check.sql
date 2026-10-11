-- ── Tax documents are a manager's (0508) ────────────────────────────────────
--
-- 0481 (released) narrowed tax_documents to a manager, plus a teen's or
-- child's read of a document about themselves, and 0391's step-up binds a
-- manager on the rows. The files were left open: the documents bucket served
-- {family}/tax/… to every member, and to an enrolled manager at aal1 whom 0391
-- refuses the rows. The held 0508 makes the rows and the files a manager's (a
-- parent or adult of the family), and holds the files to the rows' step-up.
--
-- Fixture, Tax House: a parent and an adult (managers, no second factor), a
-- second parent with a verified factor, a teen, a child, a caregiver and a
-- guest; Next Door's parent, a stranger. Seeded as the server writes them: a
-- W-2 row with its file under tax/2025/, a 1099 row whose file sits outside
-- tax/ (misc/), a row about the child with no file, a file under tax/2024/ no
-- row names yet (an upload in flight), and an ordinary receipt under receipts/.
-- The fixture is laid again before each role.
--
-- What this probe asserts, through PostgREST's role, each outcome exact
-- (`OK <rows>` or the SQLSTATE and message):
--
--   1. the teen, the child, the caregiver and the guest each read 0 tax rows
--      (the child's own included) and 0 of the three tax files; their rename
--      and delete of the W-2 row change 0 rows, their new tax row is refused
--      (42501), and their move, replace and delete of the W-2's file change 0
--      rows and their upload under tax/ (with the family id upper-cased, a
--      spelling the bucket's cast accepts) is refused by the tax-file policy
--      (42501); afterwards the three rows and three files are there unchanged
--      (counted);
--   2. control: each of them still reads the receipt and uploads a file
--      outside tax/ (OK 1);
--   3. control: the parent and the adult read the three rows and three files,
--      annotate the W-2, file a tax row, upload under tax/ and remove the
--      in-flight file (OK 1 each);
--   4. the enrolled parent at aal1 reads 0 rows (0391) and 0 files, moves the
--      1099's file and deletes the W-2's (existing paths, inside and outside
--      tax/) changing 0 rows, and is refused an upload at a new path under tax/;
--      control: at aal2 they read the three rows and files, upload under tax/
--      and remove the W-2's file (OK 1 each);
--   5. control: a stranger reads nothing; and a tax row Next Door's parent
--      plants in Next Door naming Tax House's receipt does not withhold that
--      receipt from Tax House's child (the row must be the object's own
--      family's);
--   6. control: the service role, carrying the child's user id and without
--      one, reads the three rows, and the table owner with no session reads
--      the three files. That stands in for storage-api as SQL: no download and
--      no signed URL is exercised here;
--   7. wiring: tax_documents carries exactly four permissive policies, each
--      can_manage_family(family_id) for authenticated, and 0391's four step-up
--      guards; storage.objects carries the restrictive "Tax files are a
--      manager's" with exactly 0508's predicate; the helper is SECURITY DEFINER
--      with a pinned search_path and not executable by PUBLIC or anon;
--
-- and, only where 0508 is installed, each in a rolled-back subtransaction:
--
--   N1. NEGATIVE CONTROL: with 0481's read put back and the tax-file policy
--       dropped, the child reads their own row and all three files, and the
--       enrolled parent at aal1 all three files;
--   M1. MUTATION CONTROL: with the helper's row branch removed, the child reads
--       the 1099's file outside tax/ (1); with its folder branch removed, the
--       in-flight file (1): 1. catches either;
--   M2. MUTATION CONTROL: with the helper's step-up term removed, the enrolled
--       parent at aal1 reads the three files: 4. catches it.
--
-- Everything is rolled back.
--
-- HELD with 0508: this probe sits in docs/audit/reserved/, so the Database
-- job's glob does not run it against the released schema, where it fails.
-- .github/workflows/tax-documents-runtime.yml runs it there to show the
-- failure, then applies the held migration and requires it to pass. It moves
-- back to docs/audit/ when 0508 is released.
--
-- Agents must NOT apply migrations to production (human-owned; see
-- docs/PENDING_PROD_MIGRATIONS.md). This runs on a throwaway database only.

begin;

insert into storage.buckets (id, name, public) values ('documents', 'documents', false) on conflict do nothing;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8508-0000000000a1','t0508-parent@example.com'),
  ('00000000-0000-4000-8508-0000000000a2','t0508-adult@example.com'),
  ('00000000-0000-4000-8508-0000000000a3','t0508-teen@example.com'),
  ('00000000-0000-4000-8508-0000000000a4','t0508-child@example.com'),
  ('00000000-0000-4000-8508-0000000000a5','t0508-caregiver@example.com'),
  ('00000000-0000-4000-8508-0000000000a6','t0508-guest@example.com'),
  ('00000000-0000-4000-8508-0000000000a7','t0508-enrolled@example.com'),
  ('00000000-0000-4000-8508-0000000000a9','t0508-stranger@example.com')
  on conflict do nothing;
insert into auth.mfa_factors (user_id, factor_type, status) values ('00000000-0000-4000-8508-0000000000a7', 'totp', 'verified');
-- on_family_created files each creator as its household's parent.
insert into public.families (id, name, created_by) values
  ('00000000-0000-4000-8508-0000000000f1','Tax House','00000000-0000-4000-8508-0000000000a1'),
  ('00000000-0000-4000-8508-0000000000f9','Next Door','00000000-0000-4000-8508-0000000000a9');
insert into public.family_members (family_id, user_id, display_name, role, is_active) values
  ('00000000-0000-4000-8508-0000000000f1','00000000-0000-4000-8508-0000000000a2','Adult','adult',true),
  ('00000000-0000-4000-8508-0000000000f1','00000000-0000-4000-8508-0000000000a3','Teen','teen',true),
  ('00000000-0000-4000-8508-0000000000f1','00000000-0000-4000-8508-0000000000a4','Child','child',true),
  ('00000000-0000-4000-8508-0000000000f1','00000000-0000-4000-8508-0000000000a5','Caregiver','caregiver',true),
  ('00000000-0000-4000-8508-0000000000f1','00000000-0000-4000-8508-0000000000a6','Guest','guest',true),
  ('00000000-0000-4000-8508-0000000000f1','00000000-0000-4000-8508-0000000000a7','Second parent','parent',true);
-- The fixture's rows and files, as the server writes them. Re-laid before each
-- role, so a write that lands on the released schema does not change what the
-- next role, or a control, is measured against.
create or replace function pg_temp.t0508_reset() returns void
language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
  delete from public.tax_documents where family_id in ('00000000-0000-4000-8508-0000000000f1', '00000000-0000-4000-8508-0000000000f9');
  delete from storage.objects where bucket_id = 'documents'
     and (name like '00000000-0000-4000-8508-0000000000f1/%' or name like '00000000-0000-4000-8508-0000000000F1/%');
  insert into public.tax_documents (id, family_id, tax_year, category, name, storage_path, created_by) values
    ('00000000-0000-4000-8508-0000000000d1','00000000-0000-4000-8508-0000000000f1', 2025, 'w2',   'W-2 2025',
     '00000000-0000-4000-8508-0000000000f1/tax/2025/1700000000001-w2.pdf', '00000000-0000-4000-8508-0000000000a1'),
    ('00000000-0000-4000-8508-0000000000d2','00000000-0000-4000-8508-0000000000f1', 2025, '1099', '1099 2025',
     '00000000-0000-4000-8508-0000000000f1/misc/1700000000002-1099.pdf', '00000000-0000-4000-8508-0000000000a1');
  -- A document about the child (0481 let a teen or child read their own).
  insert into public.tax_documents (id, family_id, member_id, tax_year, category, name, created_by)
    select '00000000-0000-4000-8508-0000000000d3', m.family_id, m.id, 2025, 'other', 'Child''s savings interest',
           '00000000-0000-4000-8508-0000000000a1'
      from public.family_members m
     where m.family_id = '00000000-0000-4000-8508-0000000000f1' and m.user_id = '00000000-0000-4000-8508-0000000000a4';
  insert into storage.objects (bucket_id, name, owner) values
    ('documents','00000000-0000-4000-8508-0000000000f1/tax/2025/1700000000001-w2.pdf','00000000-0000-4000-8508-0000000000a1'),
    ('documents','00000000-0000-4000-8508-0000000000f1/misc/1700000000002-1099.pdf','00000000-0000-4000-8508-0000000000a1'),
    ('documents','00000000-0000-4000-8508-0000000000f1/tax/2024/1700000000003-inflight.pdf','00000000-0000-4000-8508-0000000000a1'),
    ('documents','00000000-0000-4000-8508-0000000000f1/receipts/1700000000004-receipt.pdf','00000000-0000-4000-8508-0000000000a1');
end
$fn$;
do $seed$ begin perform pg_temp.t0508_reset(); end $seed$;

-- One statement as one caller, and exactly what happened.
create or replace function pg_temp.t0508_as(p_role text, p_uid text, p_sql text, p_aal text default 'aal1') returns text
language plpgsql as $fn$
declare n bigint; got text;
begin
  perform set_config('role', p_role, true);
  perform set_config('request.jwt.claim.sub', coalesce(p_uid, ''), true);
  perform set_config('request.jwt.claims',
    case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', p_role, 'aal', p_aal)::text end, true);
  begin
    execute p_sql;
    get diagnostics n = row_count;
    got := 'OK ' || n;
  exception when others then
    got := sqlstate || ': ' || sqlerrm;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);
  return got;
end
$fn$;

-- How many rows a read returns, as that caller (the read's own row count).
create or replace function pg_temp.t0508_rows(p_role text, p_uid text, p_from text, p_aal text default 'aal1') returns text
language sql as $fn$
  select pg_temp.t0508_as(p_role, p_uid, 'select 1 from ' || p_from, p_aal)
$fn$;

do $$
declare
  fam       constant text := '00000000-0000-4000-8508-0000000000f1';
  w2_row    constant text := '00000000-0000-4000-8508-0000000000d1';
  w2        constant text := '00000000-0000-4000-8508-0000000000f1/tax/2025/1700000000001-w2.pdf';
  f1099     constant text := '00000000-0000-4000-8508-0000000000f1/misc/1700000000002-1099.pdf';
  inflight  constant text := '00000000-0000-4000-8508-0000000000f1/tax/2024/1700000000003-inflight.pdf';
  receipt   constant text := '00000000-0000-4000-8508-0000000000f1/receipts/1700000000004-receipt.pdf';
  child     constant text := '00000000-0000-4000-8508-0000000000a4';
  rows_q    text := 'public.tax_documents where family_id = ''00000000-0000-4000-8508-0000000000f1''';
  files_q   text;
  rls_rows  constant text := '42501: new row violates row-level security policy for table "tax_documents"';
  -- A restrictive policy's WITH CHECK names itself in the refusal.
  rls_files constant text := '42501: new row violates row-level security policy "Tax files are a manager''s" for table "objects"';
  installed boolean := exists (select 1 from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'
                                 and p.policyname = 'Tax files are a manager''s');
  failures  text[] := '{}';
  w         record;
  got       text;
  n         int;
begin
  files_q := format('storage.objects where bucket_id = ''documents'' and name in (%L, %L, %L)', w2, f1099, inflight);

  -- 1-2. The non-managers.
  for w in select * from (values ('the teen', '00000000-0000-4000-8508-0000000000a3', 't'),
                                 ('the child', '00000000-0000-4000-8508-0000000000a4', 'c'),
                                 ('the caregiver', '00000000-0000-4000-8508-0000000000a5', 'g'),
                                 ('the guest', '00000000-0000-4000-8508-0000000000a6', 'u')) as v(who, uid, tag) loop
    got := pg_temp.t0508_rows('authenticated', w.uid, rows_q);
    if got is distinct from 'OK 0' then
      failures := array_append(failures, format('%s reads the household''s tax documents (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_rows('authenticated', w.uid, files_q);
    if got is distinct from 'OK 0' then
      failures := array_append(failures, format('%s reads the household''s tax files (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format('update public.tax_documents set name = %L where id = %L', 'renamed by ' || w.tag, w2_row));
    if got is distinct from 'OK 0' then
      failures := array_append(failures, format('%s renamed the W-2 (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format('delete from public.tax_documents where id = %L', w2_row));
    if got is distinct from 'OK 0' then
      failures := array_append(failures, format('%s deleted the W-2 (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format(
      'insert into public.tax_documents (family_id, tax_year, category, name) values (%L, 2024, %L, %L)', fam, 'other', 'filed by ' || w.tag));
    if got is distinct from rls_rows then
      failures := array_append(failures, format('%s filed a tax document (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format(
      'update storage.objects set name = %L where bucket_id = ''documents'' and name = %L', w2 || '.moved', w2));
    if got is distinct from 'OK 0' then
      failures := array_append(failures, format('%s moved the W-2''s file (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format(
      'update storage.objects set metadata = ''{"replaced":true}'' where bucket_id = ''documents'' and name = %L', w2));
    if got is distinct from 'OK 0' then
      failures := array_append(failures, format('%s replaced the W-2''s file (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format(
      'delete from storage.objects where bucket_id = ''documents'' and name = %L', w2));
    if got is distinct from 'OK 0' then
      failures := array_append(failures, format('%s deleted the W-2''s file (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format(
      'insert into storage.objects (bucket_id, name, owner) values (''documents'', %L, %L)',
      upper(fam) || '/tax/2026/1700000000009-' || w.tag || '.pdf', w.uid));
    if got is distinct from rls_files then
      failures := array_append(failures, format('%s uploaded a file under tax/ (%s)', w.who, got));
    end if;
    -- 2. What they keep.
    got := pg_temp.t0508_rows('authenticated', w.uid, format('storage.objects where bucket_id = ''documents'' and name = %L', receipt));
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s no longer reads the household''s receipt (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format(
      'insert into storage.objects (bucket_id, name, owner) values (''documents'', %L, %L)',
      fam || '/receipts/1700000000010-' || w.tag || '.pdf', w.uid));
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s can no longer upload a file outside tax/ (%s)', w.who, got));
    end if;
    -- What is left after this role, counted, then the fixture laid again.
    select count(*) into n from public.tax_documents
     where family_id = fam::uuid and ((id = w2_row::uuid and name = 'W-2 2025') or name in ('1099 2025', 'Child''s savings interest'));
    if n <> 3 then
      failures := array_append(failures, format('after %s the three tax rows are not there unchanged (%s of 3)', w.who, n));
    end if;
    select count(*) into n from public.tax_documents where family_id = fam::uuid;
    if n <> 3 then
      failures := array_append(failures, format('after %s Tax House holds %s tax rows, not 3', w.who, n));
    end if;
    select count(*) into n from storage.objects
     where bucket_id = 'documents' and name in (w2, f1099, inflight) and metadata is distinct from '{"replaced":true}'::jsonb;
    if n <> 3 then
      failures := array_append(failures, format('after %s the three tax files are not there unchanged (%s of 3)', w.who, n));
    end if;
    select count(*) into n from storage.objects
     where bucket_id = 'documents' and lower(name) like fam || '/tax/%' and name not in (w2, inflight);
    if n <> 0 then
      failures := array_append(failures, format('after %s %s new file(s) sit under tax/', w.who, n));
    end if;
    perform pg_temp.t0508_reset();
  end loop;

  -- 3. The managers.
  for w in select * from (values ('the parent', '00000000-0000-4000-8508-0000000000a1'),
                                 ('the adult', '00000000-0000-4000-8508-0000000000a2')) as v(who, uid) loop
    got := pg_temp.t0508_rows('authenticated', w.uid, rows_q);
    if got is distinct from 'OK 3' then
      failures := array_append(failures, format('CONTROL: %s does not read all three tax rows (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_rows('authenticated', w.uid, files_q);
    if got is distinct from 'OK 3' then
      failures := array_append(failures, format('CONTROL: %s does not read all three tax files (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format('update public.tax_documents set note = %L where id = %L', 'checked', w2_row));
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s cannot annotate the W-2 (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format(
      'insert into public.tax_documents (family_id, tax_year, category, name) values (%L, 2024, %L, %L)', fam, 'other', 'filed by ' || w.who));
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s cannot file a tax document (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format(
      'insert into storage.objects (bucket_id, name, owner) values (''documents'', %L, %L)',
      fam || '/tax/2026/1700000000011-' || left(md5(w.uid), 6) || '.pdf', w.uid));
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s cannot upload under tax/ (%s)', w.who, got));
    end if;
    got := pg_temp.t0508_as('authenticated', w.uid, format(
      'delete from storage.objects where bucket_id = ''documents'' and name = %L', inflight));
    if got is distinct from 'OK 1' then
      failures := array_append(failures, format('CONTROL: %s cannot remove the in-flight tax file (%s)', w.who, got));
    end if;
    perform pg_temp.t0508_reset();
  end loop;

  -- 4. 0391 still binds a manager.
  got := pg_temp.t0508_rows('authenticated', '00000000-0000-4000-8508-0000000000a7', rows_q, 'aal1');
  if got is distinct from 'OK 0' then
    failures := array_append(failures, format('CONTROL: the enrolled parent at aal1 reads the tax rows (%s): 0391''s step-up no longer binds', got));
  end if;
  got := pg_temp.t0508_rows('authenticated', '00000000-0000-4000-8508-0000000000a7', rows_q, 'aal2');
  if got is distinct from 'OK 3' then
    failures := array_append(failures, format('CONTROL: the enrolled parent at aal2 does not read all three tax rows (%s)', got));
  end if;
  -- And the files answer to the same step-up: at aal1 the enrolled parent
  -- reads, moves and deletes none of the existing files (the W-2 under tax/,
  -- the 1099 a row names outside it) and uploads at no new path under tax/;
  -- at aal2 they do all of it.
  got := pg_temp.t0508_rows('authenticated', '00000000-0000-4000-8508-0000000000a7', files_q, 'aal1');
  if got is distinct from 'OK 0' then
    failures := array_append(failures, format('the enrolled parent at aal1 reads the tax files (%s), which 0391 refuses them as rows', got));
  end if;
  got := pg_temp.t0508_as('authenticated', '00000000-0000-4000-8508-0000000000a7', format(
    'update storage.objects set name = %L where bucket_id = ''documents'' and name = %L', f1099 || '.moved', f1099), 'aal1');
  if got is distinct from 'OK 0' then
    failures := array_append(failures, format('the enrolled parent at aal1 moved the 1099''s file (%s)', got));
  end if;
  got := pg_temp.t0508_as('authenticated', '00000000-0000-4000-8508-0000000000a7', format(
    'delete from storage.objects where bucket_id = ''documents'' and name = %L', w2), 'aal1');
  if got is distinct from 'OK 0' then
    failures := array_append(failures, format('the enrolled parent at aal1 deleted the W-2''s file (%s)', got));
  end if;
  got := pg_temp.t0508_as('authenticated', '00000000-0000-4000-8508-0000000000a7', format(
    'insert into storage.objects (bucket_id, name, owner) values (''documents'', %L, %L)',
    fam || '/tax/2026/1700000000012-enrolled.pdf', '00000000-0000-4000-8508-0000000000a7'), 'aal1');
  if got is distinct from rls_files then
    failures := array_append(failures, format('the enrolled parent at aal1 uploaded under tax/ (%s)', got));
  end if;
  perform pg_temp.t0508_reset();
  got := pg_temp.t0508_rows('authenticated', '00000000-0000-4000-8508-0000000000a7', files_q, 'aal2');
  if got is distinct from 'OK 3' then
    failures := array_append(failures, format('CONTROL: the enrolled parent at aal2 does not read all three tax files (%s)', got));
  end if;
  got := pg_temp.t0508_as('authenticated', '00000000-0000-4000-8508-0000000000a7', format(
    'insert into storage.objects (bucket_id, name, owner) values (''documents'', %L, %L)',
    fam || '/tax/2026/1700000000013-enrolled.pdf', '00000000-0000-4000-8508-0000000000a7'), 'aal2');
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the enrolled parent at aal2 cannot upload under tax/ (%s)', got));
  end if;
  got := pg_temp.t0508_as('authenticated', '00000000-0000-4000-8508-0000000000a7', format(
    'delete from storage.objects where bucket_id = ''documents'' and name = %L', w2), 'aal2');
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: the enrolled parent at aal2 cannot remove the W-2''s file (%s)', got));
  end if;
  perform pg_temp.t0508_reset();

  -- 5. A stranger, and a row planted in another family.
  got := pg_temp.t0508_rows('authenticated', '00000000-0000-4000-8508-0000000000a9', rows_q);
  if got is distinct from 'OK 0' then
    failures := array_append(failures, format('a stranger reads Tax House''s tax rows (%s)', got));
  end if;
  got := pg_temp.t0508_rows('authenticated', '00000000-0000-4000-8508-0000000000a9', files_q);
  if got is distinct from 'OK 0' then
    failures := array_append(failures, format('a stranger reads Tax House''s tax files (%s)', got));
  end if;
  insert into public.tax_documents (family_id, tax_year, category, name, storage_path) values
    ('00000000-0000-4000-8508-0000000000f9', 2025, 'other', 'Planted', receipt);
  got := pg_temp.t0508_rows('authenticated', child, format('storage.objects where bucket_id = ''documents'' and name = %L', receipt));
  if got is distinct from 'OK 1' then
    failures := array_append(failures, format('CONTROL: a tax row Next Door planted withholds Tax House''s receipt from its own child (%s)', got));
  end if;
  delete from public.tax_documents where family_id = '00000000-0000-4000-8508-0000000000f9';

  -- 6. The server. The service role reads the rows; the files are read by
  --    storage-api's own role, which this harness stands in for with the
  --    table owner and no session (the harness grants service_role nothing on
  --    storage.objects).
  for w in select * from (values ('the service role (with the child''s user id)', child),
                                 ('the service role (no user id)', null)) as v(who, uid) loop
    got := pg_temp.t0508_rows('service_role', w.uid, rows_q);
    if got is distinct from 'OK 3' then
      failures := array_append(failures, format('CONTROL: %s does not read all three tax rows (%s)', w.who, got));
    end if;
  end loop;
  got := pg_temp.t0508_rows('postgres', null, files_q);
  if got is distinct from 'OK 3' then
    failures := array_append(failures, format('CONTROL: the table owner with no session (standing in for storage-api; no download or signed URL is exercised) does not read all three tax files (%s)', got));
  end if;

  -- 7. Wiring.
  select count(*) into n from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'tax_documents' and p.permissive = 'PERMISSIVE';
  if n <> 4 or exists (select 1 from pg_policies p
                        where p.schemaname = 'public' and p.tablename = 'tax_documents' and p.permissive = 'PERMISSIVE'
                          and (coalesce(p.qual, 'can_manage_family(family_id)') <> 'can_manage_family(family_id)'
                               or coalesce(p.with_check, 'can_manage_family(family_id)') <> 'can_manage_family(family_id)'
                               or p.roles <> '{authenticated}'::name[])) then
    failures := array_append(failures, format('tax_documents is not read and written by managers alone (%s permissive policies: %s)', n,
      (select string_agg(p.policyname || ' ' || p.cmd || ' USING ' || coalesce(p.qual, '-'), '; ') from pg_policies p
        where p.schemaname = 'public' and p.tablename = 'tax_documents' and p.permissive = 'PERMISSIVE')));
  end if;
  select count(*) into n from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'tax_documents' and p.permissive = 'RESTRICTIVE'
     and p.policyname like 'tax_documents_step_up_%' and p.qual is not distinct from p.qual;
  if n <> 4 then
    failures := array_append(failures, format('CONTROL: 0391''s step-up guards on tax_documents number %s, not 4', n));
  end if;
  if not exists (select 1 from pg_policies p
                  where p.schemaname = 'storage' and p.tablename = 'objects'
                    and p.policyname = 'Tax files are a manager''s'
                    and p.permissive = 'RESTRICTIVE' and p.cmd = 'ALL' and p.roles = '{authenticated}'::name[]
                    and p.qual = '((bucket_id <> ''documents''::text) OR (NOT tax_file_is_withheld(name)))'
                    and p.with_check = p.qual) then
    failures := array_append(failures, 'storage.objects carries no restrictive policy withholding tax files');
  elsif not exists (select 1 from pg_proc f
                     where f.oid = to_regprocedure('public.tax_file_is_withheld(text)')
                       and f.prosecdef
                       and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    failures := array_append(failures, 'tax_file_is_withheld is not SECURITY DEFINER with a pinned search_path');
  elsif has_function_privilege('public', 'public.tax_file_is_withheld(text)', 'execute')
     or has_function_privilege('anon', 'public.tax_file_is_withheld(text)', 'execute') then
    failures := array_append(failures, 'PUBLIC or anon may execute tax_file_is_withheld');
  end if;

  if installed then
    -- N1. The released rule put back: 0481's read and an open bucket.
    begin
      drop policy "Tax files are a manager's" on storage.objects;
      create policy n1_0481_select on public.tax_documents for select to authenticated using (
        public.can_manage_family(family_id)
        or (member_id is not null and public.is_self_member(member_id) and public.family_role(family_id) in ('teen', 'child')));
      got := pg_temp.t0508_rows('authenticated', child, rows_q) || ' / ' || pg_temp.t0508_rows('authenticated', child, files_q)
             || ' / ' || pg_temp.t0508_rows('authenticated', '00000000-0000-4000-8508-0000000000a7', files_q, 'aal1');
      if got is distinct from 'OK 1 / OK 3 / OK 3' then
        failures := array_append(failures, format('NEGATIVE CONTROL: with the released rule put back the child did not read their own row and all three files, and the enrolled parent at aal1 all three files (%s), so this fixture cannot see the limit', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;

    -- M1. Each of the helper's two branches taken away in turn.
    for w in select * from (values
        ('row',    f1099,    'lower(coalesce(s.second, '''')) = ''tax'''),
        ('folder', inflight, 'exists (select 1 from public.tax_documents t where t.family_id = s.fam and t.storage_path = p_object_name)')
      ) as v(branch, path, keep) loop
      begin
        execute format($m$
          create or replace function public.tax_file_is_withheld(p_object_name text)
          returns boolean language sql stable security definer set search_path = public, pg_temp as $f$
            select coalesce((
              select not public.can_manage_family(s.fam) and (%s)
                from (select case when f.folder ~* '^(\{[0-9a-f]{4}(-?[0-9a-f]{4}){7}\}|[0-9a-f]{4}(-?[0-9a-f]{4}){7})$'
                                  then f.folder::uuid end as fam, f.second
                        from (select (storage.foldername(p_object_name))[1] as folder,
                                     (storage.foldername(p_object_name))[2] as second) f) s
               where s.fam is not null), false);
          $f$
        $m$, w.keep);
        got := pg_temp.t0508_rows('authenticated', child, format('storage.objects where bucket_id = ''documents'' and name = %L', w.path));
        if got is distinct from 'OK 1' then
          failures := array_append(failures, format('MUTATION CONTROL: without the helper''s %s branch the child still did not read %s (%s), so 1. cannot catch that rule', w.branch, w.path, got));
        end if;
        raise exception using errcode = 'P0R01';
      exception when sqlstate 'P0R01' then null;
      end;
    end loop;
  end if;

  if installed then
    -- M2. The helper without its step-up term.
    begin
      create or replace function public.tax_file_is_withheld(p_object_name text)
      returns boolean language sql stable security definer set search_path = public, pg_temp as $m2$
        select coalesce((
          select not public.can_manage_family(s.fam)
                 and (lower(coalesce(s.second, '')) = 'tax'
                      or exists (select 1 from public.tax_documents t where t.family_id = s.fam and t.storage_path = p_object_name))
            from (select case when f.folder ~* '^(\{[0-9a-f]{4}(-?[0-9a-f]{4}){7}\}|[0-9a-f]{4}(-?[0-9a-f]{4}){7})$'
                              then f.folder::uuid end as fam, f.second
                    from (select (storage.foldername(p_object_name))[1] as folder,
                                 (storage.foldername(p_object_name))[2] as second) f) s
           where s.fam is not null), false);
      $m2$;
      got := pg_temp.t0508_rows('authenticated', '00000000-0000-4000-8508-0000000000a7', files_q, 'aal1');
      if got is distinct from 'OK 3' then
        failures := array_append(failures, format('MUTATION CONTROL: without the step-up term the enrolled parent at aal1 still did not read the tax files (%s), so 4. cannot catch that rule', got));
      end if;
      raise exception using errcode = 'P0R01';
    exception when sqlstate 'P0R01' then null;
    end;
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'the household''s tax documents are not a manager''s:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'tax-documents-are-a-managers: OK (the teen, the child, the caregiver and the guest each read 0 tax rows (the child''s own included) and 0 of the three tax files; their rename and delete of the W-2 changed 0 rows and their new tax row was refused with 42501; their move, replace and delete of its file changed 0 rows and their upload under tax/ (upper-cased family id) was refused with 42501 by the tax-file policy; the three rows and files are unchanged; each still reads the receipt and uploads outside tax/; the parent and the adult read the three rows and files, annotate, file, upload under tax/ and remove the in-flight file; the enrolled parent at aal1 reads 0 rows and 0 files, moves and deletes none and is refused an upload under tax/, and at aal2 reads, uploads and removes; a stranger reads nothing, and a tax row planted in Next Door does not withhold Tax House''s receipt from its child; the service role reads the rows and the table owner (no session, no signed URL exercised) the files; four manager-only policies, 0391''s four guards and the restrictive tax-file policy with its exact predicate; negative control: with 0481''s read back and the bucket open the child read their own row and all three files, and the enrolled parent at aal1 the files; mutation controls: without the row branch the child read the 1099''s file, without the folder branch the in-flight file, without the step-up term the enrolled parent at aal1 the files)';
end $$;

rollback;

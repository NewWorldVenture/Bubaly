-- The sensitive-document rule has to match what people actually type.
--
-- `documents.category` is a FREE-TEXT folder name
-- (components/modules/documents-module.tsx), and that upload path never sets
-- `is_secure`. So for anything filed through Documents the category IS the
-- boundary — `documents_select` (0266) and `document_object_is_restricted`
-- (0303, the storage-bytes guard) both decide through
-- `is_sensitive_document`.
--
-- 0266 tested exact membership of a seventeen-word list, so a plural or a
-- second word turned the guard off. This probe measures the rule on the folder
-- names a parent actually types, and then measures the CONSEQUENCE: whether a
-- child can read the row.
--
-- The negative cases matter as much as the positive ones. Matching per word
-- rather than by substring is what keeps "Kids Art", "Videos" and "Ideas"
-- ordinary — a substring match on the bare 'id' would have hidden all three
-- from the family that filed them.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000dc01';
  parent_uid uuid := '00000000-0000-4000-8000-00000000dca1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000dca2';
  sensitive_names text[] := array[
    'Medical Records', 'Tax Returns', 'Bank Statements', 'Passports & IDs',
    'Birth Certificates', 'Social Security', 'Immigration', 'Mortgage',
    'Prescriptions', 'Wills & Estate', 'Health Insurance'
  ];
  ordinary_names text[] := array[
    'general', 'Kids Art', 'Videos', 'Ideas', 'School Projects', 'Recipes', 'Birthday Party'
  ];
  nm text;
  n int;
  failures int := 0;
begin
  delete from public.documents where family_id = fam;

  insert into auth.users (id, email) values
    (parent_uid, 'doccat-parent@example.com'), (child_uid, 'doccat-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Document Folders', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;

  -- A parent files one document under each folder name, the way the Documents
  -- module does: category typed by hand, `is_secure` never set.
  foreach nm in array sensitive_names || ordinary_names loop
    insert into public.documents (family_id, title, category, storage_path, created_by)
      values (fam, nm || ' file', nm, fam::text || '/' || replace(lower(nm), ' ', '-'), parent_uid);
  end loop;

  -- 1. The classifier itself, on the names a parent types.
  foreach nm in array sensitive_names loop
    if not public.is_sensitive_document(false, nm) then
      raise warning 'BREACH: a document filed under % is not treated as sensitive', nm;
      failures := failures + 1;
    end if;
  end loop;

  -- 2. And it must NOT sweep up the ordinary folders — the control that a
  --    substring match would fail.
  foreach nm in array ordinary_names loop
    if public.is_sensitive_document(false, nm) then
      raise warning 'CONTROL FAILED: an ordinary folder % became adults-only', nm;
      failures := failures + 1;
    end if;
  end loop;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- 3. The consequence: the child must not see any of the sensitive folders.
  select count(*) into n from public.documents
   where family_id = fam and category = any(sensitive_names);
  if n > 0 then
    raise warning 'BREACH: a child can read % document(s) filed under sensitive folder names', n;
    failures := failures + 1;
  end if;

  -- 4. And must still see the ordinary ones — the positive control. A guard
  --    that hid everything would pass assertion 3 just as happily.
  select count(*) into n from public.documents
   where family_id = fam and category = any(ordinary_names);
  if n <> array_length(ordinary_names, 1) then
    raise warning 'CONTROL FAILED: a child sees % of % ordinary documents', n, array_length(ordinary_names, 1);
    failures := failures + 1;
  end if;

  reset role;

  -- 5. A manager still sees everything, or the boundary has eaten the vault.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  select count(*) into n from public.documents where family_id = fam;
  if n <> array_length(sensitive_names, 1) + array_length(ordinary_names, 1) then
    raise warning 'CONTROL FAILED: a manager sees only % of the family''s documents', n;
    failures := failures + 1;
  end if;
  reset role;

  if failures > 0 then
    raise exception 'document-category-classifier: % assertion(s) failed', failures;
  end if;
  raise notice 'document-category-classifier: OK — the rule reads folder names the way people write them';
end
$probe$;

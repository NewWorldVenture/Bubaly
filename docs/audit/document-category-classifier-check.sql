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
--
-- NEGATIVE CONTROL, and it runs FIRST, before the refusal it gives meaning to
-- ---------------------------------------------------------------------------
-- THE MECHANISM. The rule under test is 0266's POLICY over 0312's classifier.
-- `documents_select` was first created by 0004, inside its fam_tables loop and
-- through format('%1$s_select'), so the literal name is not in that file and
-- `grep -l documents_select` never finds it; that shape was the bare
-- `is_family_member(family_id)`, and 01090 re-asserted it by name. Then
-- 0266_document_vault_boundary.sql dropped it and re-created it as
--
--     is_family_member(family_id)
--     and (not is_sensitive_document(is_secure, category)
--          or can_manage_family(family_id))
--
-- and 0266 is the LAST migration to create it — nothing after it drops or
-- creates any policy on public.documents. The census, redone rather than
-- recounted (an earlier version of this header said "four files" while a
-- fifth sat in the tree): `grep -l documents_select supabase/migrations` hits
-- 01090, 0266, 0303, 0312 and 0365; `grep -l is_sensitive_document` hits 0266,
-- 0303, 0312 and 0365. 0303 names the policy in prose and replaces the three
-- storage.objects policies; 0312 replaces only the FUNCTION body; 0365 names
-- both to explain why its vacation_documents guard is SECURITY INVOKER, and
-- the policies it creates are on social_settings. Assertion 6 below reads the
-- policy back out of pg_policies, so this paragraph going stale is a red build
-- and not a wrong attribution.
--
-- For a SELECT, then, this is RLS and nothing else — and NOT because the table
-- carries no triggers. public.documents carries row triggers, every one of
-- them installed through an `execute format(...)` loop, which is why
-- `grep "trigger .* on public\.documents"` finds none of them:
-- `trg_set_updated_at` (BEFORE UPDATE; 0003's loop over every table with an
-- updated_at column), `trg_mark_model_dirty` (AFTER INSERT OR UPDATE OR
-- DELETE; 0134's table array names 'documents', made delete-safe by 0249) and,
-- on a database bootstrapped after 0365, `trg_documents_linked_trip_stays_home`
-- (BEFORE UPDATE OF family_id). No trigger fires on SELECT, so none of them
-- can be what assertion 3 measures. The seed's WRITES — the document inserts
-- and the family_members upsert — do go through them, as the bootstrap role,
-- and a trigger that raised there would abort the seed under its own error
-- rather than pass for a refusal. There is no CHECK constraint on category
-- (the only constraints are the primary key and four foreign keys), no rule,
-- and no REVOKE on this table anywhere in the migrations: `authenticated`
-- holds table-level SELECT from the default privileges a hosted project grants
-- at creation, which docs/audit/pg-bootstrap.sh reproduces before the first
-- migration runs.
--
-- WHY A CONTROL. Assertion 3 is a ZERO-ROW assertion, and zero rows is the
-- cheapest result in Postgres to get for the wrong reason: a row this session
-- cannot see AT ALL counts zero exactly as readily as a row the sensitive
-- branch hides. So before the refusal, the same child runs the same statement
-- through the same policy with the answer the other way — once per disjunct,
-- and both must LAND:
--
--   leg 1, the `can_manage_family` disjunct: the SAME child reads a document
--     filed under the SAME sensitive category in a SECOND family where that
--     child IS a manager. It is the only statement in this file where
--     auth.uid() is the child, the classifier calls the row sensitive, AND the
--     read must succeed. Assertion 5 asks a PARENT to read the vault, so a
--     manager gate no child account can pass — a `can_manage_family` that came
--     to consult something a child's account lacks — leaves 3, 4 and 5 green
--     and only leg 1 empty.
--
--   leg 2, the `is_sensitive_document` disjunct: the same child, in the family
--     under test, reads the near-miss row: 'Kids Art', whose first word
--     CONTAINS the vocabulary word 'id' (k-ID-s), so a substring matcher would
--     hide it, while 0312's word matcher only ever reaches 'kids' and, with
--     the trailing s stripped, 'kid' — neither on the list. Leg 1 is another
--     household; only leg 2 shows this child can see anything at all in THIS
--     one, which is what assertion 3 measures.
--
-- What the legs do NOT add, said plainly: a dropped `documents_select`, a
-- RESTRICTIVE policy ANDed in, a seed that never landed and a session that is
-- not the child were all red before this control existed — the identity
-- checks just above it raise on the last, and assertion 4 (the child must see
-- all 7 ordinary rows) on the rest. What the control changes is WHEN and AS
-- WHAT they are reported: before the zero is counted, and as "UNPROVEN: this
-- session cannot read the table" in the ERROR line — the only line
-- run-probes.sh keeps from a failed probe (`grep -iE "ERROR|FATAL"`), so a
-- reason left in a WARNING never reaches whoever reads the runner.
--
-- Both legs name `title` and `storage_path` in the select list, and that is not
-- decoration. Assertion 3 counts rows filtered on family_id and category, and
-- that needs SELECT on those two columns only. The way that goes wrong is NOT
-- a bare `revoke select (storage_path) on public.documents from authenticated`:
-- `authenticated` holds TABLE-level SELECT (above), a table-level privilege
-- implies every column, and a column-level REVOKE cannot cut below it —
-- measured on a clone of the bootstrapped database, the child still reads
-- title and storage_path after that statement. The form that DOES withhold
-- columns is the one this repository already uses on assistant_links
-- (0283:88-94): `revoke select on <table>` and then `grant select (<column
-- list>)`. Under that form minus title and storage_path, assertion 3's count(*)
-- stays green while the harm 0266 names — "storage_path, which is all a signed
-- URL needs" — quietly stops being measured; both legs raise 42501 on it
-- (measured: `permission denied for table documents`). Naming the columns is
-- what makes the probe say so instead.
--
-- Assertions 4 and 5 are not this control. 4 asks leg 2's question by count(*)
-- AFTER the refusal it would have explained, and 5 is a DIFFERENT actor: a
-- parent reading the vault proves the guard lets SOMEBODY through, not that the
-- CHILD's session could have read anything at all.
--
-- A failed control does not abort the file. It is recorded like every other
-- failure, assertions 3–6 still run — so a manager-side breakage is measured
-- even when the child's session is blind — and the final RAISE is then the
-- control's: UNPROVEN, carrying every leg's reason, because that is the line
-- the runner shows. If 3–5 cannot even run while the control has failed, that
-- is one more reason on the same line, not the engine's generic error in its
-- place; while the control HOLDS, an error in them is fatal exactly as before.
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
  pols text;
  failures int := 0;
  -- ── the negative control's own household ────────────────────────────────
  -- A SECOND family the same child MANAGES, so `can_manage_family` answers yes
  -- for the very user it answers no for in `fam`. Fresh anchors: dc02 and dcd1
  -- appear nowhere else in docs/audit or supabase/migrations, so the rows
  -- seeded here cannot change what another probe in the same run is asserting.
  ctl_fam    uuid := '00000000-0000-4000-8000-00000000dc02';
  ctl_doc    uuid := '00000000-0000-4000-8000-00000000dcd1';
  ctl_cat    text;                      -- the same sensitive folder name assertion 3 measures
  near_miss  text := 'Kids Art';        -- CONTAINS 'id' as a substring (k-id-s); 0312's word matcher reaches only 'kids' -> 'kid'
  ctl_title  text;
  ctl_path   text;
  control_ok boolean := true;
  control_notes text[] := '{}';
begin
  ctl_cat := sensitive_names[1];

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

  -- ── the control household ────────────────────────────────────────────────
  -- The child CREATES this one, so on_family_created (0003's trigger; 0257
  -- holds the last definition of handle_new_family) has ALREADY filed them as
  -- a 'parent' in it by the time the next statement runs — which is why the
  -- upsert carries no id of its own: on a first run and on every rerun the ON
  -- CONFLICT branch is the one that fires. Upsert the role rather than assume
  -- it: `can_manage_family` is `role in ('parent','adult') and is_active`
  -- (0003, the only definition), and a seed whose roles are wrong would fail
  -- the control for a reason that is not the control's. No rows in `fam` are
  -- added or removed here — assertions 4 and 5 count that family exactly, and
  -- a control that moved their totals would be breaking the assertions it
  -- exists to serve.
  insert into public.families (id, name, created_by) values
    (ctl_fam, 'Document Folders (the child''s own house)', child_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (ctl_fam, child_uid, 'Child (a manager here)', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;

  -- The same folder name assertion 3 measures, filed the same way the Documents
  -- module files it: category typed by hand, `is_secure` never set. Re-seeded
  -- from scratch so a rerun against the same database reads one row, not two.
  delete from public.documents where family_id = ctl_fam;
  insert into public.documents (id, family_id, title, category, storage_path, created_by)
    values (ctl_doc, ctl_fam, ctl_cat || ' file', ctl_cat,
            ctl_fam::text || '/' || replace(lower(ctl_cat), ' ', '-'), child_uid);

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

  -- ── NEGATIVE CONTROL: the same child, the same policy, the other answer ───
  -- It runs HERE, before assertion 3, because a refusal that arrives first is
  -- just a zero. The header says what each leg would catch; both must LAND.

  -- The two legs are only the legs they claim to be if the seed still says so.
  -- Recorded rather than raised: the verdict goes out in the final ERROR line,
  -- the one line the runner keeps, and it must stand on its own there.
  if not public.is_sensitive_document(false, ctl_cat) then
    control_ok := false;
    control_notes := array_append(control_notes, format(
      'CONTROL BROKEN: is_sensitive_document(false, %L) is false, so leg 1 reads an ORDINARY row and cannot exercise the manager disjunct (assertion 1 counts that same answer as a BREACH)',
      ctl_cat));
  end if;
  if not (near_miss = any(ordinary_names)) then
    control_ok := false;
    control_notes := array_append(control_notes, format(
      'CONTROL BROKEN: %L is no longer one of the ordinary folder names this probe files, so leg 2 would not be reading a row the classifier calls ordinary',
      near_miss));
  end if;

  -- leg 1 — the `can_manage_family` disjunct. The same child, the same
  -- sensitive folder name, in the family they DO manage.
  begin
    select count(*), max(d.title), max(d.storage_path)
      into n, ctl_title, ctl_path
      from public.documents d
     where d.id = ctl_doc and d.family_id = ctl_fam and d.category = ctl_cat;
    if n <> 1 or ctl_path is null or ctl_title is null then
      control_ok := false;
      control_notes := array_append(control_notes, format(
        'CONTROL FAILED (leg 1): this child read %s row(s) for the %s document in the family they DO manage, and %s a storage_path — so the zero-row refusal below would prove nothing about the manager gate: a row this session cannot see at all counts zero just as readily',
        n, ctl_cat, case when ctl_path is null then 'never got' else 'got' end));
    end if;
  exception when others then
    control_ok := false;
    control_notes := array_append(control_notes, format(
      'CONTROL FAILED (leg 1): reading the %s document in the family this child DOES manage raised %s: %s — nothing below is attributable to documents_select',
      ctl_cat, sqlstate, sqlerrm));
  end;

  -- leg 2 — the `is_sensitive_document` disjunct, in the family under test. The
  -- near-miss row (a substring matcher's false positive), read by the same
  -- statement shape and the same column names as leg 1.
  begin
    select count(*), max(d.title), max(d.storage_path)
      into n, ctl_title, ctl_path
      from public.documents d
     where d.family_id = fam and d.category = near_miss;
    if n <> 1 or ctl_path is null or ctl_title is null then
      control_ok := false;
      control_notes := array_append(control_notes, format(
        'CONTROL FAILED (leg 2): this child read %s row(s) for the ordinary folder %s in the family under test, and %s a storage_path — so this session cannot see documents in this family at all, and assertion 3''s zero says nothing about the sensitive branch',
        n, near_miss, case when ctl_path is null then 'never got' else 'got' end));
    end if;
  exception when others then
    control_ok := false;
    control_notes := array_append(control_notes, format(
      'CONTROL FAILED (leg 2): reading the ordinary folder %s in the family under test raised %s: %s — a denial on the very columns the vault protects (title, storage_path), which count(*) below would never have noticed',
      near_miss, sqlstate, sqlerrm));
  end;

  -- A failed control makes assertion 3 unreadable. Say so HERE, while the
  -- reason is in hand, count it, and carry on: 3–6 still run so the manager
  -- side is measured too, and the final raise is then the control's, with
  -- every reason attached. The boundary is not reported as holding and it is
  -- not reported as broken: it is reported as UNPROVEN, and the build is red.
  if not control_ok then
    raise warning 'CONTROL FAILED: the sensitive-folder boundary below is UNPROVEN — %', array_to_string(control_notes, ' | ');
    failures := failures + 1;
  end if;

  -- 3. The consequence: the child must not see any of the sensitive folders.
  -- 4. And must still see the ordinary ones — the positive control. A guard
  --    that hid everything would pass assertion 3 just as happily.
  -- One block for both so that, once the control has ALREADY failed, an error
  -- here (a 42501, say) becomes one more reason on the control's line instead
  -- of the engine's message replacing it. While the control holds, an error
  -- here is re-raised and fatal, exactly as before.
  begin
    select count(*) into n from public.documents
     where family_id = fam and category = any(sensitive_names);
    if n > 0 then
      raise warning 'BREACH: a child can read % document(s) filed under sensitive folder names', n;
      failures := failures + 1;
    end if;

    select count(*) into n from public.documents
     where family_id = fam and category = any(ordinary_names);
    if n <> array_length(ordinary_names, 1) then
      raise warning 'CONTROL FAILED: a child sees % of % ordinary documents', n, array_length(ordinary_names, 1);
      failures := failures + 1;
    end if;
  exception when others then
    if control_ok then raise; end if;
    control_notes := array_append(control_notes, format(
      'assertions 3 and 4 then raised %s as the child: %s', sqlstate, sqlerrm));
  end;

  reset role;

  -- 5. A manager still sees everything, or the boundary has eaten the vault.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    select count(*) into n from public.documents where family_id = fam;
    if n <> array_length(sensitive_names, 1) + array_length(ordinary_names, 1) then
      raise warning 'CONTROL FAILED: a manager sees only % of the family''s documents', n;
      failures := failures + 1;
    end if;
  exception when others then
    if control_ok then raise; end if;
    control_notes := array_append(control_notes, format(
      'assertion 5 then raised %s as the parent: %s', sqlstate, sqlerrm));
  end;
  reset role;

  -- 6. The refusal is credited to 0266's documents_select and to nothing else
  --    on this table. Read back from the catalog, as the bootstrap role, so the
  --    census in the header cannot go stale silently: RLS must be on, the
  --    policy must still be the one PERMISSIVE SELECT policy whose predicate
  --    names all three functions, and no other policy may decide a SELECT.
  select count(*) into n from pg_catalog.pg_class c
   where c.oid = 'public.documents'::regclass and c.relrowsecurity;
  if n <> 1 then
    raise warning 'ATTRIBUTION UNPROVEN: row level security is not enabled on public.documents, so no policy decided anything above';
    failures := failures + 1;
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'documents' and policyname = 'documents_select'
     and cmd = 'SELECT' and permissive = 'PERMISSIVE'
     and qual ~ '\mis_family_member\(family_id\)'
     and qual ~ '\mis_sensitive_document\(is_secure, category\)'
     and qual ~ '\mcan_manage_family\(family_id\)';
  if n <> 1 then
    select string_agg(format('%s %s %s to %s using %s', policyname, permissive, cmd, roles, qual), '; ' order by policyname)
      into pols from pg_policies
     where schemaname = 'public' and tablename = 'documents' and cmd in ('SELECT', 'ALL');
    raise warning 'ATTRIBUTION UNPROVEN: documents_select is not 0266''s `is_family_member(family_id) and (not is_sensitive_document(is_secure, category) or can_manage_family(family_id))` — found: % — so assertion 3''s zero is not the policy this probe credits it to', coalesce(pols, 'no SELECT policy on public.documents');
    failures := failures + 1;
  end if;

  select string_agg(format('%s (%s %s)', policyname, permissive, cmd), ', ' order by policyname)
    into pols from pg_policies
   where schemaname = 'public' and tablename = 'documents'
     and (permissive = 'RESTRICTIVE' or cmd = 'ALL' or (cmd = 'SELECT' and policyname <> 'documents_select'));
  if pols is not null then
    raise warning 'ATTRIBUTION UNPROVEN: public.documents carries policies that decide a SELECT and that this header does not inventory: % — a second decider of the same read, so the zero in assertion 3 is no longer documents_select''s alone', pols;
    failures := failures + 1;
  end if;

  -- The control's rows do not outlive the control. This probe is one DO
  -- statement with no surrounding transaction, so on the green path it
  -- COMMITS, and every probe in docs/audit shares one database: a sensitive
  -- document in a second family is exactly the quiet contamination that turns
  -- someone else's count into a false failure later
  -- (document-bytes-boundary-check.sql does the same). The delete at the top
  -- makes a rerun repeatable; this makes the run clean for whoever follows.
  delete from public.documents where family_id = ctl_fam;

  if not control_ok then
    raise exception 'document-category-classifier: the sensitive-folder boundary is UNPROVEN (the control it rests on did not hold): % — and % other assertion(s) failed', array_to_string(control_notes, ' | '), failures - 1;
  end if;
  if failures > 0 then
    raise exception 'document-category-classifier: % assertion(s) failed', failures;
  end if;
  raise notice 'document-category-classifier: OK — the rule reads folder names the way people write them (control: the SAME child DID read a "%" document, title and storage_path, in the family they manage, and the near-miss folder "%" in the family they do not — so assertion 3''s zero is documents_select and not a blind session; attribution: pg_policies holds 0266''s documents_select and no other SELECT decider on public.documents)', ctl_cat, near_miss;
end
$probe$;

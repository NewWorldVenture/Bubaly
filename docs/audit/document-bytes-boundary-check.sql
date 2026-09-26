-- The OTHER half of the document vault: the bytes.
--
-- 0266 hides a sensitive document's ROW from a non-manager, and
-- document-vault-boundary-check.sql proves that half. It then adds three
-- storage.objects policies so "a path learned before today (or guessed) still
-- does not open the file" — and nothing tested those. This does.
--
-- Each of the three guards the same way:
--
--   not exists (select 1 from public.documents d
--               where d.storage_path = storage.objects.name
--                 and public.is_sensitive_document(d.is_secure, d.category)
--                 and not public.can_manage_family(d.family_id))
--
-- The question this file answers is whether that subquery can see the row it
-- is asking about. A policy expression runs as the CALLING user, so the read
-- of public.documents is itself subject to documents_select — the very policy
-- that hides sensitive rows from a child. If it is hidden, the subquery finds
-- nothing, `not exists` is TRUE, and the guard admits exactly the object it
-- exists to refuse.
--
-- Judged on ROW COUNTS, not on whether an error was raised: an UPDATE or
-- DELETE that matches no visible row changes nothing and raises nothing, so an
-- exception-only assertion would pass while the bytes walked out the door.
--
-- NEGATIVE CONTROL, and it runs FIRST, before any of the three
-- ---------------------------------------------------------------------------
-- THE RULE UNDER TEST IS 0303's, NOT 0266's. 0266 created the three
-- storage.objects policies quoted above with the `not exists (…)` subquery
-- inline; `0303_document_bytes_boundary.sql` DROPPED and re-created all three
-- under the same names on a different expression —
--
--   bucket_id = 'documents'
--   and public.is_family_member(((storage.foldername(name))[1])::uuid)
--   and not public.document_object_is_restricted(name)
--
-- — where `document_object_is_restricted` is a SECURITY DEFINER wrapper around
-- exactly that subquery, so the lookup no longer depends on the caller being
-- allowed to see the row it asks about. `grep -l` for each of the three policy
-- names across supabase/migrations gives 0007, 0266, 0303, and 0303 is the last
-- hit; 0312 rewrote `is_sensitive_document` but left the policies alone. The
-- mechanism is therefore RLS on storage.objects and nothing else: 0007's fourth
-- policy is INSERT-only, every other storage policy in the tree is scoped to a
-- different bucket_id, and no migration puts a trigger on storage.objects (the
-- guard triggers in 0223, 0305, 0326 and 0331 are all on chore tables).
--
-- So the boundary is one question — `document_object_is_restricted(name)` — and
-- the control is the same child, the same three verbs, through that same
-- function, on objects with the same `owner`, with the answer the other way: a
-- SECOND family where that child IS a manager, holding a document that IS
-- sensitive. All three must land. ONE variable moves between the two sides —
-- whether can_manage_family says yes — and holding `owner` constant is what
-- keeps it one: nothing in 0303 reads that column, but a leg rewritten as an
-- ownership test (`owner = auth.uid()`, the shape hosted Supabase's own storage
-- policies carry, and the shim does provide the column) must fail this control
-- rather than pass it alongside three green refusals. Without the control the
-- three checks below are zero counts with no attribution:
--
--   * a revoked `update`/`delete` grant on storage.objects, a table-level UPDATE
--     grant swapped for a column-level one that leaves `name` out, a dead
--     `auth.uid()` or a guard trigger added to storage.objects for some
--     unrelated rule would each stop this session writing ANY object — and two
--     of the three checks would keep reporting a clean zero with
--     `document_object_is_restricted` loosened to nothing;
--   * checks 2 and 3 assert ZERO ROWS, and a row this session simply cannot see
--     produces zero rows just as readily as a USING clause does.
--
-- The control's documents are SENSITIVE on purpose, and that is load-bearing
-- rather than decoration. `document_object_is_restricted` short-circuits at
-- `is_sensitive_document`, so a control built on an ORDINARY document never
-- reaches the `can_manage_family` leg and would attribute the refusals to a
-- clause it never exercised. Which is also why the existing plain-object read
-- below does not cover this: it flips sensitivity rather than the manager gate,
-- and it is a SELECT, so it says nothing about whether this session could have
-- UPDATED or DELETED anything at all.
--
-- The control's UPDATE sets `name` — THE SAME COLUMN the rename under test sets.
-- A grant narrowed to columns that leave `name` out (`revoke update on
-- storage.objects from authenticated; grant update (metadata) on storage.objects
-- to authenticated`) sails straight past a control that touches any other
-- column, and then kills the unguarded rename below as a bare `permission
-- denied`: red, but with the attribution thrown away exactly as it was before
-- this control existed. (A bare `revoke update (name)` is NOT that mutation and
-- is not what this guards against: while the table-level UPDATE grant that
-- docs/audit/pg-bootstrap.sh makes still stands, revoking a column privilege
-- changes nothing — has_column_privilege stays true, the rename lands — so the
-- probe rightly stays green under it. Measured, not assumed.)
--
-- And the control is what tests 0303's own central claim — that SECURITY
-- DEFINER changes who may READ the documents row but not who the answer is
-- ABOUT, because `can_manage_family` resolves auth.uid() inside. If that ever
-- stopped holding (a definer function whose auth.uid() resolves to its owner
-- has no family, so `can_manage_family` is false and EVERY sensitive object is
-- restricted for EVERYONE), all three checks below would still read zero and
-- this probe would go green over a vault no manager can open. The control goes
-- red, which is what a wrong attribution deserves. The same-shaped control in
-- document-vault-boundary-check.sql (its ctl_fam is likewise a second family
-- the same minor manages) proves the manager flip through 0266's INLINE
-- documents policies, where the caller reads the row directly; it never
-- touches storage.objects and never goes through the definer wrapper. This is
-- the only place the flip is proven THROUGH `document_object_is_restricted`,
-- and the only place it is proven for UPDATE and DELETE of the bytes.
--
-- The catalog is read at the end, after every refusal: the three policies
-- must still be 0303's (permissive, to authenticated, one per verb, each half
-- spelling `not document_object_is_restricted(name)`), the function must still
-- be SECURITY DEFINER, and nothing else on storage.objects may open the
-- 'documents' bucket. That block is what makes the grep in the MECHANISM
-- paragraph self-verifying, and it runs LAST on purpose: a loosened guard must
-- fail on a refusal assertion, not on a shape check that pre-empts it.
--
-- No `set client_min_messages = warning` here, unlike several siblings: this
-- probe emits no engine chatter to hide (no `drop … if exists`, no `skipping`),
-- and run-probes.sh echoes each probe's own `NOTICE: … OK` line as its
-- evidence. Suppressing NOTICE would swallow the one line that reports the
-- control's result and leave a bare PASS with nothing under it.
\set ON_ERROR_STOP on

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000d0c5';
  manager_uid uuid := '00000000-0000-4000-8000-00000000d0a1';
  child_uid uuid := '00000000-0000-4000-8000-00000000d0a2';
  secure_path text := fam::text || '/passport-scan.pdf';
  plain_path  text := fam::text || '/school-newsletter.pdf';
  -- The control household: a second family the SAME child manages. Verified
  -- absent from docs/audit and supabase/migrations before being used — every
  -- probe in docs/audit shares one database and a reused anchor silently
  -- rewrites someone else's assertion.
  ctl_fam uuid := '00000000-0000-4000-8000-00000000d0c6';
  ctl_read_path    text := ctl_fam::text || '/ctl-passport-scan.pdf';
  ctl_rename_path  text := ctl_fam::text || '/ctl-medical-record.pdf';
  ctl_renamed_path text := ctl_fam::text || '/ctl-medical-record-renamed.pdf';
  control_failures text[] := '{}';
  visible int;
  affected int;
  failures int := 0;
  r record;
begin
  -- Repeatable: the harness stub gives storage.objects no unique key, so a
  -- re-run would stack a second copy of each fixture object and the control
  -- below would read 2 where it expects 1 — a failure that says nothing about
  -- the boundary. Clear this probe's own rows first.
  --
  -- Named if it fails, not swallowed: on a database that already holds this
  -- probe's rows from an earlier run, a trigger or revoke that stops even the
  -- superuser deleting from storage.objects hits THIS statement before the
  -- control gets a chance to, and a bare error at the end of a 400-line DO
  -- block says nothing about which line it was. Nothing below has run yet.
  begin
    delete from storage.objects where bucket_id = 'documents' and name like fam::text || '/%';
    delete from public.documents where family_id = fam;
    -- Same reason, for the control's household. public.documents has no unique
    -- key on storage_path, so a re-run would stack a second sensitive row at the
    -- same path and the control's read would find 2 where it expects 1.
    delete from storage.objects where bucket_id = 'documents' and name like ctl_fam::text || '/%';
    delete from public.documents where family_id = ctl_fam;
  exception when others then
    raise exception 'document-bytes-boundary HOUSEKEEPING FAILED (nothing was measured): clearing this probe''s own rows from a previous run raised %: % — something on storage.objects or public.documents now stops even the owner''s DELETE, so the control below never ran',
      sqlstate, sqlerrm;
  end;

  -- ── household ────────────────────────────────────────────────────────────
  insert into auth.users (id, email) values
    (manager_uid, 'vault-manager@example.com'),
    (child_uid,   'vault-child@example.com')
  on conflict (id) do nothing;

  insert into public.families (id, name, created_by) values (fam, 'Vault Bytes', manager_uid)
  on conflict (id) do nothing;

  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, manager_uid, 'Manager', 'parent', true),
    (fam, child_uid,   'Child',   'child',  true)
  on conflict do nothing;

  -- A sensitive document and an ordinary one, each with its object in storage.
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (fam, 'Passport scan', 'identity', secure_path, true, manager_uid)
  on conflict do nothing;
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (fam, 'School newsletter', 'other', plain_path, false, manager_uid)
  on conflict do nothing;

  insert into storage.buckets (id, name, public) values ('documents', 'documents', false)
  on conflict (id) do nothing;
  insert into storage.objects (bucket_id, name, owner) values
    ('documents', secure_path, manager_uid),
    ('documents', plain_path,  manager_uid)
  on conflict do nothing;

  -- ── the negative control's own household ─────────────────────────────────
  -- ctl_fam is a SECOND family the SAME child created, so can_manage_family
  -- answers YES here for the very user it answers no for in `fam` — one question,
  -- asked the other way. Both of its documents are SENSITIVE, because an ordinary
  -- one short-circuits document_object_is_restricted before the manager leg (see
  -- the header). Two objects, not one, so the rename leg does not have to be
  -- undone before the delete leg can measure the same shape.
  insert into public.families (id, name, created_by)
  values (ctl_fam, 'Vault Bytes (the child''s own house)', child_uid)
  on conflict (id) do nothing;
  -- on_family_created files the creator as a 'parent' already; upsert rather than
  -- assume, because a seed whose role is wrong would fail the control for a
  -- reason that is not the control's. display_name is refreshed too, so the row
  -- the control reads is the row this seed describes and not the trigger's
  -- coalesce of an empty profiles.full_name.
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (ctl_fam, child_uid, 'Child (a manager here)', 'parent', true)
  on conflict (family_id, user_id) do update
    set role = 'parent', is_active = true, display_name = excluded.display_name;

  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (ctl_fam, 'Passport scan (control)',  'identity', ctl_read_path,   true, child_uid);
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (ctl_fam, 'Medical record (control)', 'medical',  ctl_rename_path, true, child_uid);
  -- `owner` is manager_uid on BOTH sides, exactly as on the objects under test
  -- above, so ownership is not a second variable: the child owns none of the
  -- four objects, and the only thing that differs between the household under
  -- test and this one is what can_manage_family answers. (manager_uid is not a
  -- member of ctl_fam and need not be — `owner` is metadata the shim carries
  -- and 0303 never reads; the header says why it is held constant anyway.)
  insert into storage.objects (bucket_id, name, owner) values
    ('documents', ctl_read_path,   manager_uid),
    ('documents', ctl_rename_path, manager_uid);

  -- ── as the child ─────────────────────────────────────────────────────────
  -- The harness resolves auth.uid() from `request.jwt.claim.sub` (singular),
  -- the same setting the other probes use. Set it BEFORE dropping to the
  -- authenticated role, or the child is nobody and every assertion below
  -- passes for the wrong reason.
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- Prove the identity took, because a probe that measures a stranger measures
  -- nothing: every read would be empty and every refusal vacuous.
  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: the probe is not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: the probe is acting as a manager, so nothing below is a child boundary';
  end if;

  -- ── NEGATIVE CONTROL: same child, same predicate, the other answer ───────
  -- It runs here, ahead of every check it gives meaning to. Each leg is wrapped
  -- so that a 42501 from a revoked table or COLUMN grant is named as a control
  -- failure while the sqlstate is still in hand — the three checks below are
  -- deliberately unguarded, and reaching them with a revoked privilege buries the
  -- diagnosis under a bare "permission denied for table objects".
  if not public.is_family_member(ctl_fam) then
    control_failures := array_append(control_failures,
      'CONTROL SEED WRONG: this child is not an active member of the control family, so the control cannot reach the objects it is meant to write');
  elsif not public.can_manage_family(ctl_fam) then
    control_failures := array_append(control_failures,
      'CONTROL SEED WRONG: this child is not a MANAGER of the control family, so the control does not flip can_manage_family and would prove nothing about the vault guard');
  else
    -- 1. READ a SENSITIVE object in the family this child DOES manage.
    begin
      select count(*) into visible from storage.objects
       where bucket_id = 'documents' and name = ctl_read_path;
      if visible <> 1 then
        control_failures := array_append(control_failures, format(
          'CONTROL FAILED: this child cannot READ the storage object of a SENSITIVE document in the family they DO manage (expected 1, got %s) — so a zero below is not the vault guard refusing, and 0303''s claim that the definer lookup still answers about the CALLER does not hold', visible));
      end if;
    exception when others then
      control_failures := array_append(control_failures, format(
        'CONTROL FAILED: this child''s SELECT on a sensitive object they DO manage raised %s: %s', sqlstate, sqlerrm));
    end;

    -- 2. RENAME it — `set name = …`, THE SAME COLUMN the rename under test sets,
    --    which is what makes a grant narrowed to OTHER columns visible here
    --    instead of downstream as an unattributable permission error.
    begin
      update storage.objects set name = ctl_renamed_path
       where bucket_id = 'documents' and name = ctl_rename_path;
      get diagnostics affected = row_count;
      if affected <> 1 then
        control_failures := array_append(control_failures, format(
          'CONTROL FAILED: this child could not RENAME (set name = …) a sensitive object in the family they DO manage (rows: %s) — so the zero the rename below reports would prove only that this session cannot write storage.objects at all', affected));
      end if;
    exception when others then
      control_failures := array_append(control_failures, format(
        'CONTROL FAILED: this child''s UPDATE of storage.objects.name on an object they DO manage raised %s: %s', sqlstate, sqlerrm));
    end;

    -- 3. DELETE it.
    begin
      delete from storage.objects where bucket_id = 'documents' and name = ctl_read_path;
      get diagnostics affected = row_count;
      if affected <> 1 then
        control_failures := array_append(control_failures, format(
          'CONTROL FAILED: this child could not DELETE a sensitive object in the family they DO manage (rows: %s) — so the zero the delete below reports is not a refusal, it is this session unable to delete anything', affected));
      end if;
    exception when others then
      control_failures := array_append(control_failures, format(
        'CONTROL FAILED: this child''s DELETE on an object they DO manage raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  -- A failed control makes every count below unreadable. The boundary is not
  -- reported as holding and not reported as broken: it is reported as unproven,
  -- and the build is red either way.
  if array_length(control_failures, 1) is not null then
    raise exception 'document-bytes-boundary UNPROVEN (the negative control this probe rests on did not hold): %',
      array_to_string(control_failures, ' | ');
  end if;

  -- Control: the row half still works, or the rest of this proves nothing.
  select count(*) into visible from public.documents where storage_path = secure_path;
  if visible <> 0 then
    raise warning 'CONTROL FAILED: the child can see the sensitive document ROW (0266 row half is broken)';
    failures := failures + 1;
  end if;

  -- Control: the child CAN reach an ordinary document's bytes, so a refusal
  -- below is the guard working rather than the whole bucket being shut.
  select count(*) into visible from storage.objects
   where bucket_id = 'documents' and name = plain_path;
  if visible <> 1 then
    raise warning 'CONTROL FAILED: the child cannot read an ORDINARY document object (expected 1, got %)', visible;
    failures := failures + 1;
  end if;

  -- 1. READ the sensitive object.
  select count(*) into visible from storage.objects
   where bucket_id = 'documents' and name = secure_path;
  if visible <> 0 then
    raise warning 'BREACH: a child can read the storage object for a sensitive document (rows visible: %)', visible;
    failures := failures + 1;
  end if;

  -- 2. UPDATE it — renaming an object out from under the vault, which also
  --    detaches it from the documents row that classifies it as sensitive.
  --    Tested BEFORE the delete: a delete that succeeds would leave nothing to
  --    rename, and the rename would then report a clean zero for the wrong
  --    reason.
  update storage.objects set name = fam::text || '/harmless.pdf'
   where bucket_id = 'documents' and name = secure_path;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise warning 'BREACH: a child RENAMED the storage object for a sensitive document (rows: %)', affected;
    failures := failures + 1;
    -- Put it back, so the delete below is measured against the same object.
    reset role;
    update storage.objects set name = secure_path
     where bucket_id = 'documents' and name = fam::text || '/harmless.pdf';
    perform set_config('request.jwt.claim.sub', child_uid::text, true);
    set local role authenticated;
  end if;

  -- 3. DELETE it. Destroying the family's passport scan needs no read at all.
  delete from storage.objects where bucket_id = 'documents' and name = secure_path;
  get diagnostics affected = row_count;
  if affected <> 0 then
    raise warning 'BREACH: a child DELETED the storage object for a sensitive document (rows: %)', affected;
    failures := failures + 1;
  end if;

  reset role;

  -- The control's rows do not outlive the control — ALL of them. This probe is
  -- one DO statement and not wrapped in a transaction, so on the green path it
  -- COMMITS, and every probe in docs/audit shares one database: a stray second
  -- family the child manages, with a sensitive document in it, is exactly the
  -- quiet contamination that turns someone else's count into a false failure
  -- later. So: the objects, the documents, the membership row and the family
  -- itself, in that order (the same order document-vault-boundary-check.sql
  -- uses). Deleting the family cascades to the `subscriptions` row and the
  -- `family_ai_settings` row that on_family_created (0003, replaced whole by
  -- 0257) inserted behind the seed — both FKs are ON DELETE CASCADE (0076,
  -- 0257) — so nothing of ctl_fam's making remains. Removing the child's only
  -- 'parent' row does not trip trg_family_keeps_a_manager: it is a DEFERRED
  -- constraint trigger, and by commit the family row is gone, which is the case
  -- it explicitly waves through. (On every red path above the raise rolls the
  -- whole seed back, so nothing is left behind there either.)
  --
  -- The household under test — fam, its two users, its two documents and two
  -- objects — stays, as it always has; the start-of-run delete makes a re-run
  -- repeatable, and fam keeps its manager.
  delete from storage.objects where bucket_id = 'documents' and name like ctl_fam::text || '/%';
  delete from public.documents where family_id = ctl_fam;
  delete from public.family_members where family_id = ctl_fam;
  delete from public.families where id = ctl_fam;

  if failures > 0 then
    raise exception 'document-bytes-boundary: % assertion(s) failed', failures;
  end if;

  -- ── ATTRIBUTION, asserted out of the catalog ─────────────────────────────
  -- The three refusals above are consistent with 0303's three policies — and
  -- equally consistent with a fourth, RESTRICTIVE policy that happens to agree,
  -- or with a later migration that re-created the same names on a different
  -- predicate and left the header's grep stale. The MECHANISM paragraph credits
  -- 0303 because its author read the migrations; this is what makes that credit
  -- self-verifying. It runs AFTER the refusals and after the failure gate on
  -- purpose: a loosened guard must fail on a refusal assertion, not here.
  --
  -- (i) Each of the three named policies exists exactly once, PERMISSIVE, to
  --     authenticated, on its own verb, with `bucket_id = 'documents'` and
  --     `not document_object_is_restricted(name)` in the half that governs that
  --     verb — USING for select and delete, BOTH halves for update (0303's "BOTH
  --     halves, for the same reason documents_update spells out").
  for r in
    select want.policyname, want.cmd
      from (values
              ('Family members can read their documents',   'SELECT'),
              ('Family members can update their documents', 'UPDATE'),
              ('Family members can delete their documents', 'DELETE')
           ) as want(policyname, cmd)
     where (select count(*) from pg_policies p
             where p.schemaname = 'storage' and p.tablename = 'objects'
               and p.policyname = want.policyname
               and p.permissive = 'PERMISSIVE'
               and p.roles = '{authenticated}'::name[]
               and p.cmd = want.cmd
               and p.qual ~ 'bucket_id = ''documents''::text'
               and p.qual ~ 'is_family_member'
               and p.qual ~ 'NOT document_object_is_restricted\(name\)'
               and (want.cmd <> 'UPDATE'
                    or (p.with_check ~ 'bucket_id = ''documents''::text'
                        and p.with_check ~ 'is_family_member'
                        and p.with_check ~ 'NOT document_object_is_restricted\(name\)'))) <> 1
  loop
    raise exception 'ATTRIBUTION UNPROVEN: storage.objects does not carry exactly one PERMISSIVE % policy named "%" for authenticated whose governing half spells `bucket_id = ''documents'' … not document_object_is_restricted(name)` — the refusals above were not 0303''s rule, and the header''s "the rule under test is 0303''s" is no longer true. Re-read which migration owns this boundary.',
      r.cmd, r.policyname;
  end loop;

  -- (ii) Nothing ELSE on storage.objects opens the 'documents' bucket: exactly
  --      four policies name it — the three above plus 0007's INSERT-only upload
  --      policy, which has no USING half and so cannot read, rename or delete.
  --      A fifth (a RESTRICTIVE one above all, or a permissive SELECT for some
  --      other role) would be a second candidate for the zeros above.
  select count(*) into visible
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and (coalesce(p.qual, '') ~ 'bucket_id = ''documents''::text'
          or coalesce(p.with_check, '') ~ 'bucket_id = ''documents''::text');
  if visible <> 4 then
    raise exception 'ATTRIBUTION UNPROVEN: % storage.objects policies name the ''documents'' bucket, not the four the header inventories (0303''s three plus 0007''s INSERT-only upload) — something else on this table could be what refused above', visible;
  end if;
  select count(*) into visible
    from pg_policies p
   where p.schemaname = 'storage' and p.tablename = 'objects'
     and p.policyname = 'Family members can upload their documents'
     and p.permissive = 'PERMISSIVE' and p.cmd = 'INSERT' and p.qual is null
     and p.with_check ~ 'bucket_id = ''documents''::text';
  if visible <> 1 then
    raise exception 'ATTRIBUTION UNPROVEN: the fourth ''documents'' policy on storage.objects is no longer 0007''s INSERT-only upload policy (or is no longer INSERT-only), so "0007''s fourth policy is INSERT-only" in the header is stale';
  end if;

  -- (iii) The function the three predicates call is still SECURITY DEFINER and
  --       still pins its search_path — the whole of 0303's fix. A definer that
  --       lost `security definer` reproduces 0266's hole exactly (the refusals
  --       above would have caught the breach); one that lost the pin resolves
  --       `documents` in the CALLER's search_path, which is the other way a
  --       definer lookup is redirected.
  if not exists (
       select 1 from pg_proc f
        where f.pronamespace = 'public'::regnamespace
          and f.proname = 'document_object_is_restricted'
          and f.prosecdef
          and exists (select 1 from unnest(f.proconfig) c where c ~ '^search_path=')) then
    raise exception 'ATTRIBUTION UNPROVEN: public.document_object_is_restricted is not a SECURITY DEFINER function with a pinned search_path, so the "definer wrapper" the header attributes the refusals to is not what ran';
  end if;

  raise notice 'document-bytes-boundary: OK — the same child CAN read, rename and delete the bytes of a sensitive document in the family they manage (control), in the family they do not the bytes are closed to them, and the catalog still shows 0303''s three policies over a SECURITY DEFINER document_object_is_restricted as the only thing standing there';
end
$probe$;

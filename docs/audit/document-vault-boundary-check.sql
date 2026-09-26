-- Behavioural proof for 0266, run as a real `authenticated` session under RLS.
--
-- Bubaly's Files hub draws a "Secure Vault". Before this migration that was a
-- label the client drew: the row, its `storage_path`, and the button that moves
-- a file back out were all reachable by every family member. This asserts the
-- database now decides.
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam        uuid := 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  parent_uid uuid := 'f0000000-0000-4000-8000-000000000001';
  teen_uid   uuid := 'f0000000-0000-4000-8000-000000000002';
  vault_id   uuid;
  medical_id uuid;
  school_id  uuid;
  n          int;
  refused    boolean;
  -- The negative control's own household: a SECOND family the same teen
  -- manages. Anchors in this probe's existing style (fam is all-f, the users are
  -- f0000000-…-00000000000N); each one grepped across docs/audit and
  -- supabase/migrations first and absent from both, because run-probes.sh runs
  -- every probe against ONE database and a reused uuid silently rewrites what
  -- some other probe asserts.
  ctl_fam     uuid := 'ffffffff-ffff-4fff-8fff-fffffffffffe';
  ctl_secure  uuid := 'f0000000-0000-4000-8000-000000000003';
  ctl_plain   uuid := 'f0000000-0000-4000-8000-000000000004';
  ctl_smuggle uuid := 'f0000000-0000-4000-8000-000000000005';
  ctl_title   text;
  ctl_path    text;
  -- For the ATTRIBUTION block after check 7: what the catalog says enforces
  -- this table, so the credit to 0266 is asserted rather than trusted.
  stray       text;
  trip_cols   text[];
begin
  insert into public.families (id, name) values (fam, 'Vault') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'vp@example.test'), (teen_uid, 'vt@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true), (fam, teen_uid, 'Teen', 'teen', true)
  on conflict do nothing;

  -- Three documents: one in the vault, one filed under a sensitive category
  -- but NOT flagged, and one ordinary school form the whole family needs.
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (fam, 'Mortgage deed', 'legal', fam || '/deed.pdf', true, parent_uid) returning id into vault_id;
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (fam, 'Blood results', 'medical', fam || '/bloods.pdf', false, parent_uid) returning id into medical_id;
  insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
  values (fam, 'Permission slip', 'school', fam || '/slip.pdf', false, parent_uid) returning id into school_id;

  -- ── The negative control's own household ─────────────────────────────────
  -- ctl_fam is a second family the SAME teen created, so `can_manage_family`
  -- answers YES here for the very user it answers no for in `fam` — one
  -- question, asked the other way. Two documents shaped like the two the checks
  -- below are run against: a vault row (`legal`, is_secure) that mirrors
  -- vault_id, and an ordinary school form that mirrors school_id.
  insert into public.families (id, name, created_by)
  values (ctl_fam, 'Vault (the teen''s own house)', teen_uid) on conflict do nothing;
  -- handle_new_family (0257) files the creator as a 'parent' already; upsert
  -- rather than assume, because a seed whose role is wrong would fail the
  -- control for a reason that is not the control's.
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (ctl_fam, teen_uid, 'Teen (a manager here)', 'parent', true)
  on conflict (family_id, user_id) do update
    set role = 'parent', is_active = true, display_name = excluded.display_name;
  -- PROVENANCE MATCHES THE ROWS UNDER TEST. vault_id, medical_id and school_id
  -- are all the PARENT's rows (created_by = parent_uid), and the seven checks
  -- run the teen against rows the teen did not file. So the control's seeded
  -- rows are the parent's too: a refusal keyed on created_by rather than on
  -- sensitivity ("only your own rows") would refuse every check AND stop legs
  -- 1-3 here, instead of passing the control and taking 0266's credit.
  -- parent_uid is not a member of ctl_fam and need not be — created_by is an
  -- FK to auth.users (0002), not a membership, and these inserts run as the
  -- migration owner before the session becomes the teen.
  insert into public.documents (id, family_id, title, category, storage_path, is_secure, created_by)
  values (ctl_secure, ctl_fam, 'Mortgage deed (control)', 'legal', ctl_fam || '/ctl-deed.pdf', true, parent_uid)
  on conflict do nothing;
  insert into public.documents (id, family_id, title, category, storage_path, is_secure, created_by)
  values (ctl_plain, ctl_fam, 'Permission slip (control)', 'school', ctl_fam || '/ctl-slip.pdf', false, parent_uid)
  on conflict do nothing;

  -- ── As the teen ──────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', teen_uid::text, true);
  set local role authenticated;

  -- Prove the identity took, both ways, because a probe that measures a
  -- stranger measures nothing and a probe that measures a manager measures the
  -- wrong person. Both drifts WOULD still fail below (a dead auth.uid() at
  -- check 3, a teen turned manager at check 1), but as a red credited to the
  -- vault; here they are named for what they are.
  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: the probe is not acting as a member of the family under test — auth.uid() did not resolve to the teen, so every zero below would be a stranger''s zero';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: the probe is acting as a MANAGER of the family under test, so nothing below is a teen boundary — family_members.role DEFAULTS to ''adult'' (0002), so a seed that lost its explicit ''teen'' lands here';
  end if;

  -- ── NEGATIVE CONTROL, and it runs FIRST, before any of the seven checks ────
  -- ("Negative control" is this audit's house term — document-bytes-boundary-
  -- check.sql uses it the same way — for the leg that must LAND. It goes red
  -- when a refusal recorded below comes from something other than the manager
  -- gate, never when the guard loosens; a textbook would call that a positive
  -- control. The name is kept so the two probes and run-probes.sh speak one
  -- vocabulary; read it as "the other answer to the same question".)
  -- ==========================================================================
  -- MECHANISM: RLS POLICY. The four policies `documents_select`,
  -- `documents_insert`, `documents_update` and `documents_delete` on
  -- public.documents, every one of them on the same question:
  --
  --     is_family_member(family_id)
  --     and (not is_sensitive_document(is_secure, category)
  --          or can_manage_family(family_id))
  --
  -- Nothing else on this table enforces it. There is no CHECK constraint on
  -- is_secure or category, the only unique index is the primary key, and the
  -- table carries exactly three row triggers besides the FK-internal ones —
  -- read here, and ASSERTED out of pg_trigger after check 7 rather than
  -- trusted from this paragraph:
  --
  --   * `trg_set_updated_at`, BEFORE UPDATE, from 0003's dynamic loop
  --     (`execute format('create trigger trg_set_updated_at before update on
  --     public.%I …')` over every table that has an `updated_at` column, so a
  --     grep for "on public.documents" never finds it). It stamps
  --     new.updated_at and returns the row; control legs 2 and 3 are the proof
  --     that it does.
  --   * `trg_mark_model_dirty`, AFTER INSERT OR UPDATE OR DELETE, from 0134's
  --     own dynamic loop: a SECURITY DEFINER stamp into family_model_dirty,
  --     made delete-safe by 0249. AFTER, so it cannot veto a row silently (a
  --     BEFORE trigger returning NULL reports zero rows with no error, exactly
  --     the shape checks 4 and 7 assert on); the control's five landings prove
  --     it does not raise for a live family.
  --   * `trg_documents_linked_trip_stays_home`, BEFORE UPDATE OF family_id
  --     WHEN family_id changes, from 0365 — untracked in this tree at the time
  --     of writing and absent from a database bootstrapped before it, so the
  --     assertion below tolerates its absence. SECURITY DEFINER, and it DOES
  --     raise 42501 — but only while a trip in another household still links
  --     the document, and only on a change of family_id, which no statement in
  --     this probe makes. Its column list is pinned to family_id alone below,
  --     because widened to is_secure it would be a second refuser of checks 4
  --     and 5 wearing the same sqlstate.
  --
  -- GOVERNING MIGRATION: 0266, and it is the LAST one to create these policies,
  -- not the first. The load-bearing fact is that NO migration after 0266
  -- creates, replaces or drops a policy on public.documents. The census behind
  -- it, redone rather than recounted (a hand count went stale once already —
  -- it said four files when a fifth had sorted last):
  --   * 0004 created all four generically on bare `is_family_member(family_id)`
  --     inside its fam_tables loop — through format('%1$s_select'), so the
  --     literal policy names are not in that file and `grep -l documents_select`
  --     does not find it. Grep for the loops (`execute format`), not only for
  --     the names.
  --   * 01090 re-asserted the same four on the same bare predicate. It sorts
  --     BEFORE 0117 and 0266 lexicographically, which is the order
  --     pg-bootstrap.sh applies.
  --   * 0266 dropped and re-created all four with the sensitivity leg added.
  --   * After 0266, `grep -l documents_select supabase/migrations` hits three
  --     more files, none of which touches a policy on this table: 0303 names
  --     `documents_select` in a comment (its policies are on storage.objects);
  --     0312 rewrote the FUNCTION `is_sensitive_document` (per-word matching,
  --     so "Medical Records" classifies) without touching a policy; 0365 names
  --     it in prose to explain why its vacation_documents guard is SECURITY
  --     INVOKER, creates its own policies on social_settings, and adds the
  --     family_id trigger inventoried above. `grep -l documents_update` adds
  --     0077, a substring hit on `trg_tax_documents_updated` — a trigger on
  --     public.tax_documents, a different table.
  -- So the predicate under test today is 0266's shape carrying 0312's
  -- classifier.
  --
  -- WHY THE CONTROL IS A SENSITIVE DOCUMENT IN A FAMILY THE TEEN MANAGES
  -- --------------------------------------------------------------------------
  -- The predicate is a disjunction, and the boundary this probe exists for is
  -- its SECOND limb. On an ordinary document the first limb — `not
  -- is_sensitive_document(...)` — is already true, so `can_manage_family` is
  -- never reached. An ordinary-document control therefore proves the session
  -- can write, and nothing at all about the manager gate. (This is the same
  -- reasoning document-bytes-boundary-check.sql records for its own control,
  -- where both fixture documents are sensitive on purpose.) So the control is
  -- the same teen, the same four policies, the same five statements, in a
  -- SECOND family where `can_manage_family` answers yes — one question, asked
  -- the other way, and every leg MUST LAND.
  --
  -- WHAT IT WOULD CATCH
  -- --------------------------------------------------------------------------
  --   * Checks 4 and 7 assert ZERO ROWS on the vault row. Checks 1 and 2 have
  --     just established that this session cannot SEE that row — and a row a
  --     session cannot see reports zero rows for an UPDATE and a DELETE just as
  --     readily as a USING clause does. Without a control those two checks are
  --     re-statements of check 1, not proof that documents_update and
  --     documents_delete refuse anything.
  --   * Checks 5 and 6 credit a WITH CHECK for `insufficient_privilege`, but a
  --     missing or revoked table GRANT raises 42501, a column-level `revoke
  --     update (is_secure) on public.documents` raises 42501, a dead auth.uid()
  --     raises 42501 through is_family_member, and a guard TRIGGER raises 42501
  --     — which is exactly how this repository refuses writes in 0223, 0305,
  --     0326 and 0331. documents already carries row triggers (0003, 0134 and,
  --     with 0365, one that raises 42501 itself), and 0134's has broken a write
  --     on this very table once before (0249).
  --   * Checks 1 and 2 count rows, and `count(*)` needs no column privilege at
  --     all: a `revoke select (storage_path) on public.documents` would leave
  --     both zeros intact while the thing check 1 is about — "storage_path,
  --     which is all a signed URL needs" — stopped being what was measured. So
  --     the control's read names `title` and `storage_path`, not count(*).
  --   * A refusal keyed on created_by instead of sensitivity: the rows under
  --     test are the parent's, and so are legs 1-3's, so it would stop the
  --     control too. Leg 5 then removes one row of each provenance.
  --   * Loosen 0266 back to 01090's bare `is_family_member` and every leg here
  --     still lands while the checks go red — which is the direction a probe
  --     is supposed to fail in. Measured one policy at a time on fresh copies:
  --     documents_select loosened fails check 1; documents_insert loosened
  --     fails check 6; documents_update alone and documents_delete alone move
  --     NO check — check 4's and check 7's rows are hidden by documents_select
  --     (zero rows either way), and check 5's UPDATE is refused by
  --     documents_select applied as a WITH CHECK on the new row, because a
  --     statement that reads `id` needs SELECT rights. Those two reversions are
  --     caught only by ATTRIBUTION (i) after check 7, which is why it asserts
  --     the predicate text of all four policies and not merely their count.
  --
  -- What it does NOT exclude on its own is a SECURITY DEFINER guard trigger
  -- asking the same sensitivity-plus-manager question: every leg and every
  -- check would stay green while the credit went to 0266. That is what the
  -- ATTRIBUTION block after check 7 is for.
  --
  -- The existing control at check 6 does NOT cover any of this: it files an
  -- ORDINARY document, so it takes the first limb and never asks the manager
  -- question. It is kept — it is the thing that proves INSERT is reachable at
  -- all — but it is not this.
  --
  -- Each leg catches `when others`, which is the opposite of the warning at
  -- check 6 below and for the same reason: there, swallowing a typo would make
  -- the probe PASS while testing nothing; here, any error at all makes it FAIL
  -- with the leg named and sqlstate echoed. A control may only ever go red.
  --
  -- The seed first: a control whose teen is not a manager of ctl_fam would fail
  -- leg 1 with a message about reading public.documents, which is the wrong
  -- diagnosis for a wrong seed.
  if not public.is_family_member(ctl_fam) then
    raise exception 'CONTROL SEED WRONG: this teen is not an active member of the control family, so the control cannot reach the rows it is meant to write';
  end if;
  if not public.can_manage_family(ctl_fam) then
    raise exception 'CONTROL SEED WRONG: this teen is not a MANAGER of the control family, so the control does not flip can_manage_family and would prove nothing about the manager gate';
  end if;

  -- Control leg 1 — mirrors checks 1 and 2: the same teen READS a sensitive
  -- document, title and storage_path, where the manager answer is yes.
  begin
    select d.title, d.storage_path into ctl_title, ctl_path
      from public.documents d where d.id = ctl_secure;
    get diagnostics n = row_count;
  exception when others then
    raise exception 'CONTROL FAILED (read): the teen reading a SENSITIVE document in the family they DO manage raised %: % — so the zeros in checks 1 and 2 would prove nothing about the vault, only that this session cannot read public.documents', sqlstate, sqlerrm;
  end;
  if n <> 1 or ctl_title is null or ctl_path is null then
    raise exception 'CONTROL FAILED (read): the teen read % row(s) of the control family''s SENSITIVE document (title %, storage_path %), so the zeros in checks 1 and 2 say nothing about is_sensitive_document — a session that sees nothing counts zero just as readily', n, coalesce(ctl_title, '<null>'), coalesce(ctl_path, '<null>');
  end if;

  -- Control leg 2 — mirrors check 4 statement for statement, same column, same
  -- direction ("move it out of the vault"), only the manager answer flipped.
  begin
    update public.documents set is_secure = false where id = ctl_secure;
    get diagnostics n = row_count;
  exception when others then
    raise exception 'CONTROL FAILED (move out of the vault): the teen''s UPDATE of is_secure on a SENSITIVE document in the family they DO manage raised %: % — a revoked UPDATE grant or a column-level revoke on is_secure reads exactly like the vault holding in checks 4 and 5', sqlstate, sqlerrm;
  end;
  if n <> 1 then
    raise exception 'CONTROL FAILED (move out of the vault): the teen''s UPDATE of is_secure on a document they DO manage changed % row(s), so check 4''s zero rows would prove nothing — an invisible row reports zero either way', n;
  end if;
  -- ctl_secure is still sensitive by CATEGORY ('legal'), so the delete leg
  -- below stays on the manager limb even after is_secure went false.

  -- Control leg 3 — mirrors check 5 statement for statement: the WITH CHECK
  -- direction, writing an ordinary document INTO the vault, which a manager may.
  begin
    update public.documents set is_secure = true where id = ctl_plain;
    get diagnostics n = row_count;
  exception when others then
    raise exception 'CONTROL FAILED (move into the vault): the teen''s UPDATE of is_secure on an ORDINARY document in the family they DO manage raised %: % — so check 5''s unchanged column would prove nothing about the WITH CHECK', sqlstate, sqlerrm;
  end;
  if n <> 1 then
    raise exception 'CONTROL FAILED (move into the vault): the teen''s UPDATE of is_secure in the family they DO manage changed % row(s), so check 5''s unchanged column says nothing about the vault', n;
  end if;

  -- Control leg 4 — mirrors check 6: filing a document straight into the vault,
  -- the same columns and the same 'other' category as the smuggled row, plus an
  -- explicit `id` so leg 5 can name what it removes, in the family where
  -- can_manage_family answers yes.
  begin
    insert into public.documents (id, family_id, title, category, storage_path, is_secure, created_by)
    values (ctl_smuggle, ctl_fam, 'Filed into the vault (control)', 'other', ctl_fam || '/ctl-into-the-vault.pdf', true, teen_uid);
    get diagnostics n = row_count;
  exception when others then
    raise exception 'CONTROL FAILED (file into the vault): the teen was refused a SECURE document in the family they DO manage (%: %), so check 6''s insufficient_privilege would prove nothing about the vault — the same 42501 comes from a missing grant, a column denial, a dead auth.uid() or a guard trigger', sqlstate, sqlerrm;
  end;
  if n <> 1 then
    raise exception 'CONTROL FAILED (file into the vault): the teen stored % SECURE document(s) in the family they DO manage and was not refused either, so check 6 would prove nothing', n;
  end if;

  -- Control leg 5 — mirrors check 7: DELETE sensitive documents. Two of them,
  -- one of each provenance and one on each limb of is_sensitive_document: the
  -- parent's ctl_secure (sensitive by CATEGORY now that leg 2 unflagged it) and
  -- the teen's own ctl_smuggle from leg 4 (sensitive by FLAG). A
  -- documents_delete keyed on created_by would remove one and not two; the
  -- real one (0266) keys on family and sensitivity only. It also leaves no
  -- vault row of the control's making behind in the second family.
  begin
    delete from public.documents where id in (ctl_secure, ctl_smuggle);
    get diagnostics n = row_count;
  exception when others then
    raise exception 'CONTROL FAILED (delete a vault document): the teen''s DELETE of SENSITIVE documents in the family they DO manage raised %: % — so check 7''s zero rows would prove nothing about documents_delete', sqlstate, sqlerrm;
  end;
  if n <> 2 then
    raise exception 'CONTROL FAILED (delete a vault document): the teen''s DELETE of two SENSITIVE documents they DO manage — one the parent filed, one they filed a moment ago — removed % row(s), so check 7''s zero rows say only that the row was out of reach, not that the policy refused it', n;
  end if;

  -- 1. The vault row is gone, `storage_path` with it — which is all a signed
  --    URL ever needed.
  select count(*) into n from public.documents where id = vault_id;
  if n <> 0 then raise exception 'a teen can still read the vault document'; end if;

  -- 2. Sensitivity is not only the flag. A medical record filed without it is
  --    still not the children's, or re-filing under `other` would be the
  --    bypass.
  select count(*) into n from public.documents where id = medical_id;
  if n <> 0 then raise exception 'a teen can read a medical document that was never flagged'; end if;

  -- 3. The ordinary household paperwork is untouched. A boundary that took the
  --    school form away would be the wrong boundary.
  select count(*) into n from public.documents where id = school_id;
  if n <> 1 then raise exception 'a teen lost sight of the family school form'; end if;

  -- 4. The button the Files hub shows every member — "move to shared" — no
  --    longer works on something they cannot see.
  update public.documents set is_secure = false where id = vault_id;
  if found then raise exception 'a teen moved a document out of the vault'; end if;

  -- 5. Nor can they hide one FROM the adults by moving it in.
  --
  -- This asserts the OUTCOME — did the column actually move? — rather than the
  -- mechanism, and that is deliberate: a check on "was 42501 raised" is
  -- satisfied by any refusal, including one from a missing grant or a broken
  -- fixture, while a check on the stored value can only pass if the row really
  -- did not change. It is the stronger of the two and needs no positive control.
  --
  -- The `begin … exception` block IS load-bearing and must stay: RLS refuses
  -- this update with 42501, and without a handler that error propagates and
  -- kills the probe before the outcome check below can run. Removing it was
  -- tried and does exactly that.
  --
  -- What was dead is the ASSIGNMENT inside it. `refused := true` is clobbered
  -- one line later by `select ... into refused`, so nothing ever read it, and
  -- it made the handler look like the assertion when the assertion is the
  -- column read. The block now swallows the refusal and says so, and the value
  -- tested comes only from the table.
  --
  -- NULL IS A FAILURE TOO. The column read runs through documents_select as
  -- the teen, and a school form that DID move into the vault is exactly the row
  -- documents_select would then hide from them: the select finds nothing,
  -- `refused` is NULL, and a bare `if refused` never fires. It has not been
  -- seen to happen — measured on a copy with documents_update alone loosened
  -- to 01090's bare predicate, this UPDATE is STILL refused ("new row violates
  -- row-level security policy"), because Postgres applies the SELECT policies
  -- as WITH CHECK options on the new row whenever the UPDATE needs SELECT
  -- rights, which `where id = …` does — but a check that lets NULL pass is
  -- leaning on that second policy without saying so. The row no longer being
  -- readable as an ORDINARY document is the failure, stated as such.
  --
  -- WHICH ALSO MEANS: this refusal is held by documents_update's WITH CHECK
  -- and by documents_select acting as one, and either alone suffices. Check 5
  -- therefore cannot tell documents_update reverting to 01090 from the guard
  -- holding, any more than check 4 can (its row is hidden). That reversion is
  -- caught by ATTRIBUTION (i) after check 7, and by nothing before it.
  begin
    update public.documents set is_secure = true where id = school_id;
  exception when insufficient_privilege then
    null;  -- expected; the assertion is the column read below, not this catch
  end;
  select is_secure into refused from public.documents where id = school_id;
  if refused is null then
    raise exception 'a teen hid a shared document in the vault (the school form is no longer visible to them after their own update, which is what a successful move into the vault looks like from a non-manager)';
  end if;
  if refused then raise exception 'a teen hid a shared document in the vault'; end if;

  -- 6. And cannot file a new one straight into it.
  --
  -- POSITIVE CONTROL FIRST. Check 6 asserts a refusal, and a refusal is only
  -- evidence about the VAULT if the same session can file an ordinary document.
  -- Every setup insert above ran before the session switched to the teen, so
  -- without this nothing proved the teen still holds INSERT on public.documents
  -- or still satisfies `is_family_member(family_id)` — and `insufficient_
  -- privilege` from a missing grant or a broken family scope would have read
  -- exactly like the vault predicate doing its job. This audit has twice
  -- recorded a refusal credited to the wrong cause; this is the guard against
  -- the third time.
  begin
    insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
    values (fam, 'Ordinary', 'other', fam || '/ordinary.pdf', false, teen_uid);
    get diagnostics n = row_count;
  exception when insufficient_privilege then
    -- Caught so the operator is told WHICH refusal this is. Without it the
    -- raw 'permission denied for table documents' is accurate but reads like
    -- the vault working, which is the confusion this control exists to end.
    raise exception 'CONTROL FAILED: the teen was refused an ORDINARY document (%), so a refusal in check 6 would prove nothing about the vault — the session has no usable INSERT on public.documents at all', sqlerrm;
  end;
  if n <> 1 then
    raise exception 'CONTROL FAILED: the teen filed no ORDINARY document and was not refused either, so check 6 below would prove nothing about the vault';
  end if;

  -- The control must leave the fixture exactly as it found it. The parent's
  -- count below asserts 3 documents, and a control that quietly made it 4 would
  -- trade one vacuous check for one false failure.
  delete from public.documents where storage_path = fam || '/ordinary.pdf';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'CONTROL FAILED: could not remove the ordinary document it just filed, so the fixture is no longer what the checks below assume';
  end if;

  refused := false;
  begin
    insert into public.documents (family_id, title, category, storage_path, is_secure, created_by)
    values (fam, 'Smuggled', 'other', fam || '/smuggled.pdf', true, teen_uid);
  -- Catch ONLY the RLS refusal, as check 5 above already does. `when others`
  -- also swallows a typo in this statement: rename a column here and the insert
  -- raises 42703, is caught, and the vault reports itself shut while nothing was
  -- tested. Verified against this file: renaming storage_path leaves the probe
  -- printing "document vault boundary check passed".
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then raise exception 'a teen filed a document into the vault'; end if;

  -- 7. Deleting what they cannot see is not a way to see it, but it is a way
  --    to destroy it.
  delete from public.documents where id = vault_id;
  if found then raise exception 'a teen deleted the vault document'; end if;

  -- ── ATTRIBUTION, asserted out of the catalog ─────────────────────────────
  -- The seven refusals above and the five landings before them are consistent
  -- with 0266's four policies — and equally consistent with a SECURITY DEFINER
  -- guard trigger asking the same sensitivity-plus-manager question, or with a
  -- fifth, RESTRICTIVE policy that happens to agree. The MECHANISM paragraph
  -- credits 0266 because its author read the migrations; this is what makes
  -- that credit self-verifying, the way 0299 and 0365 verify their own
  -- mechanism out of pg_trigger. It runs AFTER the checks on purpose: a
  -- loosened documents_select or documents_insert must fail on a refusal
  -- assertion above, not here — and a loosened documents_update or
  -- documents_delete, which no non-manager statement above can separate from
  -- documents_select, fails here or nowhere.
  --
  -- (i) Exactly the four policies of 0266, no more …
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'documents';
  if n <> 4 then
    raise exception 'ATTRIBUTION UNPROVEN: public.documents carries % policies, not 0266''s four — a fifth (a RESTRICTIVE one above all) could be what refused above, and the header''s "nothing else on this table enforces it" is no longer true', n;
  end if;
  -- … each permissive, on its own verb, and still asking all three questions in
  -- the half that governs that verb: USING for select and delete, WITH CHECK for
  -- insert, both for update (0266's "BOTH halves matter").
  select count(*) into n
    from pg_policies p
   where p.schemaname = 'public' and p.tablename = 'documents'
     and p.permissive = 'PERMISSIVE'
     and (
          (p.policyname = 'documents_select' and p.cmd = 'SELECT'
             and p.qual ~ 'is_family_member' and p.qual ~ 'is_sensitive_document' and p.qual ~ 'can_manage_family')
       or (p.policyname = 'documents_insert' and p.cmd = 'INSERT'
             and p.with_check ~ 'is_family_member' and p.with_check ~ 'is_sensitive_document' and p.with_check ~ 'can_manage_family')
       or (p.policyname = 'documents_update' and p.cmd = 'UPDATE'
             and p.qual ~ 'is_family_member' and p.qual ~ 'is_sensitive_document' and p.qual ~ 'can_manage_family'
             and p.with_check ~ 'is_family_member' and p.with_check ~ 'is_sensitive_document' and p.with_check ~ 'can_manage_family')
       or (p.policyname = 'documents_delete' and p.cmd = 'DELETE'
             and p.qual ~ 'is_family_member' and p.qual ~ 'is_sensitive_document' and p.qual ~ 'can_manage_family')
     );
  if n <> 4 then
    raise exception 'ATTRIBUTION UNPROVEN: only % of the four documents_{select,insert,update,delete} policies still ask is_family_member AND is_sensitive_document AND can_manage_family in the half that governs their verb, so the refusals above came from something other than 0266''s predicate', n;
  end if;

  -- (ii) No trigger on public.documents beyond the three the MECHANISM
  -- paragraph accounts for. A guard trigger refuses with the same 42501 and the
  -- same zero rows as a policy, so an unlisted one un-attributes every check.
  select string_agg(t.tgname, ', ' order by t.tgname) into stray
    from pg_trigger t
   where t.tgrelid = 'public.documents'::regclass
     and not t.tgisinternal
     and t.tgname not in ('trg_set_updated_at', 'trg_mark_model_dirty', 'trg_documents_linked_trip_stays_home');
  if stray is not null then
    raise exception 'ATTRIBUTION UNPROVEN: public.documents carries trigger(s) this probe does not account for (%) — read it, say why it cannot refuse what the checks above refuse, and list it, or the credit to 0266 does not hold', stray;
  end if;

  -- (iii) And the two that could interfere keep the shape that keeps them
  -- inert here. trg_mark_model_dirty is AFTER (a BEFORE trigger can veto a row
  -- silently, which is what checks 4 and 7 measure); the 0365 trigger, when
  -- present, fires on family_id and nothing else, because a column list widened
  -- to is_secure would make it a second refuser of checks 4 and 5.
  if exists (
    select 1 from pg_trigger
     where tgrelid = 'public.documents'::regclass and tgname = 'trg_mark_model_dirty'
       and (tgtype & 2) <> 0   -- TRIGGER_TYPE_BEFORE
  ) then
    raise exception 'ATTRIBUTION UNPROVEN: trg_mark_model_dirty has become a BEFORE trigger, which can veto a row without an error — the zero rows in checks 4 and 7 can no longer be credited to documents_update and documents_delete';
  end if;
  if exists (
    select 1 from pg_trigger
     where tgrelid = 'public.documents'::regclass and tgname = 'trg_documents_linked_trip_stays_home'
  ) then
    select coalesce(array_agg(a.attname::text order by a.attnum), '{}') into trip_cols
      from pg_trigger t
      join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
     where t.tgrelid = 'public.documents'::regclass
       and t.tgname = 'trg_documents_linked_trip_stays_home';
    if trip_cols <> array['family_id'] then
      raise exception 'ATTRIBUTION UNPROVEN: trg_documents_linked_trip_stays_home (0365) fires on columns % rather than on family_id alone, so it can now refuse the very UPDATEs checks 4 and 5 credit to documents_update', trip_cols;
    end if;
  end if;

  -- ── As the parent ────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);

  select count(*) into n from public.documents where family_id = fam;
  if n <> 3 then raise exception 'the parent sees % of their own 3 documents', n; end if;

  update public.documents set is_secure = false where id = vault_id;
  if not found then raise exception 'a parent cannot move their own document out of the vault'; end if;
  update public.documents set is_secure = true where id = vault_id;

  reset role;
  delete from public.documents where family_id = fam;
  delete from public.family_members where family_id = fam;
  delete from public.families where id = fam;
  -- The control's household goes too, and BEFORE the auth.users delete: every
  -- probe shares one database, and a stray second family the teen manages is
  -- exactly the quiet contamination that turns one unattributed check into one
  -- false failure somewhere else. (On the failure paths above nothing is left
  -- behind either: this whole probe is a single DO statement, so a raise rolls
  -- the fixture back with it.)
  delete from public.documents where family_id = ctl_fam;
  delete from public.family_members where family_id = ctl_fam;
  delete from public.families where id = ctl_fam;
  delete from auth.users where id in (parent_uid, teen_uid);
  raise notice 'document vault boundary check passed (control: the same teen DID read, unlock, lock, file and delete a sensitive document in the second family they manage, so the refusals above are the manager gate and not a missing grant, a column denial or a row out of reach; attribution: the catalog shows 0266''s four policies and no other enforcer on public.documents)';
end $$;

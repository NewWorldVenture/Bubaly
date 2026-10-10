-- ── A password alone does not open the family's vault (0391) ────────────────
--
-- Two-step sign-in is an opt-in control: a parent enrols an authenticator so a
-- stolen password cannot reach the family's secrets. Before 0391 the DOCUMENT
-- half of that control was enforced only by eight document PAGES calling
-- requireAal2; every policy on the tables behind them was a membership or role
-- check (is_family_member, can_manage_family) that a parent on an aal1 session
-- satisfies. So `GET /rest/v1/family_credentials` with the anon key and an aal1
-- JWT returned every stored password, and `DELETE /rest/v1/paperwork_items`
-- landed. 0382 closed the money half with public.session_cleared_step_up() and
-- RESTRICTIVE guards; 0391 reuses that helper for the vault.
--
-- Asserts, in both directions, and ATTRIBUTES each refusal to the assurance
-- rule rather than to the session being nobody:
--
--   0. CONTROL, before the first assertion: this session IS the enrolled
--      parent — auth.uid() is theirs, can_manage_family(family) is TRUE (so
--      every role clause on these tables passes) and session_cleared_step_up()
--      is FALSE — so the only clause that can refuse below is the one 0391
--      added. Without this, a deleted family_members row or a null sub would
--      make every refusal below pass for the wrong reason;
--   1. an enrolled parent at aal1 cannot READ a credential, a binder entry or
--      a tax document; the paperwork inbox row IS still readable — deliberate:
--      Needs-you, the household inbox and the home twin read paperwork_items
--      with no step-up entry point, and this line makes a future select guard
--      there a visible decision rather than a drift;
--   2. the same session cannot INSERT, UPDATE or DELETE on any of the four;
--   3. a token with NO aal claim is refused the same way — a level that cannot
--      be read is not a level that is granted (decideAal2's
--      'assurance_unreadable');
--   4. the same parent on aal2 reads and writes all four — the positive
--      control, and the reason the refusals in 1-2 are the assurance rule and
--      not a role, a grant or an invisible row;
--   5. a parent who never enrolled, and one whose only factor is UNVERIFIED,
--      read and write at aal1 — opt-in, not lock-out;
--   5b. a CHILD with a VERIFIED authenticator, at aal1, is not a manager, so
--      needsStepUp (lib/auth/mfa.ts) never sends them to the code page — and
--      the database must not refuse them for a code the app never asks for.
--      CONTROL first (auth.uid() is the child, is_family_member TRUE,
--      can_manage_family FALSE, session_cleared_step_up() FALSE — so only the
--      role clause can let them through), then: they read an ordinary
--      (not sensitive) binder entry and the tax document, change that binder
--      entry, and update and file paperwork, exactly as the base policies
--      allow; and they read NO credential, which is 0296's manager-only
--      policy, and NOT the sensitive binder entry, which is 0408's — neither
--      is 0391;
--   6. the catalogue holds exactly the fifteen guards (4 tables x insert/
--      update/delete + 3 secret tables x select), every one RESTRICTIVE and
--      calling session_cleared_step_up, every clause of every one carrying the
--      role half (`… OR NOT can_manage_family(family_id)`), the update guards
--      carrying BOTH halves; paperwork_items has NO select guard and documents
--      has NO step-up guard at all (0391's header says why — /dashboard/home
--      writes documents with no step-up);
--   7. NEGATIVE CONTROL: drop ONLY family_credentials' select and delete guards
--      and require the aal1 read and the aal1 delete to land again — so the
--      refusals in 1-2 were these policies and not a decoy;
--   8. NEGATIVE CONTROL for 5b: rebuild the household_info select guard and
--      the paperwork_items update guard WITHOUT the role clause (the shape
--      0391 first shipped with) and require the enrolled child's aal1 read of
--      the ORDINARY binder entry (0408 already hides the sensitive one, so it
--      could not show this) and paperwork update to be refused — so what let
--      the child through
--      in 5b was that clause, and the probe fails if it is ever dropped.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/a-password-alone-does-not-open-the-familys-vault-check.sql

\set FS '00000000-0000-4000-8000-000000039100'
\set UE '00000000-0000-4000-8000-000000039101'
\set UN '00000000-0000-4000-8000-000000039102'
\set UU '00000000-0000-4000-8000-000000039103'
\set UC '00000000-0000-4000-8000-000000039104'

begin;

insert into auth.users (id, email) values (:'UE','vault-step-up-enrolled@example.com')   on conflict do nothing;
insert into auth.users (id, email) values (:'UN','vault-step-up-never@example.com')      on conflict do nothing;
insert into auth.users (id, email) values (:'UU','vault-step-up-unverified@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UC','vault-step-up-child@example.com')      on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FS','Vault Step-up House',:'UE') on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UE','Enrolled parent','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UN','Never-enrolled parent','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UU','Half-enrolled parent','parent',true) on conflict do nothing;
insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (:'FS',:'UC','Enrolled child','child',true) on conflict do nothing;
update public.family_members set role = 'parent', is_active = true where family_id = :'FS' and user_id in (:'UE', :'UN', :'UU');
update public.family_members set role = 'child',  is_active = true where family_id = :'FS' and user_id = :'UC';

-- The factor lib/auth/mfa.ts counts (factor_type totp, status verified), and an
-- abandoned enrolment it does not. The child enrolled for their own account —
-- Settings › Security offers it to every member, with no role check.
insert into auth.mfa_factors (user_id, factor_type, status) values (:'UE', 'totp', 'verified');
insert into auth.mfa_factors (user_id, factor_type, status) values (:'UU', 'totp', 'unverified');
insert into auth.mfa_factors (user_id, factor_type, status) values (:'UC', 'totp', 'verified');

do $$
declare
  n        int;
  failures text[] := '{}';
  fam      constant uuid := '00000000-0000-4000-8000-000000039100';
  enrolled constant uuid := '00000000-0000-4000-8000-000000039101';
  never    constant uuid := '00000000-0000-4000-8000-000000039102';
  half     constant uuid := '00000000-0000-4000-8000-000000039103';
  child    constant uuid := '00000000-0000-4000-8000-000000039104';
  cred     uuid;
  info     uuid;
  info_open uuid;
  taxdoc   uuid;
  paper    uuid;
  guards   int;
begin
  -- Seeded as the table owner, so the rows exist whatever the policies say.
  insert into public.family_credentials (family_id, category, label, username, secret, created_by)
    values (fam, 'wifi', 'Home Wi-Fi', null, 'correct-horse-battery', enrolled) returning id into cred;
  insert into public.household_info (family_id, category, label, value, is_sensitive, created_by)
    values (fam, 'code', 'Alarm code', '4471', true, enrolled) returning id into info;
  -- An ordinary entry, for the child in 5b and 8: since 0408 a child reads and
  -- writes only binder entries that are NOT sensitive.
  insert into public.household_info (family_id, category, label, value, is_sensitive, created_by)
    values (fam, 'instruction', 'Bin day', 'Tuesday', false, enrolled) returning id into info_open;
  insert into public.tax_documents (family_id, tax_year, category, name, created_by, member_id)
    values (fam, 2025, 'w2', 'W-2 2025', enrolled,
            (select id from public.family_members where family_id = fam and user_id = child)) returning id into taxdoc;
  insert into public.paperwork_items (family_id, kind, title, status, created_by)
    values (fam, 'school_notice', 'Field trip slip', 'needs_action', enrolled) returning id into paper;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  perform set_config('request.jwt.claim.sub', enrolled::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal1"}', true);

  -- ── 0. Control: the actor has everything the policies need EXCEPT the code ─
  if auth.uid() is distinct from enrolled then
    failures := array_append(failures, 'CONTROL: auth.uid() is not the enrolled parent — nothing below would be about assurance');
  end if;
  if not public.can_manage_family(fam) then
    failures := array_append(failures, 'CONTROL: can_manage_family is FALSE for the enrolled parent — every refusal below would be a role refusal, not an assurance one');
  end if;
  if public.session_cleared_step_up() then
    failures := array_append(failures, 'CONTROL: session_cleared_step_up() answered true for an enrolled parent at aal1 — the helper 0391 reuses is not the 0382 rule');
  end if;

  -- ── 1. Enrolled, password only: the secrets do not come back ─────────────
  select count(*) into n from public.family_credentials where id = cred;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent read the family''s Wi-Fi password'); end if;
  select count(*) into n from public.household_info where id = info;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent read the alarm code from the binder'); end if;
  select count(*) into n from public.tax_documents where id = taxdoc;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent read a tax document'); end if;
  select count(*) into n from public.paperwork_items where id = paper;
  if n <> 1 then
    failures := array_append(failures, format('the paperwork inbox row is NOT readable at aal1 (%s rows) — Needs-you, the household inbox and the home twin read paperwork_items with no step-up entry point; a select guard there is a deliberate change, not 0391''s', n));
  end if;

  -- ── 2. Enrolled, password only: nothing is written ───────────────────────
  update public.family_credentials set secret = 'stolen' where id = cred;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent changed a stored password'); end if;
  update public.household_info set value = '0000' where id = info;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent changed the alarm code'); end if;
  update public.tax_documents set name = 'renamed' where id = taxdoc;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent renamed a tax document'); end if;
  update public.paperwork_items set status = 'archived' where id = paper;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent archived a paperwork item'); end if;

  delete from public.family_credentials where id = cred;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent deleted a stored password'); end if;
  delete from public.household_info where id = info;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent deleted a binder entry'); end if;
  delete from public.tax_documents where id = taxdoc;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent deleted a tax document'); end if;
  delete from public.paperwork_items where id = paper;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'an aal1 session of an ENROLLED parent deleted a paperwork item'); end if;

  begin
    insert into public.family_credentials (family_id, category, label, secret) values (fam, 'pin', 'Debit PIN', '1234');
    failures := array_append(failures, 'an aal1 session of an ENROLLED parent created a credential');
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.household_info (family_id, category, label, value) values (fam, 'code', 'Garage', '9999');
    failures := array_append(failures, 'an aal1 session of an ENROLLED parent created a binder entry');
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.tax_documents (family_id, tax_year, category, name) values (fam, 2024, '1099', '1099 2024');
    failures := array_append(failures, 'an aal1 session of an ENROLLED parent created a tax document');
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.paperwork_items (family_id, kind, title) values (fam, 'other', 'Planted');
    failures := array_append(failures, 'an aal1 session of an ENROLLED parent filed paperwork');
  exception when insufficient_privilege then null;
  end;

  -- ── 3. No aal claim at all ──────────────────────────────────────────────
  perform set_config('request.jwt.claims', '{}', true);
  select count(*) into n from public.family_credentials where id = cred;
  if n > 0 then failures := array_append(failures, 'a token with NO aal claim read a stored password — an unreadable level was treated as cleared'); end if;
  delete from public.paperwork_items where id = paper;
  get diagnostics n = row_count;
  if n > 0 then failures := array_append(failures, 'a token with NO aal claim deleted a paperwork item — an unreadable level was treated as cleared'); end if;

  -- ── 4. The same parent, code entered ────────────────────────────────────
  perform set_config('request.jwt.claims', '{"aal":"aal2"}', true);
  select count(*) into n from public.family_credentials where id = cred;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not read its own credential (%s rows) — so the refusals in 1 prove nothing', n)); end if;
  select count(*) into n from public.household_info where id = info;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not read its own binder entry (%s rows)', n)); end if;
  select count(*) into n from public.tax_documents where id = taxdoc;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not read its own tax document (%s rows)', n)); end if;
  select count(*) into n from public.paperwork_items where id = paper;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not read its own paperwork (%s rows)', n)); end if;

  update public.family_credentials set is_favorite = true where id = cred;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not update its own credential (%s rows) — so the refusals in 2 prove nothing', n)); end if;
  update public.household_info set note = 'checked' where id = info;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not update its own binder entry (%s rows)', n)); end if;
  update public.tax_documents set note = 'checked' where id = taxdoc;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not update its own tax document (%s rows)', n)); end if;
  update public.paperwork_items set status = 'in_progress' where id = paper;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('an aal2 session could not update its own paperwork (%s rows)', n)); end if;
  begin
    insert into public.family_credentials (family_id, category, label, secret) values (fam, 'app', 'Streaming', 'hunter2');
  exception when insufficient_privilege then
    failures := array_append(failures, 'an aal2 session could not save a credential');
  end;
  begin
    insert into public.paperwork_items (family_id, kind, title) values (fam, 'other', 'Filed at aal2');
  exception when insufficient_privilege then
    failures := array_append(failures, 'an aal2 session could not file paperwork');
  end;

  -- ── 5. Never enrolled, and enrolment abandoned ──────────────────────────
  perform set_config('request.jwt.claims', '{"aal":"aal1"}', true);
  perform set_config('request.jwt.claim.sub', never::text, true);
  select count(*) into n from public.family_credentials where id = cred;
  if n <> 1 then failures := array_append(failures, format('a parent who NEVER enrolled was refused a read of the family''s passwords on aal1 (%s rows) — step-up is meant to be opt-in', n)); end if;
  update public.household_info set note = 'never' where id = info;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('a parent who NEVER enrolled was refused a binder change on aal1 (%s rows) — step-up is meant to be opt-in', n)); end if;
  perform set_config('request.jwt.claim.sub', half::text, true);
  select count(*) into n from public.tax_documents where id = taxdoc;
  if n <> 1 then failures := array_append(failures, format('a parent whose only factor is UNVERIFIED was refused a tax document on aal1 (%s rows) — mfa.ts does not count that factor', n)); end if;
  update public.paperwork_items set status = 'done' where id = paper;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('a parent whose only factor is UNVERIFIED was refused a paperwork change on aal1 (%s rows) — mfa.ts does not count that factor', n)); end if;

  -- ── 5b. An ENROLLED CHILD, password only: not a manager, never asked ────
  perform set_config('request.jwt.claims', '{"aal":"aal1"}', true);
  perform set_config('request.jwt.claim.sub', child::text, true);
  if auth.uid() is distinct from child then
    failures := array_append(failures, 'CONTROL: auth.uid() is not the enrolled child — 5b would not be about the role clause');
  end if;
  if not public.is_family_member(fam) then
    failures := array_append(failures, 'CONTROL: the enrolled child is not a member of the family — every refusal or success in 5b would be about membership');
  end if;
  if public.can_manage_family(fam) then
    failures := array_append(failures, 'CONTROL: can_manage_family is TRUE for the child — 5b would be measuring a manager, not the role clause');
  end if;
  if public.session_cleared_step_up() then
    failures := array_append(failures, 'CONTROL: session_cleared_step_up() answered true for a child with a VERIFIED factor at aal1 — then the role clause is not what 5b measures');
  end if;
  select count(*) into n from public.household_info where id = info_open;
  if n <> 1 then failures := array_append(failures, format('an ENROLLED CHILD on aal1 was refused an ordinary binder entry (%s rows) — needsStepUp never sends a child to the code page, so the database refused them for a code the app never asks for', n)); end if;
  select count(*) into n from public.household_info where id = info;
  if n <> 0 then failures := array_append(failures, format('an ENROLLED CHILD read the alarm code (%s rows) — 0408 keeps a sensitive binder entry to managers whatever the assurance level', n)); end if;
  -- The held 0508 makes tax documents a manager's (the owner's decision on
  -- PROD-002): where it is installed the child reads none, at any level, and
  -- the Tax Vault says so instead of rendering empty.
  select count(*) into n from public.tax_documents where id = taxdoc;
  if exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'tax_documents'
               and p.policyname = 'Managers read tax_documents') then
    if n <> 0 then failures := array_append(failures, format('an ENROLLED CHILD read the tax document (%s rows) — 0508 makes tax documents a manager''s', n)); end if;
  elsif n <> 1 then failures := array_append(failures, format('an ENROLLED CHILD on aal1 was refused the tax document (%s rows) — the tax vault renders empty for them with no way to enter a code', n)); end if;
  select count(*) into n from public.family_credentials where id = cred;
  if n <> 0 then failures := array_append(failures, format('an ENROLLED CHILD read a stored password (%s rows) — 0296 makes family_credentials manager-only whatever the assurance level', n)); end if;
  update public.household_info set note = 'child' where id = info_open;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('an ENROLLED CHILD on aal1 was refused a change to an ordinary binder entry the base policy allows (%s rows)', n)); end if;
  update public.paperwork_items set status = 'needs_action' where id = paper;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, format('an ENROLLED CHILD on aal1 had a paperwork update FILTERED (%s rows) — setPaperworkStatusAction lets them through, so the row silently would not change', n)); end if;
  begin
    insert into public.paperwork_items (family_id, kind, title) values (fam, 'other', 'Filed by the child');
  exception when insufficient_privilege then
    failures := array_append(failures, 'an ENROLLED CHILD on aal1 could not file paperwork — the paperwork action lets them through and the insert raised 42501');
  end;

  perform set_config('role','postgres', true);

  -- ── 6. The catalogue: exactly these guards, and none where none belongs ──
  select count(*) into guards from pg_policies
   where schemaname = 'public'
     and permissive = 'RESTRICTIVE'
     and (coalesce(qual, '') || coalesce(with_check, '')) like '%session_cleared_step_up%'
     and (
       (tablename in ('family_credentials', 'household_info', 'tax_documents', 'paperwork_items')
        and policyname in (tablename || '_step_up_insert_guard', tablename || '_step_up_update_guard', tablename || '_step_up_delete_guard'))
       or
       (tablename in ('family_credentials', 'household_info', 'tax_documents')
        and policyname = tablename || '_step_up_select_guard')
     );
  if guards <> 15 then
    failures := array_append(failures, format('expected 15 RESTRICTIVE step-up guards calling session_cleared_step_up on the vault tables (4 x insert/update/delete + 3 x select), found %s', guards));
  end if;
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and tablename in ('family_credentials', 'household_info', 'tax_documents', 'paperwork_items')
     and policyname = tablename || '_step_up_update_guard'
     and qual like '%session_cleared_step_up%'
     and with_check like '%session_cleared_step_up%';
  if n <> 4 then
    failures := array_append(failures, format('an update guard is missing its USING or WITH CHECK half (%s of 4 carry both) — one half alone lets a row be moved into or out of the guarded state', n));
  end if;
  -- Every clause of every guard is needsStepUp's two halves: the assurance
  -- helper OR not a manager of the row's family. The leading % before each
  -- name absorbs a `public.` qualification when public is off the search_path.
  select count(*) into n from pg_policies
   where schemaname = 'public'
     and permissive = 'RESTRICTIVE'
     and policyname like '%\_step\_up\_%\_guard'
     and tablename in ('family_credentials', 'household_info', 'tax_documents', 'paperwork_items')
     and coalesce(qual, with_check) is not null
     and (qual is null or qual ilike '%session_cleared_step_up() OR (NOT %can_manage_family(family_id))%')
     and (with_check is null or with_check ilike '%session_cleared_step_up() OR (NOT %can_manage_family(family_id))%');
  if n <> 15 then
    failures := array_append(failures, format('%s of the 15 vault guards carry the role half (`OR NOT can_manage_family(family_id)`) in every clause — without it an enrolled child at aal1 is refused for a code needsStepUp never asks them for (0391 header)', n));
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'paperwork_items' and policyname = 'paperwork_items_step_up_select_guard') then
    failures := array_append(failures, 'paperwork_items carries a step-up SELECT guard — Needs-you, the household inbox and the home twin read it with no step-up entry point; if this is now intended, change 0391''s header and this probe together');
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'documents' and policyname like '%step\_up%') then
    failures := array_append(failures, 'documents carries a step-up guard — /dashboard/home (components/modules/home-module.tsx) writes it with no step-up; read 0391''s header before guarding it');
  end if;

  -- ── 7. Negative control ─────────────────────────────────────────────────
  drop policy if exists family_credentials_step_up_select_guard on public.family_credentials;
  drop policy if exists family_credentials_step_up_delete_guard on public.family_credentials;
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', enrolled::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal1"}', true);
  select count(*) into n from public.family_credentials where id = cred;
  if n <> 1 then
    failures := array_append(failures, format('with the credentials SELECT guard dropped the aal1 read saw %s row(s) — this probe has never been shown to fail on the read', n));
  end if;
  delete from public.family_credentials where id = cred;
  get diagnostics n = row_count;
  if n <> 1 then
    failures := array_append(failures, format('with the credentials DELETE guard dropped the aal1 delete touched %s row(s) — this probe has never been shown to fail on the write', n));
  end if;
  perform set_config('role','postgres', true);

  -- ── 8. Negative control for 5b: the same guards without the role half ───
  drop policy if exists household_info_step_up_select_guard on public.household_info;
  create policy household_info_step_up_select_guard on public.household_info
    as restrictive for select to authenticated using (public.session_cleared_step_up());
  drop policy if exists paperwork_items_step_up_update_guard on public.paperwork_items;
  create policy paperwork_items_step_up_update_guard on public.paperwork_items
    as restrictive for update to authenticated
    using (public.session_cleared_step_up()) with check (public.session_cleared_step_up());
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', child::text, true);
  perform set_config('request.jwt.claims', '{"aal":"aal1"}', true);
  select count(*) into n from public.household_info where id = info_open;
  if n <> 0 then
    failures := array_append(failures, format('with the role half dropped from the binder SELECT guard the enrolled child still read %s row(s) — 5b has never been shown to depend on that clause', n));
  end if;
  update public.paperwork_items set status = 'in_progress' where id = paper;
  get diagnostics n = row_count;
  if n <> 0 then
    failures := array_append(failures, format('with the role half dropped from the paperwork UPDATE guard the enrolled child still changed %s row(s) — 5b has never been shown to depend on that clause', n));
  end if;
  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'a password alone still opens the family''s vault:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'a-password-alone-does-not-open-the-familys-vault: OK (an enrolled parent on aal1, or on a token with no aal claim, cannot read a credential, binder entry or tax document, nor insert, update or delete on those or on paperwork_items; the paperwork row stays readable by design; the same parent on aal2 reads and writes all four; never-enrolled and unverified-only parents are untouched; an enrolled CHILD on aal1 reads and writes what the base policies allow, since needsStepUp never asks a non-manager for a code; 15 restrictive guards present, each carrying the role half, none on documents and none on paperwork SELECT; negative controls reproduced the read and the delete, and the child''s refusal without the role half)';
end $$;

rollback;

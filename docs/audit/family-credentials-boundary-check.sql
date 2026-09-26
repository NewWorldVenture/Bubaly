-- Behavioural proof for 0296, run as a real `authenticated` session under RLS.
--
-- public.family_credentials holds the household's Wi-Fi passwords, logins, PINs
-- and card details, with `secret` stored as plaintext. Before this migration its
-- four policies used is_family_member(), which ignores role — so every child,
-- who is a real auth user in this product, could read, change and delete all of
-- them. This asserts the database now decides.
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam        uuid := 'ccccaaaa-cccc-4ccc-8ccc-cccccccccccc';
  parent_uid uuid := 'c0000000-0000-4000-8000-000000000001';
  adult_uid  uuid := 'c0000000-0000-4000-8000-000000000002';
  child_uid  uuid := 'c0000000-0000-4000-8000-000000000003';
  wifi_id    uuid;
  n          int;
  refused    boolean;
  mem        boolean;
  mgr        boolean;
  planted    uuid;
  fixture_n  int;
  policy_n   int;
  loose      int;
  rls_on     boolean;
  ctl        text[] := '{}';
  err        text;
  cmds       int;
  expect     text;
  -- ONE reader for the table's policies, used three times below: before the
  -- control touches anything, after 0119 is restored, and after 0296 is put
  -- back. It is stricter than reading polqual alone in three ways that matter:
  --   * BOTH clauses. `coalesce(polqual, polwithcheck)` reads the USING of an
  --     UPDATE policy and never its WITH CHECK, so a policy that reads the
  --     expected predicate on the way in and `true` on the way out measured as
  --     clean. Each clause that EXISTS must carry the predicate.
  --   * PERMISSIVE only. A restrictive policy refuses on its own and would be
  --     the real author of a refusal credited here to the role clause.
  --   * FOUR distinct commands. Four policies that all happen to be SELECT
  --     policies are not select/insert/update/delete.
  -- The `replace` strips an optional schema qualification and nothing else:
  -- pg_get_expr renders `can_manage_family(family_id)` when public is on the
  -- search_path and `public.can_manage_family(family_id)` when it is not, and
  -- the probe does not control the search_path it is invoked under. Measured:
  -- `PGOPTIONS='-c search_path=' psql -f <this file>` failed with '0296: the
  -- negative control did not put 0296 back … the vault has been left open'
  -- against a database whose vault was perfectly intact — a false red, with
  -- the most alarming message in the file.
  reader     text := $q$
    select count(*),
           count(*) filter (
             where replace(coalesce(pg_get_expr(p.polqual, p.polrelid), $1::text), 'public.', '') <> $1::text
                or replace(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), $1::text), 'public.', '') <> $1::text
                or not p.polpermissive),
           count(distinct p.polcmd)
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = 'family_credentials'
  $q$;
begin
  insert into public.families (id, name) values (fam, 'Vault keys') on conflict do nothing;
  insert into auth.users (id, email) values
    (parent_uid, 'cp@example.test'), (adult_uid, 'ca@example.test'), (child_uid, 'cc@example.test')
  on conflict do nothing;
  -- A child with a real auth user, exactly as child-login-actions.ts creates one.
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, adult_uid,  'Adult',  'adult',  true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;

  -- Re-runnable: a probe that only passes on a virgin database is a probe
  -- someone debugging locally will mistake for a broken fix. Clear this
  -- family's rows first, then assert against the one row we create.
  delete from public.family_credentials where family_id = fam;

  insert into public.family_credentials (family_id, category, label, username, secret, created_by)
  values (fam, 'wifi', 'Home Wi-Fi', 'family', 'correct-horse-battery-staple', parent_uid)
  returning id into wifi_id;

  -- Ground truth about the SUBJECT, read here as the bootstrapping role so it
  -- cannot be confounded by family_members' own RLS: the user about to be
  -- refused below is an ACTIVE member of THIS family whose role is 'child'.
  select count(*) into n from public.family_members
   where family_id = fam and user_id = child_uid and role = 'child' and is_active;
  if n <> 1 then
    raise exception 'CONTROL FAILED: family_members holds % active ''child'' row(s) for this user in this family, not 1 — the subject of every refusal below is not the child this probe claims to be testing', n;
  end if;

  -- ---- the child sees nothing ----
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);

  -- Prove the impersonation TOOK before trusting a single refusal below.
  -- This probe first set `request.jwt.claims` (the JSON object); the shim's
  -- auth.uid() reads `request.jwt.claim.sub` (the dotted GUC), so auth.uid()
  -- was null and every refusal held because NOBODY WAS ANYBODY — the probe
  -- passed its child assertions against the ORIGINAL, broken policies too.
  -- A boundary probe that cannot tell "denied because child" from "denied
  -- because unauthenticated" proves nothing, so make that distinction fatal.
  if auth.uid() is distinct from child_uid then
    raise exception '0296: impersonation failed — auth.uid() is %, expected the child; the probe is not testing what it claims', auth.uid();
  end if;

  -- The same distinction one step further in, and checked HERE, before the
  -- first refusal, so a broken fixture is reported as a broken fixture rather
  -- than banked as a boundary holding. auth.uid() being the child's uuid does
  -- not make this session a MEMBER of this family: is_family_member and
  -- can_manage_family both read family_members, and when that row is missing
  -- or inactive both say false, so every refusal below holds because the actor
  -- is a STRANGER and not because they are a child — and 0296's role clause
  -- gets the credit. Measured on this file against a replayed database:
  -- `update family_members set is_active = false` for this child, and it still
  -- printed '0296 OK'.
  mem := public.is_family_member(fam);
  mgr := public.can_manage_family(fam);
  if not mem then
    raise exception 'CONTROL FAILED: the child is not an active member of this family, so can_manage_family refuses them for being a STRANGER and not for being a child — nothing below is attributable to 0296';
  end if;
  if mgr then
    -- NOT a fixture complaint. family_members was read twenty lines up as the
    -- bootstrapping role and holds exactly one ACTIVE 'child' row for this
    -- user in this family, so the subject IS a child; if can_manage_family
    -- nevertheless admits them, the guard 0296 leans on has been widened and
    -- the vault is open to children again. That is this file's boundary
    -- breaking, and it has to be reported as the breach it is — the audit's
    -- caution about chore-award-amount-check, where the guard under test is
    -- the one a later migration rewrote. Measured: redefining
    -- can_manage_family with role in ('parent','adult','child') made this file
    -- print 'CONTROL FAILED: … the fixture is not a child', sending whoever
    -- read it to the fixture rather than to the guard.
    raise exception '0296: can_manage_family admits this session, and family_members holds exactly one ACTIVE ''child'' row for this user in this family — so the subject IS a child and the guard lets children manage. can_manage_family has been widened (or its role check dropped) since 0003; the vault is open to children again';
  end if;

  select count(*) into n from public.family_credentials where family_id = fam;
  if n <> 0 then
    raise exception '0296: a child can READ % credential row(s); the vault is open', n;
  end if;

  refused := false;
  begin
    update public.family_credentials set secret = 'changed' where id = wifi_id;
    if not found then refused := true; end if;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0296: a child can WRITE a credential';
  end if;

  refused := false;
  begin
    delete from public.family_credentials where id = wifi_id;
    if not found then refused := true; end if;
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0296: a child can DELETE a credential';
  end if;

  -- Catch ONLY the RLS refusal. `when others` would also swallow a typo in
  -- this probe — a wrong column name would raise, be caught, and report the
  -- boundary as held. A probe that passes because it is broken is worse than
  -- no probe, and this file exists to prove a boundary, not to reach its end.
  refused := false;
  begin
    insert into public.family_credentials (family_id, category, label, secret, created_by)
    values (fam, 'pin', 'Child-added', 'x', child_uid);
  exception when insufficient_privilege then refused := true;
  end;
  if not refused then
    raise exception '0296: a child can INSERT a credential';
  end if;

  -- ---- both adults still have their vault (the fix must not lock them out) ----
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  if auth.uid() is distinct from parent_uid then
    raise exception '0296: impersonation failed — auth.uid() is %, expected the parent', auth.uid();
  end if;
  select count(*) into n from public.family_credentials where id = wifi_id;
  if n <> 1 then
    raise exception '0296: a PARENT sees % rows for the vault entry, expected 1 — the fix locked out an owner', n;
  end if;

  perform set_config('request.jwt.claim.sub', adult_uid::text, true);
  if auth.uid() is distinct from adult_uid then
    raise exception '0296: impersonation failed — auth.uid() is %, expected the adult', auth.uid();
  end if;
  select count(*) into n from public.family_credentials where id = wifi_id;
  if n <> 1 then
    raise exception '0296: an ADULT sees % rows for the vault entry, expected 1 — can_manage_family admits parent AND adult', n;
  end if;

  update public.family_credentials set notes = 'rotated' where id = wifi_id;
  if not found then
    raise exception '0296: an ADULT cannot update a credential';
  end if;

  -- ── NEGATIVE CONTROL: the same child, the same table, 0119's predicate ──
  --
  -- Everything the child did above is a refusal, and a refusal does not name
  -- the rule that caused it. `insufficient_privilege` is what arrives from a
  -- revoked GRANT, from a column denial, from a restrictive policy added by
  -- some other migration, and from 0296's role clause alike; zero rows is what
  -- arrives from a USING clause and from a row that is not there. The parent
  -- and adult assertions do not close that — they prove the PARENT's session
  -- works and say nothing about the CHILD's, which is the document-vault trap
  -- exactly: a probe whose subject could not have written anything either way.
  --
  -- So put 0119's four policies back — the precise pre-0296 state, since 0296
  -- is the newest migration that touches this table and it changed nothing but
  -- the predicate — and require THIS SAME child, in THIS SAME session, through
  -- THESE SAME four policies, to read, INSERT, UPDATE and DELETE. If a verb
  -- still fails, the refusals above were caused by something this file does not
  -- name, and crediting them to 0296 would be a guess.
  --
  -- This file has no outer transaction: it seeds the shared database on purpose
  -- and the runner replays it. So the control runs inside a sub-block, whose
  -- EXCEPTION clause makes it a subtransaction — an unexpected error rolls the
  -- policy DDL back with it and the vault closes again, rather than being left
  -- on 0119's predicate for every probe that runs after this one.
  reset role;

  -- FIRST, before this block writes one DDL statement: what were the refusals
  -- above actually measured against? The verification at the end of this file
  -- reads the four policies back out of the catalog, but on its own that is
  -- SELF-FULFILLING — it reads back the four policies this block itself
  -- creates, so it proves the restore took and says nothing about what was
  -- there before. And the parent/adult assertions only exercise SELECT and
  -- UPDATE: no manager in this file ever inserts or deletes. So a later
  -- migration that narrowed INSERT and DELETE — to is_family_admin, say,
  -- parents only — would be what the child's refusals were really measured
  -- against, and this block would then overwrite it with 0296's predicate and
  -- report 0296 holding. Measured exactly that: narrowing the insert and
  -- delete policies to is_family_admin made this file print '0296 OK' and
  -- leave can_manage_family behind on all four, silently reverting the
  -- tightening on the shared database for every probe that runs after it.
  expect := 'can_manage_family(family_id)';
  execute reader into policy_n, loose, cmds using expect;
  if policy_n <> 4 or loose <> 0 or cmds <> 4 then
    raise exception '0296: the refusals above were NOT measured against 0296 — family_credentials carries % permissive-or-restrictive policies covering % distinct command(s), of which % fail to read can_manage_family(family_id) on every clause they carry. Something after 0296 owns this table now; this run proves nothing about 0296, and this probe must not overwrite whatever put them there', policy_n, cmds, loose;
  end if;

  select count(*) into fixture_n from public.family_credentials where family_id = fam;

  begin
    drop policy if exists family_credentials_select on public.family_credentials;
    create policy family_credentials_select on public.family_credentials
      for select using (public.is_family_member(family_id));
    drop policy if exists family_credentials_insert on public.family_credentials;
    create policy family_credentials_insert on public.family_credentials
      for insert with check (public.is_family_member(family_id));
    drop policy if exists family_credentials_update on public.family_credentials;
    create policy family_credentials_update on public.family_credentials
      for update using (public.is_family_member(family_id))
      with check (public.is_family_member(family_id));
    drop policy if exists family_credentials_delete on public.family_credentials;
    create policy family_credentials_delete on public.family_credentials
      for delete using (public.is_family_member(family_id));

    -- Read the restored state out of the CATALOG rather than trusting the eight
    -- statements above. A control that succeeded because RLS was off, or
    -- because some extra permissive policy on this table reads `true`, is a
    -- control that cannot fail — and a control that cannot fail is the green
    -- that hides the defect.
    expect := 'is_family_member(family_id)';
    execute reader into policy_n, loose, cmds using expect;
    if policy_n <> 4 or loose <> 0 or cmds <> 4 then
      ctl := array_append(ctl, format('CONTROL FAILED: after restoring 0119 the table carries %s policies covering %s distinct command(s), of which %s do not read is_family_member(family_id) on every clause they carry — the control was not measuring the role clause', policy_n, cmds, loose));
    end if;
    select relrowsecurity into rls_on from pg_class where oid = 'public.family_credentials'::regclass;
    if not rls_on then
      ctl := array_append(ctl, 'CONTROL FAILED: row level security is OFF on family_credentials, so the control below would succeed with no policy consulted at all — and so would a child in production');
    end if;

    set local role authenticated;
    perform set_config('request.jwt.claim.sub', child_uid::text, true);
    if auth.uid() is distinct from child_uid then
      ctl := array_append(ctl, format('CONTROL FAILED: auth.uid() is %s, not the child — the control is not being run by the actor whose refusals it is supposed to attribute', coalesce(auth.uid()::text, 'null')));
    end if;

    select count(*) into n from public.family_credentials where id = wifi_id;
    if n <> 1 then
      ctl := array_append(ctl, format('CONTROL FAILED: with 0119''s is_family_member predicate restored the child still READ %s row(s) of the vault entry instead of 1, so the read refusal above was not 0296''s doing', n));
    end if;

    begin
      insert into public.family_credentials (family_id, category, label, secret, created_by)
      values (fam, 'pin', 'Negative control', '0000', child_uid)
      returning id into planted;
    exception when insufficient_privilege then
      ctl := array_append(ctl, format('CONTROL FAILED: the child was refused an ORDINARY credential with 0119''s predicate restored (%s), so a refusal in the INSERT check above would prove nothing about the vault', sqlerrm));
    end;

    -- The UPDATE and the DELETE each get their OWN insufficient_privilege
    -- handler, for the same reason the INSERT has one. Without them a 42501
    -- here — which is what a revoked table GRANT or a column privilege raises,
    -- and neither is 0296 — escaped to the sub-block's `when others` and was
    -- reported as '0296: the negative control aborted (permission denied for
    -- table family_credentials)', naming neither the verb nor the diagnosis.
    -- Measured both: `revoke delete on family_credentials from authenticated`,
    -- and a column denial that grants every column of UPDATE except `secret`
    -- (note that `revoke update (secret)` alone is a NO-OP while the
    -- table-level grant stands, which is the trap in testing this). Both are
    -- unattributed refusals, and both now say so.
    if planted is not null then
      begin
        update public.family_credentials set secret = 'rotated-by-the-control' where id = planted;
        get diagnostics n = row_count;
        if n <> 1 then
          ctl := array_append(ctl, format('CONTROL FAILED: with is_family_member restored the child UPDATED %s row(s) of a credential they had just filed themselves, so the UPDATE refusal above is unattributed', n));
        end if;
      exception when insufficient_privilege then
        ctl := array_append(ctl, format('CONTROL FAILED: the child was refused an UPDATE of a credential THEY had just filed, with 0119''s predicate restored (%s) — that is a GRANT or a column privilege and not 0296''s role clause, so the UPDATE check above would prove nothing about the vault', sqlerrm));
      end;

      -- The control removes the row it filed. This file leaves its fixture in
      -- the shared database on purpose, and the count is compared across the
      -- whole control below, so a control that quietly left a second row behind
      -- would trade one unattributed check for one false failure on the next
      -- replay.
      begin
        delete from public.family_credentials where id = planted;
        get diagnostics n = row_count;
        if n <> 1 then
          ctl := array_append(ctl, format('CONTROL FAILED: with is_family_member restored the child DELETED %s row(s) of a credential they had just filed themselves, so the DELETE refusal above is unattributed', n));
        end if;
      exception when insufficient_privilege then
        ctl := array_append(ctl, format('CONTROL FAILED: the child was refused a DELETE of a credential THEY had just filed, with 0119''s predicate restored (%s) — that is a GRANT and not 0296''s role clause, so the DELETE check above would prove nothing about the vault', sqlerrm));
      end;
    end if;

    -- Put 0296 back before anything else reads this table.
    reset role;

    -- Fixture hygiene, not measurement: every verdict about the planted row is
    -- already recorded in `ctl`, so sweep it as the bootstrapping role whatever
    -- happened above. A DELETE the child was REFUSED would otherwise surface
    -- forty lines down as 'the negative control left the family holding 2
    -- credentials instead of 1' — a corrupted-fixture complaint standing in
    -- front of the unattributed refusal that actually caused it. Deletes zero
    -- rows on the normal path, where the child already removed it.
    if planted is not null then
      delete from public.family_credentials where id = planted;
    end if;
    drop policy if exists family_credentials_select on public.family_credentials;
    create policy family_credentials_select on public.family_credentials
      for select using (public.can_manage_family(family_id));
    drop policy if exists family_credentials_insert on public.family_credentials;
    create policy family_credentials_insert on public.family_credentials
      for insert with check (public.can_manage_family(family_id));
    drop policy if exists family_credentials_update on public.family_credentials;
    create policy family_credentials_update on public.family_credentials
      for update using (public.can_manage_family(family_id))
      with check (public.can_manage_family(family_id));
    drop policy if exists family_credentials_delete on public.family_credentials;
    create policy family_credentials_delete on public.family_credentials
      for delete using (public.can_manage_family(family_id));
  exception when others then
    get stacked diagnostics err = message_text;
    raise exception '0296: the negative control aborted (%) — the subtransaction rolled the four policies back to 0296, so the vault is closed, but this run proves nothing', err;
  end;

  -- The restore is verified out of the catalog too, for the same reason the
  -- loosened state was: a botched restore would otherwise hand 0119's predicate
  -- to every probe that runs after this one, and to anyone reading this database
  -- afterwards.
  expect := 'can_manage_family(family_id)';
  execute reader into policy_n, loose, cmds using expect;
  if policy_n <> 4 or loose <> 0 or cmds <> 4 then
    raise exception '0296: the negative control did not put 0296 back — family_credentials carries % policies covering % distinct command(s), of which % do not read can_manage_family(family_id) on every clause they carry; the vault has been left open', policy_n, cmds, loose;
  end if;

  -- Order matters on the failing path, and only there: the vault being shut
  -- again is checked first because it is a safety property, then WHY the
  -- control failed, then whether it tidied up after itself. All three still run
  -- on the passing path. Reporting the fixture count first made a refused
  -- control DELETE read as housekeeping.
  if array_length(ctl, 1) is not null then
    raise exception '0296 is UNATTRIBUTED — the child''s refusals above cannot be credited to the role clause: %', array_to_string(ctl, ' | ');
  end if;

  select count(*) into n from public.family_credentials where family_id = fam;
  if n <> fixture_n then
    raise exception 'CONTROL FAILED: the negative control left the family holding % credentials instead of the % it started with — it corrupted the fixture it was supposed to leave alone', n, fixture_n;
  end if;

  reset role;
  raise notice '0296 OK: the child is a real active member of this family whom can_manage_family refuses (control), and is refused read, insert, update and delete; parent and adult keep the vault; and with 0119''s is_family_member predicate restored that SAME child got all four verbs through the SAME four policies, so the refusals are 0296''s role clause and nothing else';
end $$;

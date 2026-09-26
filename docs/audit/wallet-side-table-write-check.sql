-- ── A child cannot write the five wallet side-tables (0322) ─────────────────
--
-- `babysitter_profiles`, `babysitter_payments`, `gift_links`, `gift_payments`
-- and `compliance_disclosures` came out of 0088_family_wallet.sql's DO loop with
--
--   FOR ALL TO authenticated USING (public.is_family_member(family_id))
--
-- `FOR ALL` covers INSERT, UPDATE and DELETE, and `is_family_member` ignores
-- role. Every one of these five has a server action in app/(app)/wallet/
-- actions.ts that opens `if (!isManager(ctx.active.role)) return …` — and a
-- server action is not a boundary against a JWT holder. Children have real
-- logins; a request to /rest/v1/gift_payments never passes through app/.
--
-- Asserts, behaviourally, in both directions:
--
--   1. a child cannot rewrite a babysitter's rate, inflate or invent a payment,
--      plant a gift link, settle a pending gift, or erase the record of who
--      accepted the wallet terms;
--   2. a manager still can — a guard that refuses everyone is not a boundary;
--   3. a child CAN still read, recorded rather than asserted as a defect:
--      /wallet/babysitters and /wallet/gift render from these rows for whoever
--      is signed in, and narrowing SELECT is a product decision nobody has
--      taken. If that changes this line fails on purpose;
--   4. UPDATE pins `family_id` on BOTH sides, so a manager of family A cannot
--      move a row into family B;
--   5. `anon` holds no INSERT. The 0322 guards are `TO authenticated` and a
--      restrictive policy only ANDs with requests made AS a role it names, so
--      for an anonymous request they are absent and the grant layer is all that
--      is left — the same argument 0290 makes for the ledger tables;
--   6. and a NEGATIVE CONTROL: drop the restrictive guards, leaving 0088's
--      permissive policy exactly as it was, and require the child's escalation
--      to SUCCEED again. A probe that has never been shown to fail is
--      decoration.
--
-- Note on the INSERT assertions: RLS is evaluated BEFORE a unique index, so an
-- insert that reaches a constraint violation is one RLS LET THROUGH. Those are
-- caught separately and reported as breaches rather than swallowed.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/wallet-side-table-write-check.sql

\set FW '00000000-0000-4000-8000-00000000ba10'
\set FX '00000000-0000-4000-8000-00000000ba11'
\set UP '00000000-0000-4000-8000-00000000ba12'
\set UK '00000000-0000-4000-8000-00000000ba13'
\set UO '00000000-0000-4000-8000-00000000ba14'

begin;

insert into auth.users (id, email) values (:'UP','w-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','w-kid@example.com')    on conflict do nothing;
insert into auth.users (id, email) values (:'UO','w-other@example.com')  on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FW','Wallet House',:'UP') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FX','Other House',:'UO')  on conflict do nothing;

insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000ba15',:'FW',:'UK','Kid','child',true) on conflict do nothing;
-- The creator is provisioned as a manager by on_family_created; make sure of it
-- rather than assuming, because a fixture whose roles are wrong proves nothing.
update public.family_members set role = 'parent' where family_id = :'FW' and user_id = :'UP';
update public.family_members set role = 'parent' where family_id = :'FX' and user_id = :'UO';

insert into public.babysitter_profiles (id, family_id, name, rate_cents)
  values ('00000000-0000-4000-8000-00000000ba16', :'FW', 'The Sitter', 2000);
insert into public.babysitter_payments (id, family_id, babysitter_id, amount_cents, status)
  values ('00000000-0000-4000-8000-00000000ba17', :'FW', '00000000-0000-4000-8000-00000000ba16', 5000, 'pending');
insert into public.gift_links (id, family_id, token, is_active)
  values ('00000000-0000-4000-8000-00000000ba18', :'FW', 'gift_probe_token_ba18', true);
-- A real pending gift from a real grandparent, waiting in /wallet/gift.
insert into public.gift_payments (id, family_id, gift_link_id, amount_cents, status, giver_name)
  values ('00000000-0000-4000-8000-00000000ba19', :'FW', '00000000-0000-4000-8000-00000000ba18', 10000, 'pending', 'Grandma');
-- Who accepted the wallet terms, when, and from where.
insert into public.compliance_disclosures (id, family_id, kind, version, accepted_by, ip_address)
  values ('00000000-0000-4000-8000-00000000ba1a', :'FW', 'wallet_terms', 'v1', :'UP', '203.0.113.7');

grant select, insert, update, delete on public.babysitter_profiles    to authenticated;
grant select, insert, update, delete on public.babysitter_payments    to authenticated;
grant select, insert, update, delete on public.gift_links             to authenticated;
grant select, insert, update, delete on public.gift_payments          to authenticated;
grant select, insert, update, delete on public.compliance_disclosures to authenticated;

do $$
declare
  n int;
  failures text[] := '{}';
  fam       constant uuid := '00000000-0000-4000-8000-00000000ba10';
  other_fam constant uuid := '00000000-0000-4000-8000-00000000ba11';
  parent_u  constant uuid := '00000000-0000-4000-8000-00000000ba12';
  kid_u     constant uuid := '00000000-0000-4000-8000-00000000ba13';
  sitter    constant uuid := '00000000-0000-4000-8000-00000000ba16';
  payment   constant uuid := '00000000-0000-4000-8000-00000000ba17';
  link      constant uuid := '00000000-0000-4000-8000-00000000ba18';
  gift      constant uuid := '00000000-0000-4000-8000-00000000ba19';
  terms     constant uuid := '00000000-0000-4000-8000-00000000ba1a';
  t text;
  tbls constant text[] := array[
    'babysitter_profiles','babysitter_payments','gift_links','gift_payments','compliance_disclosures'
  ];
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  update public.babysitter_profiles set rate_cents = 1 where id = sitter;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child rewrote %s babysitter rate(s)', n)); end if;

  update public.babysitter_payments set amount_cents = 999999 where id = payment;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child rewrote %s babysitter payment amount(s)', n)); end if;

  -- The move that costs someone money: /wallet/gift lists only status='pending',
  -- so settling the row makes a real gift vanish from the queue uncredited.
  update public.gift_payments set status = 'completed' where id = gift;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child SETTLED %s pending gift(s) — it leaves the approval queue and is never credited', n)); end if;

  update public.gift_links set is_active = false where id = link;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child deactivated %s gift link(s)', n)); end if;

  -- A disclosure record whose subject can delete it records nothing.
  delete from public.compliance_disclosures where id = terms;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s wallet-terms acceptance record(s)', n)); end if;

  delete from public.babysitter_payments where id = payment;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s babysitter payment(s)', n)); end if;

  -- Planting rows. `unique_violation` is caught alongside success on purpose:
  -- RLS runs BEFORE a unique index, so an insert that reaches the constraint is
  -- one RLS did not refuse.
  begin
    insert into public.gift_links (family_id, token, is_active)
      values (fam, 'gift_planted_by_the_child', true);
    failures := array_append(failures, 'a child CREATED a gift link — a public payment page for their own wallet');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s gift_links INSERT reached the unique index, so RLS did not refuse it');
  end;

  begin
    insert into public.babysitter_payments (family_id, amount_cents, status)
      values (fam, 250000, 'completed');
    failures := array_append(failures, 'a child INVENTED a completed babysitter payment');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s babysitter_payments INSERT reached the unique index, so RLS did not refuse it');
  end;

  begin
    insert into public.compliance_disclosures (family_id, kind, version, accepted_by)
      values (fam, 'wallet_terms', 'forged', kid_u);
    failures := array_append(failures, 'a child FORGED a wallet-terms acceptance in their own name');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s compliance_disclosures INSERT reached the unique index, so RLS did not refuse it');
  end;

  -- Reads stay open, deliberately. Recorded so the decision is visible.
  select count(*) into n from public.babysitter_payments where id = payment;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ babysitter payments — that is a change of decision; update finalaudit.md and this probe');
  end if;
  select count(*) into n from public.gift_payments where id = gift;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ gift payments — that is a change of decision; update finalaudit.md and this probe');
  end if;

  -- ── As the parent: the positive control ─────────────────────────────────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  update public.babysitter_profiles set rate_cents = 2500 where id = sitter;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not change a babysitter rate — the guard refuses everyone'); end if;

  update public.gift_payments set status = 'cancelled' where id = gift;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not dismiss a gift'); end if;

  begin
    insert into public.gift_links (family_id, token, is_active)
      values (fam, 'gift_made_by_the_parent', true);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not create a gift link');
  end;

  begin
    insert into public.babysitter_payments (family_id, babysitter_id, amount_cents, status)
      values (fam, sitter, 4000, 'completed');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not record a babysitter payment');
  end;

  begin
    insert into public.compliance_disclosures (family_id, kind, version, accepted_by)
      values (fam, 'card_terms', 'v1', parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not record a disclosure acceptance');
  end;

  -- ── The WITH CHECK half: a manager may not relocate a row ───────────────
  begin
    update public.babysitter_profiles set family_id = other_fam where id = sitter;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, 'a manager MOVED a babysitter profile into another family — WITH CHECK is missing');
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── The grant layer, which `to authenticated` guards cannot reach ───────
  perform set_config('role','postgres', true);
  foreach t in array tbls loop
    if has_table_privilege('anon', 'public.' || t, 'INSERT') then
      failures := array_append(failures,
        format('anon holds INSERT on %s — the 0322 guards are `to authenticated` and would not apply', t));
    end if;
  end loop;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Drop only the restrictive guards. 0088's permissive "Members manage …"
  -- policy is left exactly as it was, which is precisely the pre-0322 state.
  -- The child's escalation must now SUCCEED. The outer rollback undoes this
  -- along with everything else.
  foreach t in array tbls loop
    execute format('drop policy if exists %I on public.%I', t || '_manager_insert_guard', t);
    execute format('drop policy if exists %I on public.%I', t || '_manager_update_guard', t);
    execute format('drop policy if exists %I on public.%I', t || '_manager_delete_guard', t);
  end loop;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  update public.babysitter_payments set amount_cents = 777777 where id = payment;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with 0088''s policy alone the child STILL could not rewrite a payment — this probe is decoration, not a boundary');
  end if;

  update public.gift_payments set status = 'completed' where id = gift;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with 0088''s policy alone the child STILL could not settle a gift — this probe is decoration, not a boundary');
  end if;

  perform set_config('role','postgres', true);

  if array_length(failures, 1) is not null then
    raise exception E'wallet side-tables are not manager-written:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'wallet-side-table-write: OK (child blocked on 5 tables, manager allowed, family_id pinned, anon holds no INSERT, negative control saw the defect)';
end $$;

rollback;

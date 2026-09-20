-- ── The money trail records who appended, not who was named (0328) ─────────
--
-- 0224 made `wallet_audit_logs` append-only for clients — it dropped 0088's
-- `FOR ALL` policy, kept SELECT and INSERT for family members, and added no
-- UPDATE or DELETE policy at all. That part holds and this probe asserts it
-- still does. What 0224 assumed is in its own closing line: "A child can still
-- append a row (attributed to them via actor_user_id …)". Attributed by whom?
-- The policy pinned `family_id` and nothing else:
--
--   wallet_audit_logs_insert FOR INSERT TO authenticated
--     WITH CHECK (public.is_family_member(family_id))
--
-- so the attribution was the writer's choice — the same defect `0320_audit_
-- logs_says_who_wrote_it.sql` pinned on the household trail and did not carry
-- across to its money-domain sibling. /wallet, /wallet/children/[childId],
-- /api/ai/wallet and app/(app)/admin/wallet all render the row as written, and
-- it is the same trail `wallet_fund_goal` (0208) writes its `goal_funded` line
-- into.
--
-- Asserts, in both directions:
--
--   1. a child can STILL append a row about themselves. Fourteen call sites
--      append on the caller's own client — an AI-coach call is a child's — and
--      a boundary that stops the honest caller is the wrong boundary;
--   2. a child CANNOT append a row naming the parent as actor;
--   3. a child CANNOT append a row with no actor at all, which would read as a
--      system event beside the genuine service-role rows;
--   4. a parent cannot forge either — this is identity, not role;
--   5. 0224's append-only property survives: no client role may UPDATE or
--      DELETE an existing row, so the trail can be polluted but never edited;
--   6. reads stay `is_family_member` — a child still sees their household's
--      money history, which is what /wallet renders;
--   7. `anon` holds no INSERT (0290's argument);
--   8. NEGATIVE CONTROL: put 0224's insert policy back EXACTLY as it was and
--      require the forgery to succeed again.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/wallet-audit-actor-check.sql

\set FW '00000000-0000-4000-8000-00000000de10'
\set UP '00000000-0000-4000-8000-00000000de11'
\set UK '00000000-0000-4000-8000-00000000de12'

begin;

insert into auth.users (id, email) values (:'UP','de-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','de-kid@example.com')    on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FW','Trail Wallet House',:'UP') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000de13',:'FW',:'UK','Kid','child',true) on conflict do nothing;
update public.family_members set role = 'parent' where family_id = :'FW' and user_id = :'UP';

-- A genuine line, written the way lib/wallet/server.ts writes one.
insert into public.wallet_audit_logs (id, family_id, actor_user_id, action, entity_type, detail)
  values ('00000000-0000-4000-8000-00000000de14', :'FW', :'UP', 'funds_added', 'child_wallets', 'Added 2000 cents');

grant select, insert on public.wallet_audit_logs to authenticated;

do $$
declare
  n int;
  failures text[] := '{}';
  fam      constant uuid := '00000000-0000-4000-8000-00000000de10';
  parent_u constant uuid := '00000000-0000-4000-8000-00000000de11';
  kid_u    constant uuid := '00000000-0000-4000-8000-00000000de12';
  genuine  constant uuid := '00000000-0000-4000-8000-00000000de14';
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- 1. Append, as themselves. /api/ai/wallet logs `ai_coach_call` this way.
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
      values (fam, kid_u, 'ai_coach_call', 'ai_wallet_coach', 'AI Money Coach generated');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a child can no longer append a row about THEMSELVES — the money trail now has holes exactly where a child uses the product');
  end;

  -- 2. The forgery: a credit the parent never made, signed with the parent's id.
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
      values (fam, parent_u, 'funds_added', 'child_wallets', 'Added 50000 cents');
    failures := array_append(failures, 'a child ATTRIBUTED a wallet credit to the parent — /wallet renders it as the parent''s doing');
  exception when insufficient_privilege then null;
  end;

  -- 3. The system-row disguise: no actor at all, beside the genuine
  --    service-role card-spend rows (lib/wallet/server.ts debitCardSpend).
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
      values (fam, null, 'card_spend', 'child_wallets', 'Spent 9900 cents');
    failures := array_append(failures, 'a child wrote an actor-less row, which reads as a system event in the money trail');
  exception when insufficient_privilege then null;
  end;

  -- 4. Identity, not role: a parent cannot sign for the child either.
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
      values (fam, kid_u, 'ai_coach_call', 'ai_wallet_coach', 'blamed on the child');
    failures := array_append(failures, 'a PARENT attributed an action to the child — the pin is a role check, not an identity check');
  exception when insufficient_privilege then null;
  end;

  -- The parent's own append still works (the positive control for the fix).
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
      values (fam, parent_u, 'wallet_activated', 'family_wallets', 'Family Wallet activated');
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not append a row about themselves');
  end;

  -- 5. 0224's append-only property: no client role edits or prunes the trail.
  begin
    update public.wallet_audit_logs set detail = 'Added 1 cent' where id = genuine;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a MANAGER rewrote %s money-audit row(s) — 0224 says the trail is append-only', n)); end if;
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  begin
    delete from public.wallet_audit_logs where id = genuine;
    get diagnostics n = row_count;
    if n <> 0 then failures := array_append(failures, format('a child DELETED %s money-audit row(s) — 0224 has regressed', n)); end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. Reads stay open to the household, deliberately.
  select count(*) into n from public.wallet_audit_logs where id = genuine;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ the money trail — /wallet renders it for whoever is signed in; that is a change of decision, not this migration''s');
  end if;

  -- 7. The grant layer, which a `to authenticated` policy cannot reach.
  perform set_config('role','postgres', true);
  if has_table_privilege('anon', 'public.wallet_audit_logs', 'INSERT') then
    failures := array_append(failures, 'anon holds INSERT on wallet_audit_logs');
  end if;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Put 0224's policy back exactly as it was written, and require the forgery
  -- to work again. The outer rollback undoes this along with everything else.
  drop policy if exists wallet_audit_logs_insert on public.wallet_audit_logs;
  create policy wallet_audit_logs_insert on public.wallet_audit_logs
    for insert to authenticated with check (public.is_family_member(family_id));

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
      values (fam, parent_u, 'funds_added', 'child_wallets', 'Added 50000 cents');
  exception when insufficient_privilege then
    failures := array_append(failures, 'with 0224''s policy alone the child STILL could not sign a row as the parent — this probe is decoration, not a boundary');
  end;

  perform set_config('role','postgres', true);
  select count(*) into n from public.wallet_audit_logs
   where family_id = fam and actor_user_id = parent_u and detail = 'Added 50000 cents';
  if n = 0 then
    failures := array_append(failures, 'with the pin removed no forged row landed — this probe has never been shown to fail');
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'the wallet audit trail is not authentic:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'wallet-audit-actor: OK (a member appends only as themselves, nobody signs for anyone else, no actor-less client rows, the trail stays append-only and household-readable, anon holds no INSERT, negative control reproduced the forgery)';
end $$;

rollback;

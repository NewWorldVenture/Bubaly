-- ── A child cannot repoint a Pay-ID or author a savings goal (0324) ────────
--
-- `pay_handles` and `wallet_goals` are two more of the fourteen tables
-- 0088_family_wallet.sql created in one DO loop with
--
--   FOR ALL TO authenticated USING (public.is_family_member(family_id))
--
-- `FOR ALL` covers INSERT, UPDATE and DELETE; `is_family_member` ignores role.
-- Both have server actions in app/(app)/wallet/actions.ts that open
-- `if (!isManager(ctx.active.role)) return …` — `claimPayHandleAction` and
-- `releasePayHandleAction`, `createGoalAction` and `fundGoalAction` — and a
-- server action is not a boundary against a JWT holder.
--
-- This probe is two proofs in one file because the two tables fail in the two
-- different ways this audit keeps finding.
--
-- ── the Pay-ID: a redirect an OUTSIDER follows ──────────────────────────────
-- app/pay/[handle]/page.tsx resolves /pay/<handle> with `createServiceClient()`
-- — RLS off, because the visitor is not signed in — reads `child_wallet_id` off
-- the row and redirects to that wallet's newest active gift link. So this probe
-- asserts BOTH halves: a child cannot repoint, deactivate, delete or plant a
-- handle, AND the service-role resolution the page performs still lands on the
-- right gift link. A guard that quietly broke /pay would be worse than the
-- defect.
--
-- ── the goal: a confused deputy with money at the end ───────────────────────
-- `wallet_fund_goal` (0208) is SECURITY DEFINER, checks `auth.uid() = p_actor_id
-- AND can_manage_family(p_family_id)` correctly, and then reads the goal row and
-- uses ITS OWN fields — `child_wallet_id` picks the Save bucket to debit, `title`
-- becomes the ledger description and the `wallet_audit_logs` line a parent reads.
-- So this probe reproduces the whole chain the way safety-record-write-check.sql
-- does for `guardian_suggestions`: the child cannot write `wallet_transactions`
-- (0217 holds), cannot author a goal aimed at a sibling's wallet, and with the
-- guard dropped the parent's own funding call drains the sibling's Save bucket.
--
-- Asserts, in both directions:
--
--   1. a child cannot repoint, deactivate, rename, delete or plant a Pay-ID;
--   2. a child cannot create a goal, inflate `saved_cents`, mark one 'reached',
--      or delete one;
--   3. the deputy chain is broken — with the child's goal refused, the only
--      goals that exist are the parent's;
--   4. a manager still can: claim a handle, create a goal and fund it through
--      `wallet_fund_goal`. A guard that refuses everyone is not a boundary;
--   5. /pay/<handle>'s service-role resolution still returns the right token;
--   6. a child CAN still read both tables — /wallet/goals and /wallet/gift
--      render from them for whoever is signed in, and narrowing SELECT is a
--      product decision nobody has taken. If that changes this line fails on
--      purpose;
--   7. UPDATE pins `family_id` on BOTH sides;
--   8. `anon` holds no INSERT — the 0324 guards are `TO authenticated` and a
--      restrictive policy only ANDs with requests made AS a role it names, so
--      for an anonymous request they are absent and the grant layer is all that
--      is left (0290's argument);
--   9. NEGATIVE CONTROL: drop the restrictive guards, leaving 0088's permissive
--      policy exactly as it was, and require the whole escalation to reproduce —
--      the repoint AND the parent-funded drain of the sibling's balance.
--
-- RLS is evaluated BEFORE a unique index, so an insert that reaches a constraint
-- violation is one RLS LET THROUGH; those are caught separately and reported as
-- breaches rather than swallowed.
--
--   PGHOST=… PGPORT=… PGUSER=… PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/pay-id-and-goal-write-check.sql

\set FP '00000000-0000-4000-8000-00000000da10'
\set FQ '00000000-0000-4000-8000-00000000da11'
\set UP '00000000-0000-4000-8000-00000000da12'
\set UK '00000000-0000-4000-8000-00000000da13'
\set UO '00000000-0000-4000-8000-00000000da14'

begin;

insert into auth.users (id, email) values (:'UP','p-parent@example.com') on conflict do nothing;
insert into auth.users (id, email) values (:'UK','p-kid@example.com')    on conflict do nothing;
insert into auth.users (id, email) values (:'UO','p-other@example.com')  on conflict do nothing;

insert into public.families (id, name, created_by) values (:'FP','Pay House',:'UP') on conflict do nothing;
insert into public.families (id, name, created_by) values (:'FQ','Other House',:'UO') on conflict do nothing;

-- Two children: the one holding the session, and the sibling whose money and
-- whose Pay-ID are the target.
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000da15',:'FP',:'UK','Kid','child',true) on conflict do nothing;
insert into public.family_members (id, family_id, user_id, display_name, role, is_active)
  values ('00000000-0000-4000-8000-00000000da16',:'FP',null,'Sibling','child',true) on conflict do nothing;
-- The creator is provisioned as a manager by on_family_created; make sure of it
-- rather than assuming, because a fixture whose roles are wrong proves nothing.
update public.family_members set role = 'parent' where family_id = :'FP' and user_id = :'UP';
update public.family_members set role = 'parent' where family_id = :'FQ' and user_id = :'UO';

insert into public.child_wallets (id, family_id, member_id, is_active)
  values ('00000000-0000-4000-8000-00000000da17',:'FP','00000000-0000-4000-8000-00000000da15',true) on conflict do nothing;
insert into public.child_wallets (id, family_id, member_id, is_active)
  values ('00000000-0000-4000-8000-00000000da18',:'FP','00000000-0000-4000-8000-00000000da16',true) on conflict do nothing;

-- The sibling's Save bucket, with 5000c actually in it.
insert into public.wallet_buckets (id, family_id, child_wallet_id, kind, label)
  values ('00000000-0000-4000-8000-00000000da19',:'FP','00000000-0000-4000-8000-00000000da18','save','Save') on conflict do nothing;
insert into public.wallet_transactions
  (id, family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, created_by)
  values ('00000000-0000-4000-8000-00000000da1a',:'FP','00000000-0000-4000-8000-00000000da18',
          '00000000-0000-4000-8000-00000000da19','parent_top_up','completed','credit',5000,'Birthday money',:'UP');

-- One gift link per wallet, so a repointed Pay-ID has somewhere wrong to go.
insert into public.gift_links (id, family_id, child_wallet_id, token, is_active)
  values ('00000000-0000-4000-8000-00000000da1b',:'FP','00000000-0000-4000-8000-00000000da18','gift_for_the_sibling_da1b',true);
insert into public.gift_links (id, family_id, child_wallet_id, token, is_active)
  values ('00000000-0000-4000-8000-00000000da1c',:'FP','00000000-0000-4000-8000-00000000da17','gift_for_the_kid_da1c',true);

-- The Pay-ID a grandparent was given, pointing at the sibling.
insert into public.pay_handles (id, family_id, child_wallet_id, handle, is_active, created_by)
  values ('00000000-0000-4000-8000-00000000da1d',:'FP','00000000-0000-4000-8000-00000000da18','siblingpay',true,:'UP');

-- A goal the parent made, for the sibling.
insert into public.wallet_goals (id, family_id, child_wallet_id, title, target_cents, saved_cents, status, created_by)
  values ('00000000-0000-4000-8000-00000000da1e',:'FP','00000000-0000-4000-8000-00000000da18','New trainers',5000,0,'active',:'UP');

grant select, insert, update, delete on public.pay_handles  to authenticated;
grant select, insert, update, delete on public.wallet_goals to authenticated;

do $$
declare
  n         int;
  res       jsonb;
  available bigint;
  token     text;
  failures  text[] := '{}';
  fam        constant uuid := '00000000-0000-4000-8000-00000000da10';
  other_fam  constant uuid := '00000000-0000-4000-8000-00000000da11';
  parent_u   constant uuid := '00000000-0000-4000-8000-00000000da12';
  kid_u      constant uuid := '00000000-0000-4000-8000-00000000da13';
  kid_w      constant uuid := '00000000-0000-4000-8000-00000000da17';
  sib_w      constant uuid := '00000000-0000-4000-8000-00000000da18';
  save_b     constant uuid := '00000000-0000-4000-8000-00000000da19';
  handle_id  constant uuid := '00000000-0000-4000-8000-00000000da1d';
  goal_id    constant uuid := '00000000-0000-4000-8000-00000000da1e';
  planted    uuid;
  t text;
  tbls constant text[] := array['pay_handles','wallet_goals'];
begin
  -- ── As the child ────────────────────────────────────────────────────────
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- The baseline the deputy depends on: the ledger itself is already closed
  -- (0217/0290). If this ever stops being true the goal chain below is not the
  -- interesting finding any more.
  begin
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
      values (fam, sib_w, save_b, 'adjustment', 'completed', 'credit', 100000, 'minted by the child');
    failures := array_append(failures, 'a child wrote the wallet LEDGER directly — 0217/0290 have regressed and this probe is measuring the wrong door');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s wallet_transactions INSERT reached a unique index, so RLS did not refuse it');
  end;

  -- 1. The Pay-ID. Repointing it sends the next grandparent who types
  --    /pay/siblingpay to the child's own gift link.
  update public.pay_handles set child_wallet_id = kid_w where id = handle_id;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child REPOINTED %s Pay-ID(s) at their own wallet — an outsider following the sibling''s Pay ID would fund the child', n)); end if;

  update public.pay_handles set is_active = false where id = handle_id;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DEACTIVATED %s Pay-ID(s) — the handle a family printed on a card stops resolving', n)); end if;

  update public.pay_handles set handle = 'notsiblingpay' where id = handle_id;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child RENAMED %s Pay-ID(s)', n)); end if;

  delete from public.pay_handles where id = handle_id;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child RELEASED %s Pay-ID(s) — a globally unique handle, freed for anyone on the platform to claim', n)); end if;

  begin
    insert into public.pay_handles (family_id, child_wallet_id, handle, is_active)
      values (fam, kid_w, 'kidclaimed', true);
    failures := array_append(failures, 'a child CLAIMED a Pay-ID pointing at their own wallet');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s pay_handles INSERT reached the unique index, so RLS did not refuse it');
  end;

  -- 2. The goal. The deputy setup: a goal aimed at the SIBLING's wallet, which
  --    `wallet_fund_goal` will believe when a parent funds it.
  begin
    insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents, status)
      values (fam, sib_w, 'Pay me back', 4000, 'active');
    failures := array_append(failures, 'a child AUTHORED a savings goal aimed at a sibling''s wallet — a parent funding it debits the sibling');
  exception
    when insufficient_privilege then null;
    when unique_violation then
      failures := array_append(failures, 'a child''s wallet_goals INSERT reached a unique index, so RLS did not refuse it');
  end;

  update public.wallet_goals set saved_cents = 5000, status = 'reached' where id = goal_id;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child marked %s goal(s) reached without a penny moving', n)); end if;

  update public.wallet_goals set child_wallet_id = kid_w, title = 'Something else' where id = goal_id;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child RETARGETED %s goal(s) — the next parent funding it debits whoever the child chose', n)); end if;

  delete from public.wallet_goals where id = goal_id;
  get diagnostics n = row_count;
  if n <> 0 then failures := array_append(failures, format('a child DELETED %s savings goal(s)', n)); end if;

  -- 3. Reads stay open, deliberately. Recorded so the decision is visible.
  select count(*) into n from public.wallet_goals where id = goal_id;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ savings goals — that is a change of decision; update finalaudit.md and this probe');
  end if;
  select count(*) into n from public.pay_handles where id = handle_id;
  if n = 0 then
    failures := array_append(failures, 'a child can no longer READ Pay-IDs — that is a change of decision; update finalaudit.md and this probe');
  end if;

  -- 4. The goal row the parent is about to fund must still be the parent's own.
  select count(*) into n from public.wallet_goals
   where family_id = fam and child_wallet_id = sib_w and created_by is distinct from parent_u;
  if n <> 0 then
    failures := array_append(failures, format('%s goal(s) aimed at the sibling''s wallet were not authored by the parent', n));
  end if;

  -- ── As the parent: the positive control, including the definer RPC ──────
  perform set_config('request.jwt.claim.sub', parent_u::text, true);

  begin
    insert into public.pay_handles (family_id, child_wallet_id, handle, is_active, created_by)
      values (fam, kid_w, 'kidpay', true, parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not claim a Pay-ID — the guard refuses everyone');
  end;

  update public.pay_handles set is_active = true, child_wallet_id = sib_w where id = handle_id;
  get diagnostics n = row_count;
  if n <> 1 then failures := array_append(failures, 'a MANAGER could not update a Pay-ID'); end if;

  begin
    insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents, created_by)
      values (fam, sib_w, 'Parent''s goal', 1000, parent_u);
  exception when insufficient_privilege then
    failures := array_append(failures, 'a MANAGER could not create a savings goal');
  end;

  -- The real funding path: SECURITY DEFINER, manager-checked, ledger-writing.
  select public.wallet_fund_goal(fam, goal_id, 1000, parent_u) into res;
  if coalesce((res->>'ok')::boolean, false) is not true then
    failures := array_append(failures, format('a MANAGER could not fund a savings goal through wallet_fund_goal: %s', res));
  end if;

  -- ── The WITH CHECK half: a manager may not relocate a row ───────────────
  begin
    update public.pay_handles set family_id = other_fam where id = handle_id;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, 'a manager MOVED a Pay-ID into another family — WITH CHECK is missing');
    end if;
  exception when insufficient_privilege then null;
  end;

  begin
    update public.wallet_goals set family_id = other_fam where id = goal_id;
    get diagnostics n = row_count;
    if n <> 0 then
      failures := array_append(failures, 'a manager MOVED a savings goal into another family — WITH CHECK is missing');
    end if;
  exception when insufficient_privilege then null;
  end;

  -- ── /pay/<handle> still resolves, on the service role, to the RIGHT link ─
  -- The exact shape app/pay/[handle]/page.tsx runs: read the handle with RLS
  -- off, then the newest active gift link for that wallet.
  perform set_config('role','postgres', true);
  select gl.token into token
    from public.pay_handles ph
    join public.gift_links gl
      on gl.family_id = ph.family_id and gl.is_active and gl.child_wallet_id = ph.child_wallet_id
   where ph.handle = 'siblingpay' and ph.is_active
   order by gl.created_at desc
   limit 1;
  if token is distinct from 'gift_for_the_sibling_da1b' then
    failures := array_append(failures,
      format('/pay/siblingpay resolved to %L instead of the sibling''s gift link — the guard broke the public resolver', token));
  end if;

  -- ── The grant layer, which `to authenticated` guards cannot reach ───────
  foreach t in array tbls loop
    if has_table_privilege('anon', 'public.' || t, 'INSERT') then
      failures := array_append(failures,
        format('anon holds INSERT on %s — the 0324 guards are `to authenticated` and would not apply', t));
    end if;
  end loop;

  -- ── Negative control: prove this probe can SEE the defect ──────────────
  -- Drop only the restrictive guards. 0088's permissive "Members manage …"
  -- policies are left exactly as they were, which is precisely the pre-0324
  -- state. The whole escalation must reproduce. The outer rollback undoes this
  -- along with everything else.
  foreach t in array tbls loop
    execute format('drop policy if exists %I on public.%I', t || '_manager_insert_guard', t);
    execute format('drop policy if exists %I on public.%I', t || '_manager_update_guard', t);
    execute format('drop policy if exists %I on public.%I', t || '_manager_delete_guard', t);
  end loop;

  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);

  -- (a) the Pay-ID repoint, end to end through the public resolver.
  update public.pay_handles set child_wallet_id = kid_w where id = handle_id;
  get diagnostics n = row_count;
  if n = 0 then
    failures := array_append(failures, 'with 0088''s policy alone the child STILL could not repoint a Pay-ID — this probe is decoration, not a boundary');
  end if;

  -- (b) the goal the parent is about to fund, authored by the child.
  insert into public.wallet_goals (family_id, child_wallet_id, title, target_cents, status, created_by)
    values (fam, sib_w, 'Pay me back', 4000, 'active', kid_u)
    returning id into planted;
  if planted is null then
    failures := array_append(failures, 'with 0088''s policy alone the child STILL could not author a goal — the deputy assertion above is decoration');
  end if;

  perform set_config('role','postgres', true);
  select gl.token into token
    from public.pay_handles ph
    join public.gift_links gl
      on gl.family_id = ph.family_id and gl.is_active and gl.child_wallet_id = ph.child_wallet_id
   where ph.handle = 'siblingpay' and ph.is_active
   order by gl.created_at desc
   limit 1;
  if token is distinct from 'gift_for_the_kid_da1c' then
    failures := array_append(failures,
      format('with the guard removed /pay/siblingpay did NOT reroute to the child (got %L) — the redirect half has never been shown to fail', token));
  end if;

  -- (c) the parent funds in good faith, and the SIBLING's Save bucket drains.
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', parent_u::text, true);
  select public.wallet_fund_goal(fam, planted, 4000, parent_u) into res;

  perform set_config('role','postgres', true);
  select coalesce(sum(case when direction = 'credit' then amount_cents else -amount_cents end), 0)
    into available
    from public.wallet_transactions
   where family_id = fam and bucket_id = save_b and status = 'completed';
  if available <> 0 then
    failures := array_append(failures,
      format('with the guard removed the parent''s funding did NOT drain the sibling (Save left at %sc, fund said %s) — this probe has never been shown to fail', available, res));
  end if;

  if array_length(failures, 1) is not null then
    raise exception E'Pay-IDs and savings goals are not manager-written:\n  - %', array_to_string(failures, E'\n  - ');
  end if;
  raise notice 'pay-id-and-goal-write: OK (child blocked on both tables, manager allowed incl. wallet_fund_goal, /pay resolves to the right link, family_id pinned, anon holds no INSERT, negative control reproduced the repoint AND the sibling''s drained balance)';
end $$;

rollback;

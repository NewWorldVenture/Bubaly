-- A row's references must live in the row's own family.
--
-- Every family-scoped INSERT policy here checks the row's OWN `family_id` and
-- nothing else, and the foreign keys beside them name `parent(id)` alone —
-- because that is the parent's primary key. So a member may write a row
-- carrying THEIR family_id and a reference into SOMEBODY ELSE'S family, and
-- both the policy and the constraint are satisfied.
--
-- The repo already knows the class; lib/services/tasks/index.ts guards one
-- instance by hand: "Confirm the chore belongs to this family before writing an
-- assignment that would otherwise carry a foreign family's chore_id under our
-- family_id." Application code is not a boundary for anyone calling PostgREST.
--
-- Reads are NOT the issue and the probe asserts that too: A still cannot SELECT
-- B's chore. What this reaches is the code that ACTS on the reference — above
-- all the nightly allowance cron, which credits `rule.child_wallet_id`.
--
-- Judged on ROW COUNTS: an insert refused by nothing simply lands, and an
-- exception-only assertion would report a boundary that is not there.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  famA uuid := '00000000-0000-4000-8000-00000000fa01';
  famB uuid := '00000000-0000-4000-8000-000000005c01';
  uA uuid := '00000000-0000-4000-8000-00000000fa0a';
  uB uuid := '00000000-0000-4000-8000-00000000fb0b';
  midA uuid; midB uuid;
  choreA uuid; choreB uuid;
  walletA uuid; walletB uuid;
  n int;
  failures int := 0;
begin
  delete from public.allowance_rules where family_id in (famA, famB);
  delete from public.chore_assignments where family_id in (famA, famB);
  delete from public.chores where family_id in (famA, famB);

  insert into auth.users (id, email) values
    (uA, 'xfam-a@example.com'), (uB, 'xfam-b@example.com') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values
    (famA, 'Family A', uA), (famB, 'Family B', uB) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (famA, uA, 'Parent A', 'parent', true),
    (famB, uB, 'Parent B', 'parent', true) on conflict do nothing;
  select id into midA from public.family_members where family_id = famA and user_id = uA;
  select id into midB from public.family_members where family_id = famB and user_id = uB;

  insert into public.chores (family_id, title, points) values (famA, 'A chore', 1) returning id into choreA;
  insert into public.chores (family_id, title, points) values (famB, 'B chore', 1) returning id into choreB;

  select id into walletA from public.child_wallets where family_id = famA limit 1;
  if walletA is null then
    insert into public.child_wallets (family_id, member_id) values (famA, midA) returning id into walletA;
  end if;
  select id into walletB from public.child_wallets where family_id = famB limit 1;
  if walletB is null then
    insert into public.child_wallets (family_id, member_id) values (famB, midB) returning id into walletB;
  end if;

  -- ── as family A's parent ─────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uA::text, true);
  set local role authenticated;

  if not public.can_manage_family(famA) then
    raise exception 'CONTROL FAILED: not acting as a manager of family A';
  end if;
  if public.is_family_member(famB) then
    raise exception 'CONTROL FAILED: acting as a member of family B, so nothing below is a boundary';
  end if;

  -- 1. A's own work still writes — the positive control. A guard on the
  --    reference rather than on the row would fail here, and every refusal
  --    below would mean nothing.
  begin
    insert into public.chore_assignments (family_id, chore_id, member_id, status)
      values (famA, choreA, midA, 'todo');
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not assign their own chore (rows: %)', n;
      failures := failures + 1;
    end if;
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on)
      values (famA, walletA, 500, 'weekly', true, current_date);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not set their own allowance rule (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not do their own family''s work (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. But not an assignment pointing at another family's chore. This is the
  --    instance lib/services/tasks/index.ts guards by hand in the app.
  begin
    insert into public.chore_assignments (family_id, chore_id, member_id, status)
      values (famA, choreB, midA, 'todo');
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: an assignment under A points at B''s chore (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Nor one assigned to another family's member.
  begin
    insert into public.chore_assignments (family_id, chore_id, member_id, status)
      values (famA, choreA, midB, 'todo');
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: an assignment under A names B''s member (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Nor an allowance rule pointing at another family's wallet. The nightly
  --    cron credits this column.
  begin
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on)
      values (famA, walletB, 500, 'weekly', true, current_date);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: an allowance rule under A pays into B''s wallet (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Nor by writing a clean row and then re-pointing it.
  begin
    update public.allowance_rules set child_wallet_id = walletB where family_id = famA;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: an allowance rule under A was re-pointed at B''s wallet (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. Reads were never the hole, and must not become one: A still cannot see
  --    B's chore. Asserted so a future "fix" cannot widen a SELECT to make the
  --    joins above resolve.
  select count(*) into n from public.chores where id = choreB;
  if n <> 0 then
    raise warning 'BREACH: family A can read family B''s chore (rows: %)', n;
    failures := failures + 1;
  end if;

  -- 7. And A's own allowance rule still points where A put it.
  select count(*) into n from public.allowance_rules where family_id = famA and child_wallet_id = walletA;
  if n <> 1 then
    raise warning 'BREACH: family A''s own allowance rule is no longer intact (rows: %)', n;
    failures := failures + 1;
  end if;

  reset role;

  if failures > 0 then
    raise exception 'cross-family-reference: % assertion(s) failed', failures;
  end if;
  raise notice 'cross-family-reference: OK — a family may reference its own rows, and only its own';
end
$probe$;

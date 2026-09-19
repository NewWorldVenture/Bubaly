-- A chore is paid once, and the database is what says so.
--
-- `payChoreRewardAction` states the invariant in its own comment — "one wallet
-- credit per assignment" — and enforced it with a SELECT followed by an INSERT.
-- Nothing in the schema backed it. Two "Pay" clicks arriving together both read
-- zero rows and both credit the child's wallet.
--
-- This probe does not simulate a race. It asserts the thing a race would need:
-- that the ledger REFUSES a second credit for the same assignment and bucket.
-- Before 0316 it accepted one, which is the whole finding.
--
-- It also pins the two things that make the obvious index wrong, because both
-- would break a working feature rather than merely fail to fix this one:
--
--   * an allowance rule credits the SAME related_id every week, so uniqueness
--     must not extend to related_type = 'allowance_rules';
--   * creditChildWallet writes one row PER BUCKET for a single credit, all
--     sharing related_id, so bucket_id has to be part of the key or the FIRST
--     payout is rejected.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-0000000c6a01';
  u      uuid := '00000000-0000-4000-8000-0000000c6a0a';
  member uuid; wallet uuid; spend uuid; save uuid; rule uuid; assignment uuid;
  n int;
  failures int := 0;
begin
  delete from public.wallet_transactions where family_id = fam;
  delete from public.wallet_buckets where family_id = fam;
  delete from public.allowance_rules where family_id = fam;
  delete from public.child_wallets where family_id = fam;

  insert into auth.users (id, email) values (u, 'chore-pay@example.com') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Payout family', u) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
    values (fam, u, 'Parent', 'parent', true) on conflict do nothing;
  select id into member from public.family_members where family_id = fam and user_id = u;

  insert into public.child_wallets (family_id, member_id) values (fam, member) returning id into wallet;
  insert into public.wallet_buckets (family_id, child_wallet_id, kind, label) values (fam, wallet, 'spend', 'Spend') returning id into spend;
  insert into public.wallet_buckets (family_id, child_wallet_id, kind, label) values (fam, wallet, 'save', 'Save') returning id into save;

  assignment := gen_random_uuid();

  -- 1. The first payout lands — and it is FOUR rows in real life, one per
  --    bucket, all carrying the same related_id. Two buckets is enough to show
  --    that a key without bucket_id would reject the first payout outright.
  begin
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, related_type, related_id)
    values
      (fam, wallet, spend, 'chore_reward', 'completed', 'credit', 1600, 'Chore: dishes', 'chore_assignments', assignment),
      (fam, wallet, save,  'chore_reward', 'completed', 'credit', 1600, 'Chore: dishes', 'chore_assignments', assignment);
    get diagnostics n = row_count;
    if n <> 2 then
      raise warning 'CONTROL FAILED: the first chore payout did not land (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: the first chore payout was refused (% %) — a key without bucket_id does this', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. The second payout for the same assignment must be refused.
  begin
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, related_type, related_id)
    values
      (fam, wallet, spend, 'chore_reward', 'completed', 'credit', 1600, 'Chore: dishes', 'chore_assignments', assignment),
      (fam, wallet, save,  'chore_reward', 'completed', 'credit', 1600, 'Chore: dishes', 'chore_assignments', assignment);
    raise warning 'BREACH: the same chore was credited to the wallet twice';
    failures := failures + 1;
  exception when unique_violation then null;
  end;

  -- 3. And the refusal must be total: no half-credited wallet. The rows of one
  --    credit go in as a single statement, so the bucket that did NOT collide
  --    must not have landed either.
  select count(*) into n from public.wallet_transactions
    where family_id = fam and related_id = assignment;
  if n <> 2 then
    raise warning 'BREACH: % ledger row(s) for one chore payout, expected 2', n;
    failures := failures + 1;
  end if;

  -- 4. Control: a DIFFERENT assignment still pays. A guard that refused every
  --    second chore would pass assertion 2 and be useless.
  begin
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, related_type, related_id)
    values (fam, wallet, spend, 'chore_reward', 'completed', 'credit', 500, 'Chore: bins', 'chore_assignments', gen_random_uuid());
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a different chore could not be paid (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a different chore could not be paid (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 5. Control: an ALLOWANCE rule credits the same related_id every week, and
  --    must keep doing so. This is the assertion that stops the index from
  --    being widened to every related_type.
  insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on)
    values (fam, wallet, 500, 'weekly', true, current_date) returning id into rule;
  begin
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, related_type, related_id)
    values
      (fam, wallet, spend, 'allowance', 'completed', 'credit', 500, 'Allowance week 1', 'allowance_rules', rule),
      (fam, wallet, spend, 'allowance', 'completed', 'credit', 500, 'Allowance week 2', 'allowance_rules', rule),
      (fam, wallet, spend, 'allowance', 'completed', 'credit', 500, 'Allowance week 3', 'allowance_rules', rule);
    get diagnostics n = row_count;
    if n <> 3 then
      raise warning 'CONTROL FAILED: a weekly allowance could not credit the same rule repeatedly (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: the index broke recurring allowances (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 6. Control: a debit carrying no related_id at all (a spend request) is
  --    outside the partial index and unaffected.
  begin
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, related_type)
    values
      (fam, wallet, spend, 'card_spend', 'completed', 'debit', 100, 'Snack', 'spend_request'),
      (fam, wallet, spend, 'card_spend', 'completed', 'debit', 100, 'Snack again', 'spend_request');
    get diagnostics n = row_count;
    if n <> 2 then
      raise warning 'CONTROL FAILED: spend requests were affected (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: spend requests were affected (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  delete from public.wallet_transactions where family_id = fam;
  delete from public.allowance_rules where family_id = fam;
  delete from public.wallet_buckets where family_id = fam;
  delete from public.child_wallets where family_id = fam;

  if failures > 0 then
    raise exception '0316 FAILED: % assertion(s)', failures;
  end if;
  raise notice '0316 OK: a chore is paid once (6 assertions)';
end
$probe$;

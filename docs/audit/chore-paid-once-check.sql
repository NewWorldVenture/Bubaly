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
--
-- NEGATIVE CONTROL, and it runs FIRST, before the refusal it gives meaning to
-- ---------------------------------------------------------------------------
-- The mechanism under test is a UNIQUE INDEX, not a policy. `0316_a_chore_is_
-- paid_once.sql` creates `uq_wallet_txn_chore_payout` on
-- `(family_id, related_id, bucket_id) where related_type = 'chore_assignments'
-- and related_id is not null and bucket_id is not null`, and 0316 is the LAST
-- migration that names it — it is the only one: `grep -rn
-- uq_wallet_txn_chore_payout supabase/migrations` returns 0316's `create unique
-- index` and 0316's `comment on index`, and nothing after it drops, replaces or
-- re-predicates the index. 0342 independently read the replayed database and
-- recorded the same shape: "the only partial unique index on
-- `wallet_transactions` is `uq_wallet_txn_chore_payout` (0316)", and "the only
-- non-internal trigger on the table is `trg_wallet_transactions_updated_at`".
--
-- So the usual false-green is NOT the one available here. This probe never
-- switches role — it runs as the replay superuser, and no migration sets FORCE
-- ROW LEVEL SECURITY — so a revoked GRANT, a column denial, a dead `auth.uid()`
-- or a loosened policy cannot make it pass. What CAN is a DIFFERENT constraint
-- answering in the index's place, and assertion 2 catches bare
-- `unique_violation`, which does not say which one.
--
-- The control is therefore the same shape as the RLS probes' — the same actor,
-- the same statement, the one thing the mechanism keys on changed, and it MUST
-- LAND. The mechanism keys on `related_id`, so the control issues the write
-- under test TWICE, byte-for-byte identical in all ten columns except
-- `related_id`. Both payouts must store their two rows.
--
-- What that would catch, and nothing below it does: assertion 4 is the closest
-- thing this probe had to a related_id control and it is not a minimal pair —
-- it changes `amount_cents` (500 vs 1600), `description` ('Chore: bins' vs
-- 'Chore: dishes') and the row count as well as `related_id`. So a unique index
-- on, say, `(family_id, bucket_id, description)` — or on
-- `(family_id, bucket_id, type, amount_cents)`, or a guard trigger refusing a
-- repeated description in a bucket, which is how this repository refuses writes
-- in 0223, 0305, 0326 and 0331 — refuses assertion 2 with `unique_violation`
-- and sails past 1, 4, 5 and 6: the two rows of assertion 1 differ in bucket,
-- assertion 4 renames, assertion 5's three weeks are 'Allowance week 1/2/3' and
-- assertion 6's two debits are 'Snack' and 'Snack again'. Under any of those
-- `uq_wallet_txn_chore_payout` could be absent from the database entirely and
-- this probe would still print OK. The control changes ONLY related_id, so a
-- constraint keyed on anything else refuses its second payout and the probe
-- goes red as UNPROVEN, which is the honest verdict.
--
-- The column list being identical is load-bearing for the same reason it is in
-- child-login-mapping-is-managers-only-check.sql: a mechanism keyed on a column
-- the control does not write is invisible to the control. Ten columns for ten,
-- same values, one field moved.
--
-- Assertion 2's handler now also reads CONSTRAINT_NAME off the refusal, so the
-- probe names the index that spoke. It complains only when a name is present
-- and is the wrong one — an engine that reports no name leaves the check inert
-- rather than red, because a control that flags a healthy database is worse
-- than no control.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam    uuid := '00000000-0000-4000-8000-0000000c6a01';
  u      uuid := '00000000-0000-4000-8000-0000000c6a0a';
  -- The negative control's two assignments. Anchored rather than
  -- gen_random_uuid() so a failure names a value a reader can grep for, in this
  -- probe's own c6a block; both were grepped across docs/audit and
  -- supabase/migrations and appear nowhere else, which matters because
  -- run-probes.sh runs all 65 probes against one database in sequence.
  ctl_a1 uuid := '00000000-0000-4000-8000-0000000c6a21';
  ctl_a2 uuid := '00000000-0000-4000-8000-0000000c6a22';
  member uuid; wallet uuid; spend uuid; save uuid; rule uuid; assignment uuid;
  n int;
  failures int := 0;
  control_ok boolean := true;
  ctl_why text := '';
  bad_constraint text;
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

  -- 0. NEGATIVE CONTROL: the same session, the same statement, the one thing
  --    the index keys on changed — and it must LAND, twice.
  --
  --    Two chore payouts that are identical in all ten columns except
  --    `related_id`. The second is the discriminating leg: it is issued with a
  --    row already present that matches it on family_id, child_wallet_id,
  --    bucket_id, type, status, direction, amount_cents, description and
  --    related_type, and differs only where `uq_wallet_txn_chore_payout` keys.
  --    If it lands, assertion 2's refusal below is attributable to related_id.
  --    If it is refused, something OTHER than 0316's key is refusing — a
  --    constraint on description or amount, a guard trigger — and assertion 2
  --    would keep passing with the index dropped. The probe then reports the
  --    boundary UNPROVEN rather than reporting it holds.
  begin
    insert into public.wallet_transactions
      (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, related_type, related_id)
    values
      (fam, wallet, spend, 'chore_reward', 'completed', 'credit', 1600, 'Chore: dishes', 'chore_assignments', ctl_a1),
      (fam, wallet, save,  'chore_reward', 'completed', 'credit', 1600, 'Chore: dishes', 'chore_assignments', ctl_a1);
    get diagnostics n = row_count;
    if n <> 2 then
      control_ok := false;
      ctl_why := format('the control''s FIRST chore payout stored %s row(s) instead of 2, so this session never had the write access assertion 2''s refusal is supposed to be measuring', n);
    end if;
  exception when others then
    control_ok := false;
    ctl_why := format('the control''s FIRST chore payout was refused (%s: %s), so this session never had the write access assertion 2''s refusal is supposed to be measuring', sqlstate, sqlerrm);
  end;

  if control_ok then
    begin
      insert into public.wallet_transactions
        (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description, related_type, related_id)
      values
        (fam, wallet, spend, 'chore_reward', 'completed', 'credit', 1600, 'Chore: dishes', 'chore_assignments', ctl_a2),
        (fam, wallet, save,  'chore_reward', 'completed', 'credit', 1600, 'Chore: dishes', 'chore_assignments', ctl_a2);
      get diagnostics n = row_count;
      if n <> 2 then
        control_ok := false;
        ctl_why := format('a SECOND chore payout differing from the first in related_id ALONE stored %s row(s) instead of 2 — whatever refuses a repeat here is not keyed on related_id, so assertion 2 below proves nothing about uq_wallet_txn_chore_payout', n);
      end if;
    exception when others then
      control_ok := false;
      ctl_why := format('a SECOND chore payout differing from the first in related_id ALONE was refused (%s: %s) — whatever refused it is keyed on something other than related_id (description, amount, type, or a guard trigger), so assertion 2 below would pass with uq_wallet_txn_chore_payout dropped', sqlstate, sqlerrm);
    end;
  end if;

  -- The control's rows do not outlive the control. Assertions 1-3 count by
  -- related_id and so cannot see them, but a stray pair of chore credits in a
  -- family later probes also touch is exactly the quiet contamination that turns
  -- one unattributed check into one false failure somewhere else, and the
  -- cleanup at the foot of this block does not run on the paths that raise.
  delete from public.wallet_transactions
    where family_id = fam and related_id in (ctl_a1, ctl_a2);

  -- A failed control makes assertion 2's refusal unreadable. Say WHY the probe
  -- cannot speak, here, while the reason is still in hand. The boundary is not
  -- reported as holding and not reported as broken: it is reported as unproven,
  -- and the build is red either way.
  if not control_ok then
    raise exception '0316 UNPROVEN (the control this probe rests on did not hold): %', ctl_why;
  end if;

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
  exception when unique_violation then
    -- Name the index that spoke. Postgres reports the violated index as the
    -- constraint on a unique-index violation, so this is the last mile of the
    -- attribution the control above establishes. Inert when no name is
    -- reported — a check that reddens a healthy database is worse than none.
    get stacked diagnostics bad_constraint = constraint_name;
    if bad_constraint is not null and bad_constraint <> ''
       and bad_constraint <> 'uq_wallet_txn_chore_payout' then
      raise warning 'CONTROL FAILED: the second payout was refused by "%", not by uq_wallet_txn_chore_payout — the chore-once index is not what is holding this line', bad_constraint;
      failures := failures + 1;
    end if;
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
  raise notice '0316 OK: the same statement with related_id ALONE changed still pays (control), and a chore is paid once (6 assertions)';
end
$probe$;

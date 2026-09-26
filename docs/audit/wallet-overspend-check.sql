-- ── A-08 Wallet money-safety probe (PAY-1 overspend prevention) ──────────────
-- Proves wallet_reserve_card_auth() cannot approve card authorizations beyond a
-- child's spendable balance, is idempotent per authorization id, and counts a
-- pending hold against the balance (so concurrent auths serialize under its
-- FOR UPDATE lock). Self-contained: funds a fresh $10 spend bucket for the
-- anchor family, runs a fixed auth sequence, and RAISE EXCEPTIONs on any breach.
--
-- Fronted by a NEGATIVE CONTROL that runs first: the same actor, the same
-- function, the same FIVE calls the probe makes — same amounts, same auth-id
-- pattern, same order, so the two calls the probe expects DECLINES for sit at
-- the same position in the same sequence — in a wallet funded $20 instead of
-- $10, so all five must APPROVE. Without it a decline is just `false`, and
-- `false` is this function's answer to more than one question. See the block
-- inside.
--
-- Closed by a BODY PIN: the function every verdict in this file was rendered on
-- is compared, by md5 of pg_proc.prosrc, to the body 0155 installs. The sibling
-- probe wallet-concurrency-check.sql redefines this exact function live
-- (committed, with the FOR UPDATE removed) and runs immediately before this file;
-- if its restore ever fails, the pin is what stops A-08 printing PASS over the
-- wrong body. See "WHICH BODY" inside.
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/wallet-overspend-check.sql

do $$
declare
  v_family  uuid := '00000000-0000-4000-8000-0000000000f1';
  v_member  uuid;
  v_wallet  uuid := 'd0000000-0000-4000-8000-0000000000a8';
  v_bucket  uuid;
  r boolean;
  holds int;
  spendable bigint;
  -- ── The negative control's own, well-funded child ──────────────────────────
  -- Same anchor family, same UUID style as v_wallet/v_member above, suffix d8
  -- instead of a8. Both full UUIDs are unused across docs/audit and
  -- supabase/migrations (checked — `grep -rn 0000000000d8` finds only the
  -- 00000000-prefixed profile id in guardian-safety-config-…-check.sql, a
  -- different UUID), because run-probes.sh drives every docs/audit/*-check.sql
  -- through ONE database in sequence and a reused anchor silently rewrites some
  -- other probe's premise.
  c_member  uuid := 'e0000000-0000-4000-8000-0000000000d8';
  c_wallet  uuid := 'd0000000-0000-4000-8000-0000000000d8';
  c_bucket  uuid;
  c_holds   int;
  c_held    bigint;
  control_ok boolean := true;
  failures  text[] := '{}';
  -- ── The body under test, pinned ────────────────────────────────────────────
  -- md5 of 0155's dollar-quoted function body — the text supabase/migrations/
  -- 0155_wallet_auth_holds.sql puts between its `as` delimiter and the closing
  -- one, which is exactly what lands in pg_proc.prosrc — and identical to
  -- `select md5(prosrc) from pg_proc where oid = 'public.wallet_reserve_card_
  -- auth(uuid,uuid,bigint,text,text)'::regprocedure` on the replayed database
  -- (checked both ways). If 0155 is ever changed on purpose, read the new body,
  -- then recompute the pin with that query and update this line; the pin firing
  -- is the reminder to do so. (No literal double-dollar appears in this comment
  -- on purpose: it would end the block it sits in.)
  pinned_body_md5 constant text := '84527b8413ddea6ddbcfd16abf4e1b34';
  fn_under_test   constant text := 'public.wallet_reserve_card_auth(uuid, uuid, bigint, text, text)';
  body_at_start text;
  body_at_end   text;
begin
  -- Read — not yet judge — the body this run is about to measure. The judgement
  -- is the LAST assertion in the file, deliberately: a loosened guard is then
  -- still reported by the step that watched it approve, not by a checksum, and
  -- the control below stays the first thing that can fail. See "WHICH BODY".
  select p.prosrc into body_at_start
    from pg_proc p
   where p.oid = to_regprocedure(fn_under_test);

  -- ══ NEGATIVE CONTROL — IT RUNS FIRST, before the declines it gives meaning ══
  --
  -- MECHANISM, and how I know. This boundary is NOT RLS. `wallet_reserve_card_
  -- auth` is `security definer` (0155), and this probe runs as `postgres`, so
  -- every policy on wallet_transactions is bypassed twice over; nothing in
  -- 0217/0254/0275/0290 is under test here. Nor is it a constraint, an index or
  -- a trigger — each read off the replayed database's catalogs, not off a grep:
  --
  --   * the only CHECK on the ledger is `amount_cents >= 0` (0088) — the sign
  --     lives in `direction`, so a negative balance is perfectly representable;
  --   * the only unique index on the table besides the primary key is
  --     `uq_wallet_txn_chore_payout` (0316), partial `where related_type =
  --     'chore_assignments'`, which a card hold never sets;
  --   * the only non-internal trigger on the table is `trg_wallet_transactions_
  --     updated_at`, BEFORE UPDATE, `set_updated_at()` — attached by 0088's
  --     FOREACH loop over the wallet tables through `EXECUTE format(...)`, which
  --     is why `grep 'create trigger'` never finds it (an earlier version of
  --     this header said no trigger existed at all, on the strength of that
  --     grep). It never fires on the INSERT a hold makes. Nor could an INSERT-
  --     time guard trigger have produced what this probe observes: an exception
  --     out of the definer function makes `r := …` error, not return `false`,
  --     and a BEFORE INSERT returning NULL leaves the function returning `true`.
  --
  -- What enforces the invariant is a guard INSIDE the function: it takes FOR
  -- UPDATE on the child's `spend` bucket, totals `status in ('completed',
  -- 'processing')` in that lock, and `return false` when `p_amount >
  -- v_spendable`. That is the predicate under test.
  --
  -- WHICH BODY. `grep -rl wallet_reserve_card_auth supabase/migrations` returns
  -- exactly two files, and 0342 only NAMES it in prose (it creates `wallet_
  -- debit_spend_bucket`, modelled on it), so 0155 is the first and the LAST
  -- MIGRATION to define it. That was checked rather than assumed, because 0297
  -- re-created a policy on a different predicate than 0105 had and this audit
  -- once credited the old one — and then this file made the same mistake one
  -- directory over. The corpus-wide grep returns a third definer: docs/audit/
  -- wallet-concurrency-check.sql does `create or replace function public.
  -- wallet_reserve_card_auth` with the FOR UPDATE removed, COMMITTED (its racing
  -- sessions have to see it), and restores the saved body in a later top-level
  -- statement. It sorts immediately before this file in run-probes.sh's glob,
  -- and run-probes.sh runs every probe even after one fails. So if its restore
  -- assertion ever fires, the body this probe measures is the unlocked one —
  -- whose balance predicate is byte-identical, so every step and every control
  -- leg below stays green while this header's "serialize under its FOR UPDATE
  -- lock" is quietly false. The pin at the end of the block closes that: the
  -- body measured must be 0155's, compared by md5 of pg_proc.prosrc and NOT by
  -- `prosrc ilike '%for update%'`, which the neutered body satisfies through a
  -- comment reading "THE GUARD, REMOVED: no `for update`" (the sibling probe
  -- records having been defeated by exactly that).
  --
  -- WHAT THE CONTROL IS. The one thing the guard keys on is the spendable total
  -- in the bucket, so the control is the same actor (`postgres`, through the
  -- same definer function), the same five statements, the same AMOUNTS, in the
  -- same ORDER, with the same auth-id pattern — in a wallet funded $20 instead
  -- of $10, so the answer comes out the other way. All five calls must APPROVE.
  --
  -- WHAT IT WOULD CATCH. The declines below are a bare `false`, and `false` is
  -- the function's answer to more than one question. Note carefully that every
  -- approval this probe already asserts is at a DIFFERENT point in the hold
  -- sequence than the decline it is paired with: step 1 approves $8 with no
  -- hold open, step 2 declines $8 with one hold open; step 4 approves $2 as the
  -- second hold, step 5 declines $1 as the third. So the existing assertions
  -- cannot tell the balance guard apart from any refusal keyed on the SHAPE of
  -- the sequence rather than on the money — a later "one open card hold per
  -- child", a per-child daily authorization cap, a family card freeze, an
  -- `is_active` test on the wallet, a merchant rule out of guardian_safety_
  -- config. Add any of those and steps 2 and 5 keep returning false, this probe
  -- stays green, and the `p_amount > v_spendable` line it exists to prove could
  -- be gone. The control closes exactly that gap by replaying the probe's whole
  -- sequence: C2 approves an $8 hold with an $8 hold ALREADY OPEN (the mirror of
  -- step 2), and C5 approves $1 as the FIFTH call for the child, its FOURTH
  -- distinct auth id, with holds already open (the mirror of step 5). A control
  -- that stopped at three calls — as the first version of this one did — left
  -- a cap on the NUMBER OF CALLS undetected: a "4 authorizations per child per
  -- day" rule declines step 5 and approves a third call. The one asymmetry the
  -- mirror cannot remove is that C2's approval places a hold step 2's decline
  -- does not, so at the $1 leg the control has THREE holds open and $18 held
  -- where the probe has two and $10. That cuts the right way: on every count a
  -- sequence-shaped refusal could key on — calls, distinct auth ids, open holds,
  -- cents held — C5 stands at or beyond step 5, so any cap that refuses step 5
  -- refuses C5, and the probe goes red for the right reason — its attribution.
  --
  -- The same-amount, same-position insistence is the analogue of the child_login
  -- control naming the same COLUMNS as the takeover: a control that approved $1
  -- where the test declines $8, or approved a first hold where the test declines
  -- a second, sails straight past the guard it is supposed to be standing in for.
  --
  -- And the row-count leg at the end is not decoration either. `true` is ALSO
  -- what the function returns for `p_amount <= 0` and for its idempotency
  -- shortcut — and that shortcut matches on `stripe_ref` alone, scoped to
  -- NEITHER family nor bucket (0342's header calls this out), so a stray
  -- `processing` hold left anywhere in this shared database under one of these
  -- auth ids would hand the control five free passes without inserting
  -- anything. The control therefore also proves its own holds landed — exactly
  -- four of them, because the replay leg (C3) must approve WITHOUT inserting,
  -- which is the same thing step 3 asserts by way of the final holds count.
  --
  -- The control's auth ids are `a8ctl_auth_*`, which appear nowhere else in the
  -- corpus, and its rows are torn down before the probe under test runs. The
  -- child rows it inserts into the anchor family cannot trip 0299's deferred
  -- `trg_family_keeps_a_manager` either: that trigger judges the family's END
  -- state at COMMIT, and every member this file inserts is deleted before the
  -- block ends, so the state at commit is the state before the run — whether or
  -- not SEED_ALL happened to seed the anchor's manager.

  -- C0) Fresh, isolated control wallet, funded $20. Part of the control, not
  -- scenery: if the ledger will not even take the seed credit, every leg below
  -- is moot and the boundary is UNPROVEN — so a refusal here is caught and
  -- reported as the control's, rather than surfacing as a raw error on a seed
  -- line that names the wrong subject.
  begin
    delete from public.wallet_transactions where child_wallet_id = c_wallet;
    delete from public.wallet_buckets where child_wallet_id = c_wallet;
    delete from public.child_wallets where id = c_wallet;
    delete from public.family_members where id = c_member;
    insert into public.family_members (id, family_id, display_name, role)
      values (c_member, v_family, 'Probe Child (control, $20)', 'child');
    insert into public.child_wallets (id, family_id, member_id) values (c_wallet, v_family, c_member);
    insert into public.wallet_buckets (family_id, child_wallet_id, kind, label)
      values (v_family, c_wallet, 'spend', 'Spend') returning id into c_bucket;
    insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
      values (v_family, c_wallet, c_bucket, 'allowance', 'completed', 'credit', 2000, 'control seed $20');
  exception when others then
    control_ok := false;
    failures := array_append(failures, format('CONTROL FAILED: could not even seed the $20 control wallet, %s: %s — something refuses ledger writes outright, so a decline below would be that refusal and not the balance guard', sqlstate, sqlerrm));
  end;

  -- C1) the first $8 hold, exactly as step 1 makes it. Must approve, and the
  -- legs after it are meaningless without its hold, so they are gated on it.
  if control_ok then
    begin
      r := public.wallet_reserve_card_auth(v_family, c_wallet, 800, 'a8ctl_auth_1', 'Toy Store');
      if not r then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: a first $8 hold on a $20 balance was DECLINED, so a decline below would prove nothing about the spendable-balance guard — it would prove only that something said no');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a first $8 hold on a $20 balance raised %s: %s — the declines below are unreadable', sqlstate, sqlerrm));
    end;
  end if;

  -- C2) THE SAME $8 STATEMENT STEP 2 EXPECTS A DECLINE FOR, with one $8 hold
  -- already open — only the balance differs ($12 free, not $2). Must approve.
  if control_ok then
    begin
      r := public.wallet_reserve_card_auth(v_family, c_wallet, 800, 'a8ctl_auth_2', 'Candy');
      if not r then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: a SECOND $8 hold was declined with $12 still free, so step 2''s decline of the same $8 is not attributable to the balance guard — something refuses a second hold regardless of the money');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a second $8 hold with $12 free raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  -- C3) The replay of the first auth id, exactly as step 3 makes it. Must
  -- approve (idempotent) and must NOT place a hold — C6 counts.
  if control_ok then
    begin
      r := public.wallet_reserve_card_auth(v_family, c_wallet, 800, 'a8ctl_auth_1', 'Toy Store');
      if not r then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: the idempotent replay of an open $8 hold was declined with $4 still free, so step 3 is measuring something other than the auth-id shortcut');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: replaying an open $8 hold raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  -- C4) The $2 hold, exactly as step 4 makes it: fourth call, third auth id.
  -- Must approve ($4 free).
  if control_ok then
    begin
      r := public.wallet_reserve_card_auth(v_family, c_wallet, 200, 'a8ctl_auth_3', 'Gum');
      if not r then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: a $2 hold as the fourth call was declined with $4 still free, so the fifth call below cannot be positioned where step 5 is — and step 4''s own approval sits at a position the probe never shows declining');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a $2 hold with $4 free raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  -- C5) THE SAME $1 STATEMENT STEP 5 EXPECTS A DECLINE FOR: the FIFTH call for
  -- this child, its FOURTH distinct auth id, with holds already open — only the
  -- balance differs ($2 free, not $0). Must approve.
  if control_ok then
    begin
      r := public.wallet_reserve_card_auth(v_family, c_wallet, 100, 'a8ctl_auth_4', 'More');
      if not r then
        control_ok := false;
        failures := array_append(failures, 'CONTROL FAILED: a $1 hold as the FIFTH call (fourth auth id, three holds open) was declined with $2 still free, so step 5''s decline of the same $1 is not attributable to a $0 balance — something caps the number of calls, auth ids or open holds');
      end if;
    exception when others then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: a fifth-call $1 hold with $2 free raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  -- C6) The four approvals that should have WRITTEN a hold did, and the replay
  -- did not. An approval that inserted nothing is the $0-amount branch or the
  -- unscoped stripe_ref shortcut; a replay that inserted is a broken shortcut;
  -- either would make the legs above green without exercising the guard.
  if control_ok then
    select count(*), coalesce(sum(amount_cents), 0) into c_holds, c_held
      from public.wallet_transactions
     where child_wallet_id = c_wallet and status = 'processing';
    if c_holds <> 4 or c_held <> 1900 then
      control_ok := false;
      failures := array_append(failures, format('CONTROL FAILED: the control''s four distinct approvals should have written 4 holds totalling 1900c (and the replay none), found %s hold(s) totalling %sc — the approvals did not go through the reserve path, so they vouch for nothing', c_holds, c_held));
    end if;
  end if;

  -- The control leaves no residue, on every path. Unconditional: a stray
  -- `processing` card hold in the anchor family is exactly the quiet
  -- contamination that turns one unattributed check into someone else's false
  -- failure later in the run — the wallet probes count holds by wallet, but the
  -- function's own idempotency `exists` reads stripe_ref across ALL families.
  delete from public.wallet_transactions where child_wallet_id = c_wallet;
  delete from public.wallet_buckets where child_wallet_id = c_wallet;
  delete from public.child_wallets where id = c_wallet;
  delete from public.family_members where id = c_member;

  -- A failed control makes every decline below unreadable, so the boundary is
  -- reported as UNPROVEN — not as holding, not as broken — and the build is red
  -- either way. Said here, while the reason is still in hand — and if the body
  -- in place is not 0155's, that is said too, because a control leg going red
  -- on a redefined function (the sibling probe's neutered body has no
  -- idempotency shortcut, so its replay leg declines) would otherwise name the
  -- symptom and not the cause. This adds to the message; the pin proper stays
  -- the last assertion in the file.
  if not control_ok then
    if md5(body_at_start) is distinct from pinned_body_md5 then
      failures := array_append(failures, format('AND the wallet_reserve_card_auth in place is NOT the body 0155 installs (md5 %s, pinned %s) — see WHICH BODY above; wallet-concurrency-check.sql''s restore is the first suspect', coalesce(md5(body_at_start), '<function missing>'), pinned_body_md5));
    end if;
    raise exception 'A-08 overspend boundary UNPROVEN (the control this probe rests on did not hold): %', array_to_string(failures, ' | ');
  end if;

  -- Dedicated child member for the probe (child_wallets is unique per member).
  v_member := 'e0000000-0000-4000-8000-0000000000a8';

  -- Fresh, isolated test wallet (clean re-run each time).
  delete from public.wallet_transactions where child_wallet_id = v_wallet;
  delete from public.wallet_buckets where child_wallet_id = v_wallet;
  delete from public.child_wallets where id = v_wallet;
  delete from public.family_members where id = v_member;
  insert into public.family_members (id, family_id, display_name, role)
    values (v_member, v_family, 'Probe Child', 'child');
  insert into public.child_wallets (id, family_id, member_id) values (v_wallet, v_family, v_member);
  insert into public.wallet_buckets (family_id, child_wallet_id, kind, label)
    values (v_family, v_wallet, 'spend', 'Spend') returning id into v_bucket;
  insert into public.wallet_transactions (family_id, child_wallet_id, bucket_id, type, status, direction, amount_cents, description)
    values (v_family, v_wallet, v_bucket, 'allowance', 'completed', 'credit', 1000, 'seed $10');

  -- 1) $8 of $10 → approve
  r := public.wallet_reserve_card_auth(v_family, v_wallet, 800, 'a8_auth_1', 'Toy Store');
  if not r then raise exception 'A-08 FAIL: first $8 hold on $10 was declined'; end if;

  -- 2) another $8 → decline (only $2 left; the first hold counts against balance)
  r := public.wallet_reserve_card_auth(v_family, v_wallet, 800, 'a8_auth_2', 'Candy');
  if r then raise exception 'A-08 FAIL: overspend — second $8 approved with only $2 left'; end if;

  -- 3) replay auth_1 → approve, idempotent (must NOT place a second hold)
  r := public.wallet_reserve_card_auth(v_family, v_wallet, 800, 'a8_auth_1', 'Toy Store');
  if not r then raise exception 'A-08 FAIL: idempotent replay of a hold was declined'; end if;

  -- 4) exactly the remaining $2 → approve
  r := public.wallet_reserve_card_auth(v_family, v_wallet, 200, 'a8_auth_3', 'Gum');
  if not r then raise exception 'A-08 FAIL: exact-fit $2 hold was declined'; end if;

  -- 5) $1 more → decline (balance now $0)
  r := public.wallet_reserve_card_auth(v_family, v_wallet, 100, 'a8_auth_4', 'More');
  if r then raise exception 'A-08 FAIL: overspend — approved a hold against a $0 balance'; end if;

  select count(*) into holds from public.wallet_transactions
   where child_wallet_id = v_wallet and status = 'processing';
  if holds <> 2 then raise exception 'A-08 FAIL: expected 2 holds (auth_1 $8 + auth_3 $2), found %', holds; end if;

  select coalesce(sum(case when direction='credit' then amount_cents else -amount_cents end),0) into spendable
    from public.wallet_transactions where bucket_id = v_bucket and status in ('completed','processing');
  if spendable <> 0 then raise exception 'A-08 FAIL: spendable should be $0 after holds, was %', spendable; end if;

  -- ══ WHICH BODY did all of that measure? ═════════════════════════════════════
  -- Last on purpose (see the top of the block). Two things are asserted: that
  -- one body was in place for the whole run, and that it is the one 0155
  -- installs. `is distinct from` rather than `<>` so that a missing function
  -- (md5(null) is null) fails loudly instead of comparing to nothing.
  select p.prosrc into body_at_end
    from pg_proc p
   where p.oid = to_regprocedure(fn_under_test);
  if body_at_end is distinct from body_at_start then
    raise exception 'A-08 FAIL: % was redefined while this probe was running — the verdicts above were not all rendered on one body', fn_under_test;
  end if;
  if md5(body_at_start) is distinct from pinned_body_md5 then
    raise exception 'A-08 FAIL: the wallet_reserve_card_auth this probe measured is NOT the body 0155 installs (md5 %, pinned %). Every verdict above — the control''s approvals and the probe''s declines alike — was rendered on some other definition. If wallet-concurrency-check.sql ran before this one and its restore assertion fired, re-apply supabase/migrations/0155_wallet_auth_holds.sql; if 0155 was changed deliberately, read the new body, then recompute the pin: select md5(prosrc) from pg_proc where oid = ''%''::regprocedure',
      coalesce(md5(body_at_start), '<function missing>'), pinned_body_md5, fn_under_test;
  end if;

  -- tidy up so the probe leaves no residue
  delete from public.wallet_transactions where child_wallet_id = v_wallet;
  delete from public.wallet_buckets where child_wallet_id = v_wallet;
  delete from public.child_wallets where id = v_wallet;
  delete from public.family_members where id = v_member;

  raise notice 'A-08 OK: the same five statements ARE approved when the balance covers them (control), overspend prevented, holds counted, idempotent per auth id, and the body measured is 0155''s';
end $$;

select 'A-08 wallet overspend probe: ALL INVARIANTS PASSED' as result;

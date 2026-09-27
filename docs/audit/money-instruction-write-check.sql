-- Two numbers a child could write that a money path trusts.
--
-- 0254 and 0275 guard the money tables they enumerate. `allowance_rules` and
-- `invest_orders` are not on those lists, and both feed real credits:
--
--   allowance_rules.amount_cents  -> the nightly cron calls creditChildWallet
--                                    with it, on a schedule, with nobody in
--                                    the loop.
--   invest_orders.{shares,price_cents,amount_cents}
--                                 -> invest_decide_order debits the wallet with
--                                    the stored amount and credits the stored
--                                    shares, checking neither against the other
--                                    nor against the asset.
--
-- Judged on ROW COUNTS as well as refusals, and every refusal is paired with
-- the legitimate write it must NOT block — a guard that closed the feature
-- would pass a refusal-only probe just as happily.
--
-- NEGATIVE CONTROL, and it runs FIRST, before the refusals it gives meaning to
-- ---------------------------------------------------------------------------
-- Two mechanisms live in this probe, not one, and they need different controls.
--
-- 1, 2 and 2b (allowance_rules) are RLS. The rule under test is 0306's:
-- `0306_money_instructions_are_not_member_writable.sql` created THREE
-- restrictive policies on `can_manage_family(family_id)` —
-- `allowance_rules_manager_insert_guard` (WITH CHECK),
-- `allowance_rules_manager_update_guard` (USING and WITH CHECK) and
-- `allowance_rules_manager_delete_guard` (USING) — which AND with 0088's
-- permissive `Members manage allowance_rules` (FOR ALL, `is_family_member`).
-- 1 is the insert guard's refusal, 2 the update guard's, 2b the delete guard's,
-- and each has a control leg below that must land.
--
-- 0306 is the LAST migration to touch this table's policies. By name, five
-- migrations mention allowance_rules at all — 0088, 0294, 0306, 0311, 0316 (a
-- grep over every file in supabase/migrations, untracked ones included) — and of
-- the four that are not 0306, 0294 adds an index, 0311 adds the
-- `child_wallet_id` reference trigger, and 0316 only mentions the table in a
-- comment about a unique index on somebody else. A name grep cannot see a
-- catalog loop, though, and a loop is how this table got its objects in the
-- first place: 0088:268-289 writes the permissive policy AND
-- `trg_allowance_rules_updated_at` (BEFORE UPDATE, `set_updated_at()`, which
-- stamps a column and refuses nothing) through `EXECUTE format(...)` over a
-- table list, and 0311 wires its trigger the same way. 0118's loops reach every
-- base table without naming any — (A) enables RLS on all of them, (C) hands the
-- generic `is_family_member` CRUD set only to a family_id table with NO select
-- policy, which skipped this one because 0088's FOR ALL was already there — and
-- both predate 0306. That is the reading, and it is not what the probe rests
-- on: the ATTRIBUTION block below asserts the end state in pg_class and
-- pg_policies — RLS on, each of the three guards present, RESTRICTIVE, applying
-- to `authenticated`, on exactly `can_manage_family(family_id)` — so a later
-- migration that moves any of this turns the probe red instead of leaving this
-- paragraph quietly wrong. Given that, the whole of the boundary in 1, 2 and 2b
-- is one question: does `can_manage_family(family_id)` answer yes.
--
-- One question is all it is, so the control is the SAME CHILD running the SAME
-- THREE STATEMENTS in a SECOND family where that child IS a manager — the same
-- actor, through the same predicate, with the answer the other way, and all
-- three must LAND. What that buys, and what it does not:
--
--   * It rules out every refusal that is NOT keyed on manager-ness: a missing
--     or revoked table GRANT (42501), a column-level denial (42501), a dead
--     `auth.uid()` (the permissive `is_family_member` fails: 42501 on the
--     insert, zero rows on the update and delete), a guard that closed the
--     feature for everyone. Each of those stops the control as well — every leg
--     asserts its row count, not just the absence of an error — and the probe
--     goes red as UNPROVEN with the reason in hand.
--   * It does NOT rule out a refusal that IS keyed on manager-ness but is not
--     0306's. A guard TRIGGER raising 42501 when `not can_manage_family(...)` —
--     how this repository refuses writes in 0223, 0305, 0326 and 0331 — passes
--     the control, and with 0306's policies dropped it would pass a check that
--     only asked "was it refused". So the checks ask WHO refused. 1's 42501 must
--     NAME `allowance_rules_manager_insert_guard`: Postgres names the failing
--     restrictive policy in the message, and the name is a substituted
--     parameter, so this holds in any lc_messages. A 42501 that does not name it
--     is reported as UNATTRIBUTED, not as a pass. 2 and 2b are refused by a
--     restrictive USING, which FILTERS the row rather than raising — and their
--     SET list never touches family_id, so the update guard's WITH CHECK cannot
--     be what raises either — so on those two ANY 42501 is UNATTRIBUTED. And the
--     ATTRIBUTION block pins the three policies themselves.
--   * Nor does the control separate out 0311's `reference_shares_family`
--     (BEFORE INSERT OR UPDATE OF child_wallet_id, family_id on this table; it
--     raises 42501 by hand for a `child_wallet_id` in another family). The
--     control's wallet lives in the control's own family, so it never walks into
--     that trigger, and it would stay green if check 1 were ever pointed at a
--     foreign wallet. Check 1 closes that itself: its wallet is ASSERTED to be in
--     `fam`, and even without that, 0311's message does not name the insert
--     guard, so a refusal by 0311 is UNATTRIBUTED. Its UPDATE arm is
--     column-scoped and 2's SET list is `amount_cents` alone, so it never fires
--     on 2; it has no DELETE arm.
--   * 2 and 2b assert ZERO ROWS, and zero rows is the answer to three different
--     questions: the restrictive USING refused, the session could not SEE the
--     row, or there was no row at all. No row: they run against `parent_rule`,
--     seeded FOR the parent before the child's session opens (until that seed
--     the probe deleted every rule in `fam` at the top and check 6 wrote the
--     parent's only after the session closed, so 2 updated an empty set). Could
--     not see it: the control proves this session can write a rule it sees in
--     ctl_fam, NOT that it sees this one — a restrictive SELECT guard, or 0088's
--     read moved to `can_manage_family`, would make 2's zero a visibility
--     artefact with the control still green. So the child's session SELECTs
--     `parent_rule` by id immediately before 2 and must get it back. And after 2
--     and 2b the rule must still be there at 500: the number the cron will pay
--     is asserted directly, not inferred from a row count.
--
-- The control's INSERT names the same six columns check 1 names, its UPDATE
-- sets `amount_cents`, the column check 2 sets, and its DELETE is 2b's
-- statement. That is load-bearing, not decoration: a `revoke update
-- (amount_cents) on allowance_rules from authenticated` sails straight past a
-- control that only touched some other column, and would then kill check 2 as
-- a bare permission denial with the attribution thrown away. A column privilege
-- is checked against the SET list and not against the values, so the control's
-- own numbers are free to differ — it raises 500 to 100000, so its UPDATE is a
-- real change rather than a no-op.
--
-- 4 and 5 (invest_orders) are NOT RLS. The mechanism is a TRIGGER: 0306 also
-- created `public.invest_order_economics_guard()` and wired it as
-- `trg_invest_order_economics_guard` BEFORE INSERT OR UPDATE, raising errcode
-- 23514 when `amount_cents` is not `shares * price_cents` or when `price_cents`
-- is not the asset's own price. 0306 is the only migration that mentions that
-- function or trigger, and of the six that name invest_orders — 0097, 0196,
-- 0220, 0304, 0306, 0308 — it is the last to constrain a write to these three
-- columns. Their control already exists and is already in the right shape and
-- the right place: check 3 is the same child, the same INSERT, the same three
-- economics columns, with the one thing the trigger keys on — the numbers
-- agreeing with each other and with the asset — set the other way, and it must
-- land. It is why 4 and 5 may keep a `when insufficient_privilege` arm and stay
-- attributed: a blanket 42501 on invest_orders fails check 3 loudly instead of
-- quietly satisfying 4 and 5.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000ab11';
  parent_uid uuid := '00000000-0000-4000-8000-00000000abb1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000abb2';
  child_mid uuid;
  wallet uuid;
  asset uuid;
  asset_price bigint;
  -- The control's household: a SECOND family the SAME child manages, so
  -- `can_manage_family` answers yes for the very user it answers no for in `fam`.
  -- Fresh anchors — ab12 and abb6/abb8 appear nowhere else in docs/audit or
  -- supabase/migrations, checked, because run-probes.sh runs all of these against
  -- one database in sequence and a reused anchor silently rewrites what some
  -- other probe is asserting.
  ctl_fam    uuid := '00000000-0000-4000-8000-00000000ab12';
  ctl_wallet uuid := '00000000-0000-4000-8000-00000000abb6';
  ctl_mid uuid;
  -- The rule check 2 aims at. Seeded for the PARENT, before the child's session.
  parent_rule uuid := '00000000-0000-4000-8000-00000000abb8';
  control_ok boolean := true;
  control_why text;
  wallet_fam uuid;
  amt bigint;
  g record;
  pols text;
  n int;
  failures int := 0;
begin
  delete from public.invest_orders where family_id = fam;
  delete from public.allowance_rules where family_id in (fam, ctl_fam);

  insert into auth.users (id, email) values
    (parent_uid, 'allow-parent@example.com'), (child_uid, 'allow-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Money Instructions', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  select id into wallet from public.child_wallets where family_id = fam limit 1;
  if wallet is null then
    insert into public.child_wallets (family_id, member_id) values (fam, child_mid) returning id into wallet;
  end if;
  select id, price_cents into asset, asset_price from public.invest_assets where price_cents is not null limit 1;
  if asset is null then
    insert into public.invest_assets (symbol, name, price_cents) values ('MIGX', 'Money Instr Asset', 250)
    returning id, price_cents into asset, asset_price;
  end if;

  -- ── the rule check 2 tries to raise ──────────────────────────────────────
  -- Check 2 says "nor raise one a parent set up", and until this pass there was
  -- no such rule when it ran: the delete at the top of this block empties
  -- allowance_rules for `fam`, and check 6 does not write one until after the
  -- child's session has closed. Zero rows updated, for the one reason that has
  -- nothing to do with the policy. The rule exists now, written here as the
  -- parent with no session open. That rules out "no row"; the control below
  -- rules out "this session could not have written any allowance rule at all";
  -- and the SELECT just before check 2 rules out "this session cannot see this
  -- one". What is left for 2's and 2b's zero is the restrictive USING.
  insert into public.allowance_rules
    (id, family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on, created_by)
  values (parent_rule, fam, wallet, 500, 'weekly', true, current_date, parent_uid);

  -- ── the control's household ──────────────────────────────────────────────
  -- ctl_fam is created BY the child, so on_family_created files them as a
  -- 'parent' there; the upsert re-asserts it rather than trusting the trigger,
  -- because a seed whose roles are wrong fails the control for a reason that is
  -- not the control's. The wallet the control's rule points at lives in ctl_fam
  -- on purpose: 0311's `reference_shares_family` fires BEFORE INSERT OR UPDATE
  -- OF child_wallet_id, family_id on allowance_rules and raises 42501 for a
  -- `child_wallet_id` in another family, and a control refused by THAT would
  -- say nothing about the manager gate. The control does not, by the same
  -- token, separate 0311 out of check 1 — see the header; check 1 does that
  -- itself.
  insert into public.families (id, name, created_by)
  values (ctl_fam, 'Money Instructions (the child''s own house)', child_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (ctl_fam, child_uid, 'Same child, a manager here', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
  select id into ctl_mid from public.family_members where family_id = ctl_fam and user_id = child_uid;
  insert into public.child_wallets (id, family_id, member_id) values (ctl_wallet, ctl_fam, ctl_mid)
  on conflict do nothing;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- ── NEGATIVE CONTROL for 1, 2 and 2b, and it runs FIRST ──────────────────
  -- The same child, the same three statements, the same columns, in the family
  -- where `can_manage_family` answers YES. All three must land. If any does not,
  -- this session never held the access 1, 2 and 2b are supposed to be
  -- measuring, and their refusals say only that something said no — a grant, a
  -- column privilege, a dead session, a guard that closed the feature. (What the
  -- control CANNOT rule out — a refusal keyed on manager-ness that is not
  -- 0306's — is the ATTRIBUTION block's and the refusal arms' job; see the
  -- header.)
  if not public.can_manage_family(ctl_fam) then
    raise exception
      'CONTROL FAILED: this child is not a manager of the control family, so the control cannot ask can_manage_family the other way';
  end if;

  begin
    -- The same six columns check 1 names, so a column-level revoke cannot hide
    -- from this. The amount differs on purpose: values are not what a column
    -- privilege or an RLS predicate is checked against, and starting at 500
    -- lets the UPDATE leg below be a real raise.
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on)
    values (ctl_fam, ctl_wallet, 500, 'weekly', true, current_date);
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      control_why := format('this child''s INSERT of an allowance rule in the family they DO manage stored %s rows, so check 1''s refusal would prove nothing about the manager gate', n);
    end if;
  exception when others then
    control_ok := false;
    control_why := format('this child was REFUSED an allowance rule in the family they DO manage (%s: %s), so check 1''s refusal would prove only that something said no — not that can_manage_family said it', sqlstate, sqlerrm);
  end;

  if control_ok then
    begin
      -- Check 2's statement, verbatim but for the family: same column set, so a
      -- `revoke update (amount_cents)` cannot sail past it.
      update public.allowance_rules set amount_cents = 100000 where family_id = ctl_fam;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        control_why := format('this child''s UPDATE of amount_cents on an allowance rule they DO manage changed %s rows, so check 2''s zero would prove nothing: a row this session cannot write, or cannot see, reports zero just as readily', n);
      end if;
    exception when others then
      control_ok := false;
      control_why := format('this child''s UPDATE of amount_cents on an allowance rule they DO manage raised %s: %s', sqlstate, sqlerrm);
    end;
  end if;

  if control_ok then
    begin
      -- Check 2b's statement, verbatim but for the family, as the child: the
      -- delete guard's leg. It is also what removes the control's rule.
      delete from public.allowance_rules where family_id = ctl_fam;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        control_why := format('this child''s DELETE of an allowance rule they DO manage removed %s rows, so check 2b''s zero would prove nothing', n);
      end if;
    exception when others then
      control_ok := false;
      control_why := format('this child''s DELETE of an allowance rule they DO manage raised %s: %s', sqlstate, sqlerrm);
    end;
  end if;

  -- What the control leaves behind. Its RULE does not survive: on the green path
  -- the child's own DELETE above removed it (asserted, 1 row), and on any failure
  -- path the raise below aborts this whole DO block — one statement, one
  -- transaction under `psql -f` — so nothing written here survives at all. Its
  -- HOUSEHOLD does survive a green run: ctl_fam, the child's 'parent' membership
  -- in it, ctl_wallet, and the subscriptions and family_ai_settings rows
  -- on_family_created writes. Every *-check.sql under docs/audit runs against
  -- one database in sequence (run-probes.sh globs them), so that matters; the
  -- seeds above are idempotent on re-run, the anchors are unique (checked), and
  -- `can_manage_family` is family-scoped, so a second household for this child
  -- changes nothing `fam` answers.

  -- A failed control makes 1 and 2 unreadable, so say WHY here, while the reason
  -- is still in hand. The boundary is not reported as holding and it is not
  -- reported as broken: it is reported as unproven, and the build is red either
  -- way.
  if not control_ok then
    raise exception 'money-instruction-write: the allowance_rules boundary is UNPROVEN (the control it rests on did not hold): %', control_why;
  end if;

  -- ── ATTRIBUTION: the guards 1, 2 and 2b credit are the ones in force ─────
  -- After the control, so a refusal that would equally stop the control is
  -- reported as the control's failure, and ACCUMULATED rather than raised, so a
  -- loosened guard still reaches the BREACH lines below and names what leaked.
  -- Read as the owner; the session's jwt claim is a transaction GUC and is not
  -- touched by the role round trip.
  reset role;
  select count(*) into n from pg_class
   where oid = 'public.allowance_rules'::regclass and relrowsecurity;
  if n <> 1 then
    raise warning 'ATTRIBUTION: row level security is OFF on public.allowance_rules, so no policy refuses anything below';
    failures := failures + 1;
  end if;

  for g in
    select * from (values
      ('allowance_rules_manager_insert_guard', 'INSERT', false, true,  '1'),
      ('allowance_rules_manager_update_guard', 'UPDATE', true,  true,  '2'),
      ('allowance_rules_manager_delete_guard', 'DELETE', true,  false, '2b')
    ) v(pol, cmd, has_using, has_check, chk)
  loop
    -- An UPDATE policy with no WITH CHECK uses its USING for both, hence the
    -- coalesce. `to public` covers authenticated too, hence the overlap.
    select count(*) into n from pg_policies p
     where p.schemaname = 'public' and p.tablename = 'allowance_rules'
       and p.policyname = g.pol and p.cmd = g.cmd
       and p.permissive = 'RESTRICTIVE'
       and p.roles && array['authenticated', 'public']::name[]
       and (not g.has_using or coalesce(p.qual, '') ~ '^(public\.)?can_manage_family\(family_id\)$')
       and (not g.has_check or coalesce(p.with_check, p.qual, '') ~ '^(public\.)?can_manage_family\(family_id\)$');
    if n <> 1 then
      select string_agg(format('%s %s %s to %s using %s check %s', policyname, permissive, cmd, roles,
                               coalesce(qual, '-'), coalesce(with_check, '-')), '; ' order by policyname)
        into pols from pg_policies
       where schemaname = 'public' and tablename = 'allowance_rules' and cmd in (g.cmd, 'ALL');
      raise warning 'ATTRIBUTION: % is not 0306''s RESTRICTIVE % to authenticated on can_manage_family(family_id) — found: % — so check %''s refusal is not the rule this probe credits it to',
        g.pol, g.cmd, coalesce(pols, 'no policy'), g.chk;
      failures := failures + 1;
    end if;
  end loop;

  -- Check 1's wallet must be in `fam`, or 0311's reference trigger — not the
  -- insert guard — is what check 1 walks into.
  select family_id into wallet_fam from public.child_wallets where id = wallet;
  if wallet_fam is distinct from fam then
    raise warning 'ATTRIBUTION: check 1''s wallet % belongs to family %, not %, so 0311''s reference_shares_family would refuse it before 0306''s guard is asked',
      wallet, wallet_fam, fam;
    failures := failures + 1;
  end if;
  set local role authenticated;

  -- 1. A child may not write themselves a standing payment instruction.
  begin
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on)
    values (fam, wallet, 100000, 'weekly', true, current_date);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child created their own allowance rule (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then
    -- Refused — but by whom. The insert guard's refusal names it.
    if position('allowance_rules_manager_insert_guard' in sqlerrm) = 0 then
      raise warning 'UNATTRIBUTED: check 1 was refused with 42501 by something other than allowance_rules_manager_insert_guard (%), so this refusal is not the boundary this probe credits it to', sqlerrm;
      failures := failures + 1;
    end if;
  end;

  -- The zero in 2 and 2b means "refused" only if this session can SEE the row
  -- it is being refused. The control proved that for ctl_fam's rule, not this.
  select count(*) into n from public.allowance_rules where id = parent_rule;
  if n <> 1 then
    raise exception 'money-instruction-write: checks 2 and 2b are UNPROVEN: this child''s session sees % rows of the parent''s rule %, so a zero below would be a visibility artefact rather than the restrictive USING', n, parent_rule;
  end if;

  -- 2. Nor raise one a parent set up — `parent_rule`, seeded above so that this
  --    zero is a refusal rather than an empty table.
  begin
    update public.allowance_rules set amount_cents = 100000 where family_id = fam;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child raised an existing allowance rule (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then
    -- 0306's update guard refuses by filtering (USING), and its WITH CHECK
    -- cannot fail on a SET list without family_id. A 42501 here is someone else.
    raise warning 'UNATTRIBUTED: check 2 raised 42501 (%) — allowance_rules_manager_update_guard refuses by filtering the row, not by raising, so something other than 0306 refused this update', sqlerrm;
    failures := failures + 1;
  end;

  -- 2b. Nor delete one — the parent's, or a sibling's.
  begin
    delete from public.allowance_rules where family_id = fam;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child deleted an allowance rule a manager set up (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then
    raise warning 'UNATTRIBUTED: check 2b raised 42501 (%) — allowance_rules_manager_delete_guard refuses by filtering the row, not by raising, so something other than 0306 refused this delete', sqlerrm;
    failures := failures + 1;
  end;

  -- And the number the cron pays is still the parent's, read as the owner.
  reset role;
  select amount_cents into amt from public.allowance_rules where id = parent_rule;
  if not found or amt is distinct from 500 then
    raise warning 'BREACH: the parent''s allowance rule % is %, not 500 cents, after the child''s session wrote to it',
      parent_rule, case when found then amt::text else 'gone' end;
    failures := failures + 1;
  end if;
  set local role authenticated;

  -- 3. A child MAY place an investment order at the asset's own price — the
  --    positive control. The product's own action does exactly this, deriving
  --    both numbers server-side, and a guard that blocked it would have closed
  --    the feature rather than the hole.
  begin
    insert into public.invest_orders
      (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, requested_by)
    values (fam, wallet, asset, 'buy', 2, asset_price, 2 * asset_price, 'pending', child_uid);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a child could not place an honest invest order (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not place an honest invest order (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 4. But not at a price of their own choosing.
  begin
    insert into public.invest_orders
      (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, requested_by)
    values (fam, wallet, asset, 'buy', 1000, 1, 1000, 'pending', child_uid);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child priced their own order below the asset (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when check_violation then null; when insufficient_privilege then null;
  end;

  -- 5. Nor with an amount that does not match the shares it buys.
  begin
    insert into public.invest_orders
      (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents, status, requested_by)
    values (fam, wallet, asset, 'buy', 1000, asset_price, 1, 'pending', child_uid);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child bought % shares for one cent (rows: %)', 1000, n;
      failures := failures + 1;
    end if;
  exception when check_violation then null; when insufficient_privilege then null;
  end;

  reset role;

  -- 6. A manager still sets an allowance, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on)
    values (fam, wallet, 500, 'weekly', true, current_date);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not create an allowance rule (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not create an allowance rule (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'money-instruction-write: % assertion(s) failed', failures;
  end if;
  raise notice 'money-instruction-write: OK — the same child CAN create, raise and delete an allowance rule in the family they manage (control), and in the family they do not they can neither create one (refused BY allowance_rules_manager_insert_guard, named) nor raise or delete the parent''s, which they can see and which still reads 500; 0306''s three restrictive guards are in pg_policies on can_manage_family(family_id); a child may ask to invest at the real price and may not price it themselves';
end
$probe$;

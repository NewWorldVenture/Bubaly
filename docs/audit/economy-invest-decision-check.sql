-- The fourth and fifth decision surfaces: economy redemptions and invest orders.
--
-- 0222 guarded chore submissions, 0223 chore assignments, 0295 reward
-- redemptions — and 0295 called itself "the last of the three decision
-- surfaces to be guarded". Two tables of the same shape were not guarded:
-- `status` defaulting to pending, a `decided_by`, and an INSERT policy open to
-- any family member with nothing constraining the state it may be created in.
--
-- So a child could insert a row already approved (or filled) with `decided_by`
-- naming a parent — and neither RPC can undo it, because each refuses a row it
-- does not find pending. 0304 is the guard; this is what measures it.
--
-- Judged on ROW COUNTS as well as refusals: an insert that is blocked by a
-- policy raises, but one blocked by nothing at all simply lands, and a probe
-- that only watched for exceptions would report a boundary that is not there.
--
-- NEGATIVE CONTROL, and it runs FIRST, before the four refusals
-- ---------------------------------------------------------------------------
-- WHICH MECHANISM, AND HOW I KNOW. Two mechanisms answer the four refusals, and
-- they do not overlap.
--
-- Checks 1 and 2 are NOT enforced by a policy predicate. They are enforced by a
-- TRIGGER, and 0304 says so in its own words — "written as a trigger rather
-- than a policy predicate ... it must cover the UPDATE transition too, and it
-- must say WHY it refused rather than making a row silently vanish from a WITH
-- CHECK". It creates `public.decision_status_guard()` and wires it as
-- `trg_economy_redemption_decision_guard` and `trg_invest_order_decision_guard`,
-- BEFORE INSERT OR UPDATE FOR EACH ROW, raising errcode 42501 when the new
-- `status` is one of the guarded manager-decision values and the writer is not
-- the trusted server and not `can_manage_family(new.family_id)`.
--
-- 0304 is the LAST migration to name either trigger or that function. Of the
-- four migrations that mention economy_redemptions at all — 0096, 0196, 0218,
-- 0304 — and the six that mention invest_orders — 0097, 0196, 0220, 0304, 0306,
-- 0308 — 0304 is the last to constrain WHO may set a decision status. 0306 puts
-- a SECOND BEFORE trigger on invest_orders, `trg_invest_order_economics_guard`,
-- which refuses with 23514 any order whose `price_cents` is not the asset's or
-- whose `amount_cents` is not shares x price. So check 2's order is priced AT
-- THE ASSET, one share, amount equal to that price: 0306 has nothing to refuse
-- in it and 0304's manager gate is the ONLY guard that can. (Postgres fires
-- BEFORE triggers in name order and `_decision_` sorts before `_economics_`, so
-- 0304 would answer first even for a mispriced row — but a check that leaned on
-- that would die on an unhandled 23514 the moment 0304's list was emptied,
-- instead of reporting the BREACH it exists to report. Measured: with 0304's
-- invest_orders array replaced by `'{}'`, a 100-cent order against the 5000-cent
-- MARKET asset raised `invest order price 100 is not this asset's price 5000`.)
--
-- Checks 4 and 5 rest ONLY on a POLICY: `economy_redemptions_mng_update`, which
-- 0218 created with USING and WITH CHECK both `can_manage_family(family_id)`,
-- and which nothing since has dropped or re-created — it is the one UPDATE
-- policy on the table, 0096's permissive `FOR ALL` having been dropped by 0218.
-- Their zero rows are that USING clause refusing to match. 0304's UPDATE branch
-- plays NO part in them: RLS applies USING when the row is selected, before any
-- BEFORE ROW trigger sees it, so a non-manager's UPDATE matches nothing and
-- `trg_economy_redemption_decision_guard` never fires. Measured: a spy trigger
-- that raises unconditionally BEFORE UPDATE on economy_redemptions stayed
-- silent through the child's UPDATE in `fam` (0 rows) and fired at once for the
-- owner's. The same holds on invest_orders under 0220's `invest_orders_mng_update`:
-- for the one actor 0304 was written about, its UPDATE branch is unreachable on
-- both tables, and this probe does not credit it with anything.
--
-- Both mechanisms key on the SAME ONE QUESTION, `can_manage_family(family_id)`,
-- so one control serves both: the SAME child running the SAME statements, naming
-- the SAME columns with the SAME values, in a SECOND family where that child IS
-- a manager — the same actor through the same predicate with the answer the
-- other way, and every leg of it must land. Without it the four refusals have
-- no attribution:
--
--   * 1 and 2 catch `insufficient_privilege` and credit 0304's guard, but a
--     missing or revoked table GRANT raises 42501, a column-level denial raises
--     42501 — and so does any OTHER guard trigger, which is how this repository
--     refuses writes in 0223, 0305, 0326 and 0331, and how 0306 already refuses
--     one write to invest_orders. Add one to either table for an unrelated rule
--     and 1 and 2 would keep passing with 0304's guarded-status lists emptied
--     back out, which is the whole hole 0304 exists to close. (A dead
--     `auth.uid()` is NOT on this list, and the reason is worth recording: 0304's
--     guard treats a null uid as the trusted server and waves the row THROUGH,
--     so the 42501 check 1 would then see is 0218's INSERT policy's, not the
--     trigger's. It never gets that far — `is_family_member(fam)` reads the same
--     null and the membership precondition below raises CONTROL FAILED before
--     any leg runs.)
--   * 4 and 5 assert ZERO ROWS, and a row this session cannot SEE reports zero
--     just as readily as a USING clause does. The child can see it under 0218's
--     `economy_redemptions_select` today — but that is a fact about 0218, not
--     something those two checks measure, and check 4's row is one the child
--     inserted moments earlier, which proves visibility at INSERT time and not
--     at UPDATE time.
--
-- The control's UPDATE legs name `status`, `decided_by` and `decided_at` — the
-- three columns check 4 sets — and then `status` alone, the one column check 5
-- sets. That is load-bearing, not decoration: a `revoke update (decided_by) on
-- economy_redemptions from authenticated` sails straight past a control that
-- only touched some other column, and would then kill check 4 as a bare
-- `permission denied for table economy_redemptions`: red, but with the
-- attribution thrown away exactly as it was before this control existed.
-- Postgres checks column privileges against the SET list and not against the
-- values, so for THAT class the control's own row is free to be a different row.
--
-- The VALUES match too, and that is a separate class of guard. 0333, 0335, 0338
-- and 0339 each pin an actor column to the caller — `with check (requested_by =
-- auth.uid())` and its siblings — and for that shape the value IS the predicate.
-- Checks 1, 2 and 4 write `decided_by = parent_uid`, a manager's name on a
-- decision the child made; so do legs 1, 2 and 4. Had the legs written
-- `child_uid` there, a future `decided_by = auth.uid()` pin on either table
-- would refuse the checks (parent is not the caller) while letting the legs land
-- (child is), and with 0304's lists emptied the probe would read green on both
-- sides while measuring the wrong guard. With the same value in both, such a
-- pin refuses the control too and the probe says UNPROVEN, which is the truth.
-- `parent_uid` is made a manager of ctl_fam as well, so the decider the control
-- names is — exactly as in the checks — a manager of the row's own family, and
-- no membership-scoped rule on `decided_by`, present or future, can be what
-- separates control from check.
--
-- Check 6, the manager's insert, does not cover any of this. It proves the guard
-- lets SOMEBODY through, not that the CHILD's session could have written
-- anything at all — which is precisely how the document-vault probe passed for a
-- release while the teen could not INSERT a document at all.
--
-- The control's invest order, like check 2's, is priced AT THE ASSET with its
-- amount equal to shares x price, because 0306's economics guard sits on the
-- same statement as 0304's and would otherwise refuse the control's own row
-- with 23514. A control must not walk into the confounder it exists to separate
-- out — and neither may the check it serves.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000ec01';
  parent_uid uuid := '00000000-0000-4000-8000-00000000eca1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000eca2';
  child_mid uuid;
  currency uuid;
  wallet uuid;
  asset uuid;
  asset_price bigint;
  queued uuid;
  -- The negative control's household: a SECOND family the SAME child manages, so
  -- `can_manage_family` answers YES for the very user it answers NO for in `fam`.
  -- Fresh anchors — ec02, ec03 and ec04 appear nowhere else in docs/audit or
  -- supabase/migrations, checked, because run-probes.sh runs every *-check.sql
  -- probe against ONE database in sequence and a reused anchor silently rewrites
  -- what some other probe is asserting.
  ctl_fam      uuid := '00000000-0000-4000-8000-00000000ec02';
  ctl_currency uuid := '00000000-0000-4000-8000-00000000ec03';
  ctl_wallet   uuid := '00000000-0000-4000-8000-00000000ec04';
  ctl_mid uuid;
  ctl_queued uuid;   -- leg 4's row: pending -> approved, as check 4 attempts
  ctl_cancel uuid;   -- leg 5's row: pending -> cancelled, as check 5 attempts
  control_ok boolean := true;
  control_why text;
  n int;
  failures int := 0;
begin
  -- Repeatable across runs.
  delete from public.economy_redemptions where family_id = fam;
  delete from public.invest_orders where family_id = fam;
  delete from public.economy_redemptions where family_id = ctl_fam;
  delete from public.invest_orders where family_id = ctl_fam;

  insert into auth.users (id, email) values
    (parent_uid, 'econ-parent@example.com'), (child_uid, 'econ-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Economy Guard', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  select id into currency from public.family_currencies where family_id = fam limit 1;
  if currency is null then
    insert into public.family_currencies (family_id, name) values (fam, 'Stars') returning id into currency;
  end if;
  select id into wallet from public.child_wallets where family_id = fam limit 1;
  if wallet is null then
    insert into public.child_wallets (family_id, member_id) values (fam, child_mid) returning id into wallet;
  end if;
  select id into asset from public.invest_assets limit 1;
  if asset is null then
    insert into public.invest_assets (symbol, name, price_cents) values ('TSTX', 'Test Asset', 100) returning id into asset;
  end if;
  -- The chosen asset's OWN price. Read rather than assumed: 0097 seeds five
  -- assets at 2000-8000 cents, so the `limit 1` above returns whichever the
  -- planner hands back and 100 is not its price. Both check 2 and the negative
  -- control's invest order have to agree with this number and with themselves,
  -- or 0306's economics guard is what answers instead of 0304's decision guard
  -- — see the header.
  select price_cents into asset_price from public.invest_assets where id = asset;

  -- ── the negative control's household ─────────────────────────────────────
  -- ctl_fam is created BY the child, so `on_family_created` files them as a
  -- 'parent' there; the upsert re-asserts it rather than trusting the trigger,
  -- because a seed whose roles are wrong fails the control for a reason that is
  -- not the control's. `parent_uid` is filed as a manager here too, so that the
  -- `decided_by` the control writes names a manager of the row's own family,
  -- exactly as the checks' does. Its currency and its wallet live in ctl_fam as
  -- well, so every row the control writes references only its own family and no
  -- cross-family reference guard (0311's shape) can be what refuses it. Seeded
  -- HERE, before `request.jwt.claim.sub` is set, so `auth.uid()` is still null
  -- and the seed itself takes the trusted-server path through 0304's guard.
  insert into public.families (id, name, created_by)
  values (ctl_fam, 'Economy Guard (the child''s own house)', child_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (ctl_fam, child_uid, 'Same child, a manager here', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (ctl_fam, parent_uid, 'Same parent, a manager here too', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;
  select id into ctl_mid from public.family_members where family_id = ctl_fam and user_id = child_uid;
  insert into public.family_currencies (id, family_id, name)
  values (ctl_currency, ctl_fam, 'Control Stars') on conflict (id) do nothing;
  insert into public.child_wallets (id, family_id, member_id)
  values (ctl_wallet, ctl_fam, ctl_mid) on conflict do nothing;

  -- ── as the child ─────────────────────────────────────────────────────────
  -- `request.jwt.claim.sub` (singular) is what this harness resolves auth.uid()
  -- from, and it must be set BEFORE dropping to the authenticated role.
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- Controls first: a probe acting as a stranger measures nothing, because
  -- every write would be refused for the wrong reason. (A dead `auth.uid()`
  -- lands here, as a stranger — see the header for why it is caught HERE and
  -- not by 0304's guard, which would wave a null uid through.)
  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- ── NEGATIVE CONTROL: the same child, the same predicate, the other answer ─
  -- Runs FIRST, before the four refusals it gives meaning to. Both mechanisms
  -- under test — 0304's `decision_status_guard` trigger for 1 and 2, and 0218's
  -- `economy_redemptions_mng_update` policy for 4 and 5 — key on the one
  -- question `can_manage_family(family_id)`. So the control is this child writing
  -- the very rows 1, 2, 4 and 5 try to write — same columns, same values — in
  -- the family where that question answers YES. Every leg must land. If one does
  -- not, this session never held the access those checks are supposed to be
  -- measuring, and the probe says the boundary is UNPROVEN rather than reporting
  -- it as holding.
  if not public.can_manage_family(ctl_fam) then
    raise exception
      'CONTROL FAILED: this child is not a manager of the control family, so the control cannot ask can_manage_family the other way';
  end if;
  if asset_price is null then
    raise exception
      'CONTROL FAILED: no invest asset price in hand, so neither check 2 nor the control''s invest order can be priced at the asset, and 0306 would answer instead of 0304';
  end if;

  -- Control leg 1 — check 1's statement: the same nine columns, the same values
  -- (`decided_by = parent_uid`, a manager's name on the child's decision), in
  -- ctl_fam.
  begin
    insert into public.economy_redemptions
      (family_id, currency_id, member_id, title, cost, status, requested_by, decided_by, decided_at)
    values (ctl_fam, ctl_currency, ctl_mid, 'Control console', 1, 'approved', child_uid, parent_uid, now());
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      control_why := format('this child''s INSERT of an APPROVED economy redemption in the family they DO manage stored %s rows, so check 1''s refusal would prove nothing about 0304''s manager gate', n);
    end if;
  exception when others then
    control_ok := false;
    control_why := format('this child was REFUSED an APPROVED economy redemption in the family they DO manage (%s: %s), so check 1''s refusal would prove only that something said no — not that can_manage_family said it', sqlstate, sqlerrm);
  end;

  -- Control leg 2 — check 2's statement: the same eleven columns, the same
  -- values, priced at the asset so that 0306's economics guard is not what
  -- answers.
  if control_ok then
    begin
      insert into public.invest_orders
        (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents,
         status, requested_by, decided_by, decided_at)
      values (ctl_fam, ctl_wallet, asset, 'buy', 1, asset_price, asset_price, 'filled', child_uid, parent_uid, now());
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        control_why := format('this child''s INSERT of a FILLED invest order in the family they DO manage stored %s rows, so check 2''s refusal would prove nothing about 0304''s manager gate', n);
      end if;
    exception when others then
      control_ok := false;
      control_why := format('this child was REFUSED a FILLED invest order in the family they DO manage (%s: %s), so check 2''s refusal would prove only that something said no', sqlstate, sqlerrm);
    end;
  end if;

  -- Control leg 3 — the rows legs 4 and 5 move: TWO of the same pending ask
  -- check 3 makes, in ctl_fam, so that each UPDATE leg below starts from a
  -- PENDING row exactly as its check does (check 4's UPDATE matches nothing, so
  -- check 5 also cancels a row that is still pending), and neither leg touches
  -- the row checks 4 and 5 are about. One row for both legs would have leg 5
  -- cancelling an APPROVED row — a transition no check makes and one a future
  -- state-machine guard could refuse on a healthy database.
  if control_ok then
    begin
      insert into public.economy_redemptions
        (family_id, currency_id, member_id, title, cost, status, requested_by)
      values (ctl_fam, ctl_currency, ctl_mid, 'Control sticker', 1, 'pending', child_uid)
      returning id into ctl_queued;
      insert into public.economy_redemptions
        (family_id, currency_id, member_id, title, cost, status, requested_by)
      values (ctl_fam, ctl_currency, ctl_mid, 'Control sticker (to withdraw)', 1, 'pending', child_uid)
      returning id into ctl_cancel;
      if ctl_queued is null or ctl_cancel is null then
        control_ok := false;
        control_why := 'this child could not queue two pending redemptions in the family they DO manage, so checks 4 and 5 have no control';
      end if;
    exception when others then
      control_ok := false;
      control_why := format('this child could not queue a pending redemption in the family they DO manage (%s: %s), so checks 4 and 5 have no control', sqlstate, sqlerrm);
    end;
  end if;

  -- Control leg 4 — check 4's statement: the SAME three columns with the SAME
  -- values, so neither a column-level revoke on `decided_by` or `decided_at`
  -- nor a `decided_by = auth.uid()` pin can hide from this. What it attributes
  -- is 0218's USING clause answering the other way for the same actor. (0304's
  -- UPDATE branch does run here — this child is a manager in ctl_fam and the row
  -- is visible to them — but check 4 never reaches that branch, so nothing is
  -- claimed for it; see the header.)
  if control_ok then
    begin
      update public.economy_redemptions
         set status = 'approved', decided_by = parent_uid, decided_at = now()
       where id = ctl_queued;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        control_why := format('this child''s UPDATE to approved — status, decided_by and decided_at, the three columns check 4 sets — changed %s rows in the family they DO manage, so check 4''s zero would prove nothing: a row this session cannot write, or cannot see, reports zero just as readily', n);
      end if;
    exception when others then
      control_ok := false;
      control_why := format('this child''s UPDATE to approved (status, decided_by, decided_at) in the family they DO manage raised %s: %s', sqlstate, sqlerrm);
    end;
  end if;

  -- Control leg 5 — check 5's statement: `status` alone, pending -> 'cancelled',
  -- on the second pending row. 0304 does not guard that value for
  -- economy_redemptions, so this leg is purely 0218's
  -- `economy_redemptions_mng_update` answering the other way — which is the
  -- mechanism check 5 credits, and the one the note under check 5 is about.
  if control_ok then
    begin
      update public.economy_redemptions set status = 'cancelled' where id = ctl_cancel;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        control_why := format('this child''s UPDATE of status alone changed %s rows in the family they DO manage, so check 5''s zero would prove nothing about economy_redemptions_mng_update', n);
      end if;
    exception when others then
      control_ok := false;
      control_why := format('this child''s UPDATE of status alone in the family they DO manage raised %s: %s', sqlstate, sqlerrm);
    end;
  end if;

  -- The control's rows do not outlive the control. This matters on the SUCCESS
  -- path only: on failure the `raise exception` below aborts this DO block's
  -- transaction and takes the control's rows, these deletes and the ctl_fam seed
  -- with it. On success the block commits, and run-probes.sh runs every probe
  -- against one database in sequence, so a stray approved redemption or filled
  -- order in a second family is exactly the quiet contamination that turns one
  -- unattributed check here into one false failure somewhere else later. Done
  -- as the owner rather than as the child so that the deletes rest on nothing
  -- this probe measures (0218's and 0220's `_mng_delete` policies are not under
  -- test). What DOES persist after a green run, all idempotent under `on
  -- conflict` and re-seeded identically next time: ctl_fam, its two manager
  -- memberships, ctl_currency, ctl_wallet, and the `subscriptions` and
  -- `family_ai_settings` rows 0257's `on_family_created` creates for any new
  -- family. No redemption and no order.
  reset role;
  delete from public.economy_redemptions where family_id = ctl_fam;
  delete from public.invest_orders where family_id = ctl_fam;
  set local role authenticated;

  -- A failed control makes 1, 2, 4 and 5 unreadable, so say WHY here, while the
  -- reason is still in hand. The boundary is not reported as holding and it is
  -- not reported as broken: it is reported as unproven, and the build is red
  -- either way.
  if not control_ok then
    raise exception 'economy-invest-decision: the decision-status boundary is UNPROVEN (the control it rests on did not hold): %', control_why;
  end if;

  -- 1. A child may not create an already-approved redemption.
  begin
    insert into public.economy_redemptions
      (family_id, currency_id, member_id, title, cost, status, requested_by, decided_by, decided_at)
    values (fam, currency, child_mid, 'Console', 1, 'approved', child_uid, parent_uid, now());
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child inserted an APPROVED economy redemption (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 2. A child may not create an already-filled invest order. Priced AT THE
  --    ASSET, one share, amount equal to that price, so that 0306's economics
  --    guard has nothing to refuse and 0304's manager gate is the only thing
  --    that can: with 0304's list emptied this row LANDS and is reported as the
  --    BREACH it is, rather than dying on 0306's unhandled 23514.
  begin
    insert into public.invest_orders
      (family_id, child_wallet_id, asset_id, side, shares, price_cents, amount_cents,
       status, requested_by, decided_by, decided_at)
    values (fam, wallet, asset, 'buy', 1, asset_price, asset_price, 'filled', child_uid, parent_uid, now());
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child inserted a FILLED invest order (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Asking is still allowed — the positive control. A guard that blocked
  --    this would have closed the feature rather than the hole.
  begin
    insert into public.economy_redemptions
      (family_id, currency_id, member_id, title, cost, status, requested_by)
    values (fam, currency, child_mid, 'Sticker', 1, 'pending', child_uid)
    returning id into queued;
    if queued is null then
      raise warning 'CONTROL FAILED: a child could not REQUEST a redemption';
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not REQUEST a redemption (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 4. Nor may they approve the one they queued. This is 0218's
  --    `economy_redemptions_mng_update` USING clause and nothing else — the row
  --    is filtered out before 0304's trigger could see it (header).
  if queued is not null then
    begin
      update public.economy_redemptions
         set status = 'approved', decided_by = parent_uid, decided_at = now()
       where id = queued;
      get diagnostics n = row_count;
      if n > 0 then
        raise warning 'BREACH: a child approved their own queued redemption (rows: %)', n;
        failures := failures + 1;
      end if;
    exception when insufficient_privilege then null;
    end;

    -- 5. Not even to cancel. This differs from reward_redemptions, where 0295
    --    deliberately leaves 'cancelled' open to the member who asked: THIS
    --    table's UPDATE policy is manager-only (economy_redemptions_mng_update),
    --    so a child cannot change their own row at all. Asserted so the
    --    difference is recorded rather than rediscovered — an earlier draft of
    --    this probe assumed the reward-table behaviour and reported the
    --    product's actual design as a control failure.
    begin
      update public.economy_redemptions set status = 'cancelled' where id = queued;
      get diagnostics n = row_count;
      if n <> 0 then
        raise warning 'UNEXPECTED: a child updated their own economy redemption (rows: %)', n;
        failures := failures + 1;
      end if;
    exception when insufficient_privilege then null;
    end;
  end if;

  reset role;

  -- 6. A manager still decides, or the guard has broken the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    insert into public.economy_redemptions
      (family_id, currency_id, member_id, title, cost, status, requested_by, decided_by, decided_at)
    values (fam, currency, child_mid, 'Manager grant', 1, 'approved', parent_uid, parent_uid, now());
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not record an approved redemption (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not record an approved redemption (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'economy-invest-decision: % assertion(s) failed', failures;
  end if;
  raise notice 'economy-invest-decision: OK — the same child CAN record an approved redemption, a filled order and an approval in the family they DO manage (the negative control), and in the family they do not they may only ask';
end
$probe$;

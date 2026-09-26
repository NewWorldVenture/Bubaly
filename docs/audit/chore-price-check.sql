-- The chore's OWN price, which 0305 did not reach.
--
-- 0305 closed `chore_assignments.cash_awarded_cents` — the override a manager
-- writes at approval. The payout reads that column with a FALLBACK:
--
--   app/(app)/wallet/actions.ts:206
--     const amount = assignment.cash_awarded_cents ?? chore?.cash_cents ?? 0;
--
-- An ordinary chore has no override, so the number a parent's Pay click credits
-- is `chores.cash_cents` — and `chores` carries four permissive policies whose
-- whole condition is `is_family_member(family_id)`.
--
-- This is worse than the column 0305 fixed, not the same. There the chores
-- board's `canPay = … && !a.cash_awarded_cents` happened to hide the button
-- once the column was set. Here the button's condition is
-- `(a.chore?.cash_cents ?? 0) > 0 && !a.cash_awarded_cents`
-- (components/modules/chores-module.tsx:554) — exactly the state a child can
-- manufacture. The parent is shown "Pay $5,000.00" on a chore their child wrote
-- and priced.
--
-- Points are the second number: the chores board's approve writes
-- `points_awarded: chore.points`, and lib/chores/dashboard.ts counts
-- `a.points_awarded ?? a.chore?.points`. A member may still CREATE a chore
-- carrying points — the assistant's own tasks service does exactly that as the
-- calling user (lib/services/tasks/index.ts, `points: input.points ?? 10`) and
-- a guard on INSERT would close that path. Re-pricing an existing chore is
-- nobody's business but a manager's, so that is what is asserted.
--
-- Judged on ROW COUNTS: an INSERT nothing refuses simply lands, and an
-- exception-only assertion would report a boundary that is not there.
--
-- NEGATIVE CONTROL, and it runs FIRST, before the refusals it gives meaning to
-- ---------------------------------------------------------------------------
-- THE MECHANISM IS NOT A POLICY, and naming it wrongly would point the control
-- at the wrong thing. `chores` still carries only the four permissive policies
-- 0004_rls.sql generates for every family-scoped table — chores_select,
-- chores_insert, chores_update, chores_delete, each one `is_family_member(
-- family_id)` and nothing more (0004_rls.sql:22 lists 'chores' in fam_tables).
-- Nothing later narrows them: no migration creates, drops or re-creates a policy
-- on public.chores, and 0254's restrictive manager guards cover the five wallet
-- tables only. RLS therefore lets a child write this table, and always did.
--
-- What refuses a price is a TRIGGER: `trg_chore_price_guard`, a BEFORE INSERT OR
-- UPDATE FOR EACH ROW trigger running `public.chore_price_guard()`, created by
-- 0307_chore_prices_are_manager_set.sql. 0307 is the LAST migration to create
-- it, not merely the first: `grep -rl chore_price_guard supabase/migrations`
-- returns 0307 alone, and `grep -niE "on +(public\.)?chores\b"` across the tree
-- returns only 0002's family index and 0307's own drop+create. Four migrations
-- sorting after 0307 contain the word `chores` (0308, 0311, 0331, 0341); only
-- 0311 names the TABLE in SQL, as the parent of chore_assignments.chore_id in
-- its foreign-key inventory, and the other three say it in prose alone (0308's
-- "chores economy", 0331's and 0341's `lib/chores/logic.ts`). None attaches
-- anything to public.chores. The only other trigger on the table is 0003's
-- `trg_set_updated_at`, attached by its dynamic loop over every table with an
-- updated_at column — and check 9 below stops the reader having to trust this
-- paragraph: it reads pg_trigger and requires the table to carry exactly those
-- two triggers, and check 10 reads the guard's own body for the predicate.
--
-- THE PREDICATE is the guard's last exemption. It raises 42501 unless
-- `current_user = 'service_role'`, `coalesce(auth.role(),'') = 'service_role'`,
-- `auth.uid() is null`, or `public.can_manage_family(new.family_id)`
-- (0307:88-91). The first three are pinned shut before anything else runs: the
-- session is `authenticated` with a live `auth.uid()`, which the is_family_member
-- / can_manage_family sanity pair below asserts — a null `auth.uid()` would make
-- is_family_member(fam) false and stop the probe there. So
-- `can_manage_family(new.family_id)` is the one question left, and it is the one
-- thing the control changes.
--
-- So the control is the same child, the same trigger, the same four statements,
-- in a SECOND family where that child IS a manager: the same actor through the
-- same predicate with the answer the other way, and all four must land. Without
-- it, checks 2-5 are refusals with no attribution:
--
--   * 2's INSERT catches `insufficient_privilege` and credits the guard — but
--     42501 is equally what a missing or revoked table GRANT raises, what a
--     column-level denial raises, what a dead `auth.uid()` raises, and what
--     every OTHER guard trigger in this repository raises (0223, 0305, 0326,
--     0331 all refuse with errcode 42501). Add a trigger to `chores` for an
--     unrelated rule and check 2 would keep passing with 0307's
--     `can_manage_family` loosened back to `is_family_member`;
--   * 3, 4 and 5 assert ZERO ROWS, and a row this session cannot SEE reports
--     zero just as readily as a refused write does. `priced` is inserted before
--     the session switches to the child, so nothing above proves the child's
--     session could reach that row at all.
--
-- What the control CANNOT rule out on its own is a second guard trigger written
-- in this repository's house style — every sibling guard (0223, 0305, 0326,
-- 0331) exempts managers with `or public.can_manage_family(new.family_id)`.
-- Such a trigger would let the control's four writes land (the child manages
-- ctl_fam) and refuse the child in `fam`, so checks 2-5 would stay green with
-- 0307's predicate loosened, and the probe would credit 0307 for a boundary
-- another trigger was holding. That is closed structurally rather than
-- behaviourally: check 9 requires `pg_trigger` on public.chores to hold exactly
-- trg_chore_price_guard and trg_set_updated_at, and check 10 requires the body
-- of public.chore_price_guard() to still call `can_manage_family(new.family_id)`
-- — the assertion 0307 itself makes. A second trigger, however it is written,
-- turns the probe red until someone re-attributes the refusals.
--
-- The control does move two variables at once — the family and the role — so
-- by itself it cannot separate a confound scoped to `fam` or to the `priced`
-- row from the predicate. It leans on the same facts checks 9 and 10 assert
-- (one guard trigger, four permissive policies, no column revoke) to make that
-- distinction; a same-family control (promote, write, demote) would move one
-- variable, and is the shape to reach for if those assertions ever stop being
-- true. The different-family shape is the house pattern
-- (money-write-boundary-check.sql), kept here for the same reason.
--
-- The control also READS BACK what it wrote. Row counts alone would credit a
-- BEFORE trigger that returned a rewritten NEW — zeroing cash_cents instead of
-- raising — with four stored rows that stored nothing, and report that the
-- child CAN price a chore when they cannot: the failure mode the header warns
-- about, inverted. So after the fourth leg the control selects the four price
-- columns of its own row and requires 500000 / 9999 / 500000 / 900000.
--
-- Each control statement names THE SAME COLUMNS as the refusal it stands for —
-- `cash_cents` alone for 3, `points` alone for 4, `cash_min_cents` and
-- `cash_max_cents` together for 5 — because a column-level
-- `revoke update (cash_cents) on chores from authenticated` sails straight past
-- a control that only touched `points`, and would then turn check 3 into a
-- refusal credited to a guard that had been loosened. Each also CHANGES the
-- value it writes: the guard keys on `is distinct from`, so a control that wrote
-- 500 over 500 would never enter the guarded branch and would prove only that
-- the row was writable, not that the manager branch returns NEW.
--
-- Check 8's manager is NOT this control. It proves the guard lets SOMEBODY
-- through; it says nothing about whether the CHILD's session could have written
-- a price column anywhere — the exact gap that let the document-vault probe pass
-- for a release while the teen could not INSERT a document at all.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000cf01';
  parent_uid uuid := '00000000-0000-4000-8000-00000000cfa1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000cfa2';
  child_mid uuid;
  priced uuid;
  n int;
  failures int := 0;
  -- The control household: a SECOND family the same child manages. Fresh UUIDs,
  -- checked absent from docs/audit and supabase/migrations before use, in this
  -- probe's own cf** anchor style — every probe run-probes.sh globs shares one
  -- database in sequence, and the rows a probe seeds outlive it.
  ctl_fam uuid := '00000000-0000-4000-8000-00000000cf02';
  ctl_chore uuid;
  control_ok boolean := true;
  control_failures text[] := '{}';
begin
  delete from public.chore_assignments where family_id = fam;
  delete from public.chores where family_id = fam;
  delete from public.chore_assignments where family_id = ctl_fam;
  delete from public.chores where family_id = ctl_fam;

  insert into auth.users (id, email) values
    (parent_uid, 'price-parent@example.com'), (child_uid, 'price-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Chore Prices', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  -- ── The negative control's own household ────────────────────────────────────
  -- A second family the SAME child created, so `can_manage_family` answers YES
  -- for the very user it answers NO for in `fam`. handle_new_family already files
  -- the creator as a 'parent' and seeds a subscriptions row and a
  -- family_ai_settings row alongside (0257); upsert the membership rather than
  -- assume it, because a seed whose roles are wrong would fail the control for a
  -- reason that is not the control's. It has no other members, and the WHOLE
  -- household — chores, membership, the families row and everything that
  -- cascades from it — is deleted once the control has run, so nothing of it
  -- reaches a later probe (approval-dedupe-check.sql picks `any other family`
  -- with no ORDER BY, and a second run over the same database would otherwise
  -- offer it this one).
  insert into public.families (id, name, created_by)
    values (ctl_fam, 'Chore Prices (the child''s own house)', child_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (ctl_fam, child_uid, 'Child (a manager here)', 'parent', true)
  on conflict (family_id, user_id) do update set role = 'parent', is_active = true;

  -- A chore a manager priced, for the re-pricing assertions below.
  insert into public.chores (family_id, title, points, cash_cents)
    values (fam, 'Mow the lawn', 5, 500) returning id into priced;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- ── NEGATIVE CONTROL: the same child, the same trigger, the other answer ────
  -- Runs FIRST, before checks 2-5, which are the refusals it gives meaning to.
  -- `can_manage_family(new.family_id)` is the one question 0307's
  -- trg_chore_price_guard asks once the session is authenticated with a live
  -- auth.uid() (both asserted immediately above), so the control asks that one
  -- question the other way: this SAME child, in the family they DO manage,
  -- setting a price on INSERT and then changing cash, points and the cash range
  -- on UPDATE — the same four statements checks 2-5 expect refused, naming the
  -- same columns, each writing a DIFFERENT value so the guard's
  -- `is distinct from` branch is actually entered. All four must land.
  --
  -- What it catches: a revoked table GRANT, a column-level
  -- `revoke update (cash_cents)`, a dead auth.uid(), a second trigger on `chores`
  -- whose refusal is NOT scoped to the manager role — every one of which raises
  -- the same 42501 check 2 credits to the WITH-CHECK-shaped half of the guard,
  -- and every one of which makes checks 3-5 report zero rows for a reason that
  -- is not 0307's. Any of them with 0307's `can_manage_family` loosened back to
  -- `is_family_member` would leave this probe green while the hole was open. If
  -- the control does not hold, the boundary is reported as UNPROVEN — not as
  -- holding, not as broken — and the build is red either way.
  --
  -- What it does NOT catch, and checks 9 and 10 exist for: a second trigger that
  -- exempts managers the way every sibling guard here does. That one lets the
  -- control through and refuses the child in `fam` exactly as 0307 would.
  if not public.can_manage_family(ctl_fam) then
    control_ok := false;
    control_failures := array_append(control_failures,
      'the control household is not one this child manages, so nothing written in it can answer the guard''s predicate the other way');
  end if;

  if control_ok then
    begin
      -- Mirrors check 2: an INSERT that sets cash at all. 500, not 500000, so the
      -- UPDATE below has something distinct to change it to.
      insert into public.chores (family_id, title, cash_cents)
        values (ctl_fam, 'Wash the car (my own house)', 500)
        returning id into ctl_chore;
      get diagnostics n = row_count;
      if n <> 1 or ctl_chore is null then
        control_ok := false;
        control_failures := array_append(control_failures,
          format('this child''s INSERT of a CASH-paying chore in the family they DO manage stored %s row(s), so check 2''s refusal would prove nothing about the manager gate', n));
      end if;
    exception when others then
      control_ok := false;
      control_failures := array_append(control_failures,
        format('this child was refused a CASH-paying chore in the family they DO manage (%s: %s), so check 2''s refusal would prove only that something said no — not that a manager gate said it', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok then
    begin
      -- Mirrors check 3: the same single column, and a value distinct from 500,
      -- so `new.cash_cents is distinct from old.cash_cents` is true and the
      -- guarded branch is what is being exercised.
      update public.chores set cash_cents = 500000 where id = ctl_chore;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        control_failures := array_append(control_failures,
          format('this child''s UPDATE of cash_cents on a chore they DO manage changed %s row(s), so check 3''s zero-row refusal would prove nothing: a row this session cannot write reports zero either way', n));
      end if;
    exception when others then
      control_ok := false;
      control_failures := array_append(control_failures,
        format('this child''s UPDATE of cash_cents on a chore they DO manage raised %s: %s — so check 3 measures that, not the manager gate', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok then
    begin
      -- Mirrors check 4: `points` alone. The insert above left it at the column
      -- default of 10, so 9999 is a genuine re-pricing and points_repriced is
      -- true.
      update public.chores set points = 9999 where id = ctl_chore;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        control_failures := array_append(control_failures,
          format('this child''s UPDATE of points on a chore they DO manage changed %s row(s), so check 4''s zero-row refusal would prove nothing', n));
      end if;
    exception when others then
      control_ok := false;
      control_failures := array_append(control_failures,
        format('this child''s UPDATE of points on a chore they DO manage raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  if control_ok then
    begin
      -- Mirrors check 5: both range columns in one SET list, as check 5 writes
      -- them. Both are NULL on the control's row, so both are distinct.
      update public.chores set cash_min_cents = 500000, cash_max_cents = 900000 where id = ctl_chore;
      get diagnostics n = row_count;
      if n <> 1 then
        control_ok := false;
        control_failures := array_append(control_failures,
          format('this child''s UPDATE of the cash range on a chore they DO manage changed %s row(s), so check 5''s zero-row refusal would prove nothing', n));
      end if;
    exception when others then
      control_ok := false;
      control_failures := array_append(control_failures,
        format('this child''s UPDATE of the cash range on a chore they DO manage raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  -- Read back what the four legs wrote, still as the child. `row_count = 1` is
  -- what a BEFORE trigger that RETURNS a rewritten NEW reports too — one that
  -- zeroed cash_cents instead of raising would leave every leg above green with
  -- nothing stored, and the control would then vouch for a manager gate that
  -- had quietly refused. The stored values are the only proof the writes landed.
  if control_ok then
    declare
      got_cash int; got_points int; got_min int; got_max int;
    begin
      select cash_cents, points, cash_min_cents, cash_max_cents
        into got_cash, got_points, got_min, got_max
        from public.chores where id = ctl_chore;
      if not found then
        control_ok := false;
        control_failures := array_append(control_failures,
          'the control''s own chore cannot be read back by the child who wrote it, so nothing above proves a row was stored at all');
      elsif got_cash is distinct from 500000 or got_points is distinct from 9999
         or got_min is distinct from 500000 or got_max is distinct from 900000 then
        control_ok := false;
        control_failures := array_append(control_failures,
          format('the control''s four writes reported one row each but stored cash_cents=%s points=%s cash_min_cents=%s cash_max_cents=%s (expected 500000 / 9999 / 500000 / 900000), so something rewrote them on the way in and the row counts vouch for nothing', got_cash, got_points, got_min, got_max));
      end if;
    exception when others then
      control_ok := false;
      control_failures := array_append(control_failures,
        format('reading the control''s own chore back raised %s: %s', sqlstate, sqlerrm));
    end;
  end if;

  -- The control household does not outlive the control. This delete only ever
  -- does work on the GREEN path: a failed control raises just below, the DO
  -- block aborts, and the transaction — ctl_fam, its membership, the priced
  -- chore, the opening deletes, all of it — rolls back on its own. On the green
  -- path the block COMMITS, and a stray second family the child manages, with
  -- or without a cash-priced chore in it, is exactly the quiet contamination
  -- that turns one probe's control into another probe's false failure later in
  -- the same run (or the next run over the same database). So the WHOLE
  -- household goes, as the owner: the chore, the membership, and the families
  -- row, which cascades to the subscriptions and family_ai_settings rows
  -- handle_new_family filed — every FK onto families is CASCADE or SET NULL.
  -- Deleting the child's membership is safe under 0299's
  -- trg_family_keeps_a_manager: it is DEFERRABLE INITIALLY DEFERRED, and a
  -- family with no active members (or no families row) is explicitly not a
  -- violation. money-write-boundary-check.sql cleans its ctl_fam the same way.
  reset role;
  delete from public.chores where family_id = ctl_fam;
  delete from public.family_members where family_id = ctl_fam;
  delete from public.families where id = ctl_fam;
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not control_ok then
    raise exception 'chore-price: the chore price boundary is UNPROVEN (the control this probe rests on did not hold): %',
      array_to_string(control_failures, ' | ');
  end if;

  -- 1. A member may still add a chore, points and all — the positive control.
  --    The assistant's tasks service does this as the calling user, so a guard
  --    that blocked it would have closed a working path rather than the hole.
  begin
    insert into public.chores (family_id, title, points) values (fam, 'Tidy my room', 10);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a member could not add a chore (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a member could not add a chore (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. But not one that pays cash. This is the number payChoreRewardAction
  --    credits when the assignment carries no override, which is the ordinary
  --    case.
  begin
    insert into public.chores (family_id, title, cash_cents) values (fam, 'Wash the car', 500000);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child created a chore paying % cents (rows: %)', 500000, n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Nor raise the cash on a chore a manager priced.
  begin
    update public.chores set cash_cents = 500000 where id = priced;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child re-priced a manager''s chore in cash (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Nor its points, which the board copies into points_awarded on approval.
  begin
    update public.chores set points = 9999 where id = priced;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child re-priced a manager''s chore in points (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Nor smuggle the cash in via the range columns the reward modes read.
  begin
    update public.chores set cash_min_cents = 500000, cash_max_cents = 900000 where id = priced;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child set a chore''s cash range (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. Renaming the chore is still theirs to do — the second positive control.
  --    A guard written on the row rather than on the columns would fail here.
  begin
    update public.chores set title = 'Mow the lawn (front)' where id = priced;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a member could not edit a chore''s text (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a member could not edit a chore''s text (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 7. And what the payout would read is still what the manager set.
  select cash_cents into n from public.chores where id = priced;
  if n <> 500 then
    raise warning 'BREACH: the chore the payout reads is now priced at % cents', n;
    failures := failures + 1;
  end if;

  reset role;

  -- 8. A manager still prices a chore, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    insert into public.chores (family_id, title, points, cash_cents)
      values (fam, 'Clean the gutters', 20, 1500);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not price a chore (rows: %)', n;
      failures := failures + 1;
    end if;
    update public.chores set cash_cents = 750, points = 8 where id = priced;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not re-price a chore (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not price a chore (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  -- 9. The refusals above are 0307's and nobody else's: public.chores carries
  --    exactly two user triggers, trg_chore_price_guard (BEFORE INSERT OR UPDATE,
  --    FOR EACH ROW, running public.chore_price_guard(), enabled) and 0003's
  --    trg_set_updated_at. A second trigger in the house style — one that
  --    exempts managers with `or can_manage_family(new.family_id)` — would let
  --    the control land and refuse the child in `fam` just as 0307 does, so
  --    checks 2-5 cannot tell them apart; this can. Foreign-key constraint
  --    triggers are internal and not counted.
  declare
    trigger_names text;
    guard_shape boolean;
  begin
    select string_agg(tgname, ', ' order by tgname) into trigger_names
      from pg_trigger
     where tgrelid = 'public.chores'::regclass and not tgisinternal;
    if trigger_names is distinct from 'trg_chore_price_guard, trg_set_updated_at' then
      raise warning 'ATTRIBUTION FAILED: public.chores carries the trigger(s) [%], not exactly trg_chore_price_guard and trg_set_updated_at, so a refusal above may not be 0307''s', coalesce(trigger_names, '(none)');
      failures := failures + 1;
    end if;
    -- tgtype bits: 1 = FOR EACH ROW, 2 = BEFORE, 4 = INSERT, 16 = UPDATE.
    -- tgenabled 'O' (origin) or 'A' (always) fires in an ordinary session.
    select tgfoid = 'public.chore_price_guard'::regproc
       and tgtype & 23 = 23
       and tgenabled in ('O', 'A')
      into guard_shape
      from pg_trigger
     where tgrelid = 'public.chores'::regclass and tgname = 'trg_chore_price_guard';
    if not coalesce(guard_shape, false) then
      raise warning 'ATTRIBUTION FAILED: trg_chore_price_guard is not an enabled BEFORE INSERT OR UPDATE FOR EACH ROW trigger running public.chore_price_guard()';
      failures := failures + 1;
    end if;
  end;

  -- 10. And the guard still asks the question the control answered: 0307's body
  --     exempts `public.can_manage_family(new.family_id)` and nothing looser.
  --     Comments are stripped before matching so a body that only MENTIONS the
  --     predicate in prose does not pass. The same catalog read
  --     migration-ledger-state.sql makes of mark_model_dirty.
  if regexp_replace(pg_get_functiondef('public.chore_price_guard'::regproc), E'--[^\n]*', '', 'g')
       not like '%public.can_manage_family(new.family_id)%' then
    raise warning 'ATTRIBUTION FAILED: public.chore_price_guard() no longer calls public.can_manage_family(new.family_id), so the control''s YES and checks 2-5''s NO are answers to a different question than 0307''s';
    failures := failures + 1;
  end if;

  if failures > 0 then
    raise exception 'chore-price: % assertion(s) failed', failures;
  end if;
  raise notice 'chore-price: OK — the same child CAN set and change a chore''s cash, points and cash range in the family they manage (control, read back), and in the family they do not they cannot price one; a member may still add and edit a chore; a manager may still price one; chores carries exactly 0307''s guard and updated_at, and the guard still asks can_manage_family';
end
$probe$;

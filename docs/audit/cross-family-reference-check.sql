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
  control_ok boolean := true;
  -- For the structural assertion: the helper's pg_proc row and 0311's wiring
  -- list, read back out of pg_trigger rather than assumed from the sqlstate.
  w record;
  helper_oid oid;
  helper_src text;
  helper_secdef boolean;
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
  --
  --    These two INSERTs are also the negative control's mirror for 2, 3 and
  --    4: the same actor, the same statements and the same column lists, with
  --    only the referenced row's family answered the other way. So a failure
  --    here is not one more red assertion among seven — it makes 2, 3 and 4
  --    unreadable, and it feeds `control_ok` so the block stops at UNPROVEN
  --    below rather than carrying on to credit three swallowed 42501s. A row
  --    count of 0 with no exception is a real case, not a hypothetical: a
  --    BEFORE trigger that returns NULL suppresses the row silently, and would
  --    make 2, 3 and 4 report "zero rows" for the same non-reason.
  begin
    insert into public.chore_assignments (family_id, chore_id, member_id, status)
      values (famA, choreA, midA, 'todo');
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      raise warning 'CONTROL FAILED: a manager could not assign their own chore (rows: %), so 2 and 3''s refusals of B''s chore and member would prove nothing', n;
      failures := failures + 1;
    end if;
    insert into public.allowance_rules (family_id, child_wallet_id, amount_cents, cadence, is_active, next_run_on)
      values (famA, walletA, 500, 'weekly', true, current_date);
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      raise warning 'CONTROL FAILED: a manager could not set their own allowance rule (rows: %), so 4''s refusal of B''s wallet would prove nothing', n;
      failures := failures + 1;
    end if;
  exception when others then
    control_ok := false;
    raise warning 'CONTROL FAILED: a manager could not do their own family''s work (% %), so a refusal below is not attributable to the family-reference trigger — only to something saying no', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- ── NEGATIVE CONTROL, and it runs before every refusal it gives meaning to ─
  --
  -- The mechanism under test here is a TRIGGER, not a policy, and that is the
  -- premise at the top of this file: RLS on these tables checks the row's OWN
  -- family_id and nothing else, so a policy cannot be what refuses 2 through 5.
  -- What refuses them is `public.reference_shares_family()`, wired by
  -- `supabase/migrations/0311_family_scoped_references.sql` onto exactly the
  -- three references this probe exercises:
  --
  --   trg_allowance_rules_child_wallet_id_family  (child_wallet_id -> child_wallets)
  --   trg_chore_assignments_chore_id_family       (chore_id        -> chores)
  --   trg_chore_assignments_member_id_family      (member_id       -> family_members)
  --
  -- 0311 is the LAST migration to create those three, not merely the first.
  -- The trigger names are assembled with format(), so they grep for nothing and
  -- the name is no use here; the helper is what to follow, and it is named in
  -- only two migrations. 0313 re-uses it for meal_plans.meal_id and
  -- grocery_items.list_id without redefining it and without re-wiring these
  -- three, and nothing after 0313 mentions it at all. The permissive policies
  -- beside it are 0004's `chores_*` / `chore_assignments_*` is_family_member
  -- CRUD and 0088's FOR ALL "Members manage allowance_rules" — every one of
  -- them keyed on the row's own family_id and nothing else. The only role gates
  -- are 0306's three RESTRICTIVE allowance_rules can_manage_family guards
  -- (insert / update / delete), which this session satisfies (asserted above).
  -- So no policy is standing between A and B's wallet; the trigger is.
  --
  -- That trigger raises `using errcode = '42501'`: insufficient_privilege, the
  -- exact condition 2 through 5 catch and credit it with. Which is the defect,
  -- because 42501 is not a signature of anything:
  --
  --   * a revoked or narrowed table GRANT raises 42501. (Table-level is the
  --     only privilege story reachable here: pg-bootstrap.sh grants
  --     `authenticated` ALL on every public table before a migration runs, and
  --     Postgres does not let a column-level REVOKE subtract from a table-level
  --     grant — measured: after `revoke update (child_wallet_id) …`,
  --     has_column_privilege() still says true. Only a database whose grant
  --     was per-column to begin with could refuse one column and not another.)
  --   * so does ANY other guard trigger whose rule happens to refuse THIS
  --     write. chore_assignments already carries a second one —
  --     trg_chore_assignment_decision_guard, from 0223, re-created in 0305 and
  --     again in 0331. It returns early for `can_manage_family(new.family_id)`
  --     and this session manages A, so it is not what says no today. What this
  --     control catches is the guard that ALSO refuses the own-family write —
  --     one keyed on the actor, the table or the time rather than on the
  --     reference — because with 0311's trigger dropped, 4 and 5 would swallow
  --     its 42501 and read green. A guard that lets the own-family write
  --     through while 0311's trigger is gone is a different failure, and not
  --     this control's to catch: 4 and 5 then LAND, and their row counts say
  --     BREACH. The structural assertion below closes the remaining gap —
  --     "something refuses B's wallet, but is it 0311's trigger?" — by reading
  --     the wiring out of pg_trigger rather than inferring it from a sqlstate;
  --   * 5 asserts ZERO ROWS, and a row this session cannot WRITE reports zero
  --     rows just as readily as a trigger that refuses the new value does;
  --   * 6 asserts zero rows for a READ, and a chores SELECT policy that denied
  --     everything reports zero just as readily as a family-scoped one.
  --
  -- A dead auth.uid() is NOT on that list, and the reason is worth getting
  -- right in a file about mis-crediting 42501s: it does not make the trigger
  -- refuse, it makes the trigger STAND ASIDE (the helper's third exemption,
  -- `auth.uid() is null -> return new`, is for migrations and seeds). What
  -- would then say no is RLS — is_family_member(family_id) has no user to
  -- find — and that is caught by the can_manage_family(famA) assertion at the
  -- top of this block, before 1 runs. Noted so it is not covered twice.
  --
  -- So the control is the same actor, the same trigger and the same statements,
  -- with the one thing the mechanism keys on — whose family the REFERENCE lives
  -- in — answered the other way. Both legs must land.
  --
  -- The UPDATE leg names `child_wallet_id`, the very column 5 writes, and that
  -- is load-bearing rather than incidental: the trigger is `before insert or
  -- update OF child_wallet_id, family_id`, and an UPDATE OF trigger fires on
  -- the SET list, not on whether a value changed. A control that set
  -- `amount_cents` instead would never reach the trigger at all, and would
  -- prove only that this session can write SOME column of the row — which is
  -- not what 5 needs. Re-pointing the rule at the wallet it ALREADY names runs
  -- the entire path 5 runs (RLS UPDATE, 0306's restrictive guard, the trigger
  -- with ref_fam = famA) while changing no data.
  --
  -- It sits here, after 1, rather than at the very top of the block, because it
  -- needs the rule whose re-pointing 5 attempts, and seeding a SECOND rule
  -- under A would make 5 match two rows and break 7's exact count of one.
  -- Setting walletA — the value the row already holds — is what keeps 5 and 7
  -- seeing precisely what they saw before this control existed, while still
  -- proving this session can write that column of that row.
  --
  -- 1's own INSERTs are the mirror for 2, 3 and 4, and they now feed
  -- `control_ok` for exactly that reason (see 1). They say nothing about 5 or
  -- 6: reaching the trigger on INSERT is not evidence that this session could
  -- UPDATE the stored row, nor that it could SELECT `chores` at all. Hence the
  -- two legs below.
  begin
    update public.allowance_rules
      set child_wallet_id = walletA
      where family_id = famA;
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      raise warning 'CONTROL FAILED: a manager re-pointing their own rule at their OWN wallet — the same table, row and column 5 writes — changed % row(s), so 5''s zero rows would prove nothing', n;
      failures := failures + 1;
    end if;
  exception when others then
    control_ok := false;
    raise warning 'CONTROL FAILED: a manager could not re-point their own allowance rule at their own family''s wallet (% %), so a refusal below is not attributable to the family-reference trigger — only to something saying no', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  begin
    select count(*) into n from public.chores where id = choreA;
    if n <> 1 then
      control_ok := false;
      raise warning 'CONTROL FAILED: family A cannot read family A''s OWN chore (rows: %), so 6''s zero rows for B''s chore say nothing about a family boundary', n;
      failures := failures + 1;
    end if;
  exception when others then
    control_ok := false;
    raise warning 'CONTROL FAILED: family A could not read its own chore at all (% %), so 6 is measuring the absence of a read, not the presence of a boundary', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- A failed control makes every refusal below unreadable, so the verdict is
  -- neither "holds" nor "broken" — it is UNPROVEN, and the build is red either
  -- way. Said here, while the reason is still in hand: 5's own statement is
  -- wrapped in `exception when insufficient_privilege then null`, so a revoked
  -- UPDATE privilege would otherwise be swallowed one line later and reported
  -- as the boundary doing its job.
  if not control_ok then
    raise exception 'cross-family-reference: boundary UNPROVEN (the control these assertions rest on did not hold) — see the CONTROL FAILED warning(s) above';
  end if;

  -- ── The guard this file credits is the guard that is wired ──────────────────
  --
  -- The control above proves this session CAN write these columns when the
  -- reference is its own; 2 through 5 prove SOMETHING refuses them when it is
  -- not. Neither says the something is 0311's trigger. This does, the way 0331
  -- verifies its own guard (pg_trigger + pg_proc), and it asserts what 0311's
  -- validated loop asserts when it wires each row: one enabled BEFORE INSERT OR
  -- UPDATE OF <col>, family_id row trigger per reference, bound to
  -- public.reference_shares_family with (<col>, <parent>) as its arguments.
  -- Matched on SHAPE — function, event, column list, arguments — and not on
  -- the name, because the name is assembled with format() in 0311 and appears
  -- literally nowhere; renaming it should not fail this, and a decoy that kept
  -- the name while dropping `family_id` from the OF list should.
  --
  -- The helper itself: still SECURITY DEFINER (it must read the PARENT row
  -- across RLS — under A's own session B's wallet is invisible, ref_fam would
  -- come back null, and the helper's "let the foreign key handle it" branch
  -- would wave the write through), still comparing against new.family_id, and
  -- still raising the 42501 that 2 through 5 catch. Read from prosrc, the
  -- column, rather than pg_get_functiondef(), so nothing here can raise.
  --
  -- Placed AFTER the control gate on purpose: a decoy refusal must be caught
  -- by the control, as a control failure, and not here as a wiring one.
  select p.oid into helper_oid
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'reference_shares_family' and p.pronargs = 0;
  if helper_oid is null then
    raise warning 'BREACH: public.reference_shares_family() no longer exists, so no refusal below can be 0311''s';
    failures := failures + 1;
  else
    select p.prosrc, p.prosecdef into helper_src, helper_secdef from pg_proc p where p.oid = helper_oid;
    if not helper_secdef
       or helper_src not like '%new.family_id%'
       or helper_src not like '%42501%' then
      raise warning 'BREACH: public.reference_shares_family() is no longer the guard 0311 wrote (security definer: %, compares new.family_id: %, raises 42501: %)',
        helper_secdef, helper_src like '%new.family_id%', helper_src like '%42501%';
      failures := failures + 1;
    end if;

    for w in
      select * from (values
        ('allowance_rules',   'child_wallet_id', 'child_wallets'),
        ('chore_assignments', 'chore_id',        'chores'),
        ('chore_assignments', 'member_id',       'family_members')
      ) as v(child, col, parent)
    loop
      select count(*) into n
        from pg_trigger t
        join pg_class c      on c.oid  = t.tgrelid
        join pg_namespace ns on ns.oid = c.relnamespace
       where ns.nspname = 'public' and c.relname = w.child
         and not t.tgisinternal
         and t.tgenabled in ('O', 'A')          -- fires under session_replication_role = origin
         and t.tgfoid = helper_oid
         and (t.tgtype & 23) = 23               -- ROW (1) + BEFORE (2) + INSERT (4) + UPDATE (16)
         and (select a.attnum from pg_attribute a where a.attrelid = c.oid and a.attname = w.col)       = any (t.tgattr::int2[])
         and (select a.attnum from pg_attribute a where a.attrelid = c.oid and a.attname = 'family_id') = any (t.tgattr::int2[])
         and t.tgargs = convert_to(w.col, 'UTF8') || '\x00'::bytea || convert_to(w.parent, 'UTF8') || '\x00'::bytea;
      if n <> 1 then
        raise warning 'BREACH: %.% is not guarded as 0311 wired it — expected exactly one enabled BEFORE INSERT OR UPDATE OF %, family_id row trigger bound to reference_shares_family(%, %), found %',
          w.child, w.col, w.col, w.col, w.parent, n;
        failures := failures + 1;
      end if;
    end loop;
  end if;

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

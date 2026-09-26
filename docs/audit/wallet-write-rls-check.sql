-- ── A-08 Wallet money-integrity write-RLS probe (0217 + 0224) ────────────────
-- Reusable proof that a non-manager (child) family member cannot MINT money or
-- TAMPER with the money audit trail. Run against the verify-pg.sh harness (which
-- seeds family A = the anchor). Provisions a child member of the anchor family
-- and asserts, under the `authenticated` role acting AS that child:
--   * NEGATIVE CONTROL FIRST: that same child CAN write the same money ledger in
--     a SECOND family where they are an ADULT — a manager under
--     can_manage_family() (`role in ('parent','adult')`) and NOT an admin under
--     is_family_admin() (`role = 'parent'`) — so the refusals below are
--     attributable to can_manage_family() specifically, and not to a grant, a
--     column revoke, a guard trigger, a row the session simply cannot see, or
--     the parent-only helper (see the long note above invariant 1a)
--   * INSERT into the wallet money-ledger tables is REJECTED         (0217, PLA-0580)
--   * UPDATE / DELETE of wallet_audit_logs affects 0 rows            (0224, PLA-0622)
--   * INSERT (append) into wallet_audit_logs is ALLOWED             (0224 keeps append)
-- and, as the anchor PARENT (manager), that a wallet_transactions INSERT succeeds
-- (positive control — the lockdown gates on role, it doesn't break managers).
--
--   bash docs/audit/verify-pg.sh up
--   PGHOST=/tmp/pgaudit_db PGPORT=54399 PGUSER=postgres PGDATABASE=bubaly \
--     psql -v ON_ERROR_STOP=1 -f docs/audit/wallet-write-rls-check.sql
--
-- Exit is non-zero (via RAISE EXCEPTION) if any invariant fails. This backs the
-- LB-010 exit criterion ("a non-manager INSERT to any wallet_* table is rejected").

\set FA '00000000-0000-4000-8000-0000000000f1'
\set PARENT '00000000-0000-4000-8000-000000000001'
\set KID '00000000-0000-4000-8000-000000005b01'
-- The negative control's household: a SECOND family the SAME kid manages.
-- A fresh anchor, checked against docs/audit, supabase/migrations and SEED_ALL
-- before being used — 65 probes share one database in run-probes.sh, so a UUID
-- that already means something elsewhere would quietly change what some other
-- probe asserts, and the probe that broke would not be this one. There is no
-- anchor for the kid's membership row in that family: handle_new_family (0257)
-- creates it, with a generated id, the moment the family is inserted, so an id
-- the upsert below carried would never be stored (measured: the row's id was
-- the generated one before and after the upsert). The control is the ONLY
-- place these three anchors are spelled; the DO block reads them back through
-- transaction-local settings rather than re-typing them, so there is one source
-- of truth for which family the seed creates and which family the legs write.
\set CTLFAM '00000000-0000-4000-8000-000000005bf1'

-- Provision a child member of the anchor family (idempotent).
insert into auth.users (id, email) values (:'KID','kid-probe@example.com') on conflict do nothing;
insert into public.family_members (id, family_id, user_id, role, display_name, is_active)
  values ('a8c00000-0000-4000-8000-0000000000c8', :'FA', :'KID', 'child', 'Probe Kid', true)
  on conflict (id) do nothing;

-- Seed one audit row (as the DB owner / service context) for the tamper test.
insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
  values (:'FA', :'PARENT', 'wallet_activated', 'family_wallets', 'probe seed')
  on conflict do nothing;

-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

-- ── NEGATIVE CONTROL, and it runs FIRST, before the refusals it gives meaning to
-- ---------------------------------------------------------------------------
-- Every invariant below this block is a REFUSAL, and a refusal is not a
-- boundary until something says WHY the write did not land:
--
--   * 1a catches 42501 and credits wallet_transactions' manager-only WITH CHECK
--     — but a missing or revoked table GRANT raises 42501, a column-level
--     revoke on one of the columns it names raises 42501, an `auth.uid()` that
--     has stopped resolving raises 42501, and a BEFORE INSERT guard trigger
--     raises 42501. This repository refuses writes with guard triggers in 0223,
--     0305, 0326 and 0331, so that is not hypothetical. 1a's sqlstate check
--     narrows the field to "something refused on privilege grounds"; it cannot
--     tell you WHICH of those five things did the refusing;
--   * 1b accepts ANY error as proof the write did not land, so on those four
--     tables a revoked grant reads exactly like a policy;
--   * 2 asserts ZERO ROWS, and a row this session cannot SEE reports zero rows
--     just as readily as a missing write policy does.
--
-- So: THE SAME ACTOR, through THE SAME PREDICATE, with the answer THE OTHER
-- WAY — and that write MUST LAND.
--
-- THE RULE UNDER TEST IS 0275'S, NOT 0217'S. `grep -l wallet_transactions_mng_insert
-- supabase/migrations` and take the LAST hit: 0217 created the manager-only
-- pair, 0254 added the restrictive `_manager_insert_guard` beside it, and
-- `0275_money_permissive_write_sweep.sql` DROPPED AND RE-CREATED BOTH in the
-- course of the sweep invariant 8 replays. After 0275 the name appears only in
-- 0290 (which revokes anon's DML and verifies it) and in 0342 (a comment, plus a
-- SECURITY DEFINER function that restates the policy it bypasses) — neither
-- creates or drops a policy. Both of 0275's policies are
-- `with check (public.can_manage_family(family_id))`, and can_manage_family is
-- `role in ('parent','adult') and is_active` (0003, the only definition). ONE
-- question on both the permissive and the restrictive side, so the control is
-- the same child running the same statements in a SECOND family where that
-- child IS a manager.
--
-- AND THAT MANAGER IS AN ADULT, NOT A PARENT. 0003 defines two manager-shaped
-- helpers side by side: can_manage_family (`role in ('parent','adult')`) and
-- is_family_admin (`role = 'parent'`). A parent satisfies both, so a control
-- seeded as a parent would land under either predicate and say nothing about
-- WHICH one the money policies name — and the drift that matters here is
-- exactly a policy quietly re-pointed from can_manage_family to is_family_admin
-- (or to a literal `role = 'parent'`): every refusal in this file stays red,
-- invariant 4's positive control is the anchor PARENT and stays green, invariant
-- 9 only greps the RESTRICTIVE guards for the substring, and the regression —
-- every caregiver-grade adult silently losing the ability to top up a wallet —
-- is invisible. An adult is the one member the two helpers disagree about, so
-- the kid is seeded as an adult in the control family; leg A then holds ONLY IF
-- the predicate is can_manage_family's. 0299's trg_family_keeps_a_manager is
-- satisfied (an active adult IS a manager) and is deferred to a COMMIT this
-- control never runs.
--
-- Three legs, one per refusal shape above:
--
--   A. wallet_transactions, THE SAME COMPLETE VALID CREDIT 1a is refused, naming
--      THE SAME COLUMNS. That is not decoration: a
--      `revoke insert (amount_cents) on wallet_transactions from authenticated`
--      is invisible to a control that inserts a different column list, and it
--      would leave 1a passing on a 42501 that has nothing to do with the mint
--      lock. Same columns, same amount, same statuses — only the family differs.
--   B. the four sibling money tables, THE SAME incomplete `(family_id)` insert
--      1b makes, held to the strongest claim each table allows:
--        - `family_wallets` and `wallet_rules` MUST LAND (sqlstate null): every
--          other column defaults, so nothing but the grant, a guard trigger, the
--          policy or a constraint could stop the row, and 1b's "any error" hole
--          is widest on exactly these two;
--        - `child_wallets` and `wallet_buckets` CANNOT land, because
--          `member_id` / `child_wallet_id` are NOT NULL — that is why 1b accepts
--          any error there — so the row must die in CONSTRAINT evaluation
--          (sqlstate class 23) or land. Sound because of the order ExecInsert
--          does things: BEFORE ROW triggers, then the RLS WITH CHECK options,
--          then ExecConstraints (NOT NULL, CHECK), then the heap insert and the
--          unique indexes. Measured here rather than read: the child's identical
--          `(family_id)` insert into child_wallets in the anchor family — where
--          they are NOT a manager — raises 42501, not 23502, and a second
--          family_wallets row for the control family raises 23505 only after
--          the first one landed. So a class-23 sqlstate in the manager family
--          means the grant, any BEFORE trigger and BOTH policies had already
--          said yes. 42501 (privilege, policy or guard trigger), 42703 (a column
--          the probe names is gone), 42P01 (the table is gone), P0001 (a
--          trigger's bare RAISE) and everything else outside class 23 fail.
--        - the one thing that last rule cannot see is a BEFORE INSERT trigger on
--          those two tables that raises class 23 itself, the way 0306's shape
--          guard does on invest_orders (`errcode = '23514'`): it would fire
--          before the policy in both families and read exactly like the row's
--          own NOT NULL. Every guard trigger this repository wires to a member
--          table raises 42501 (0223, 0305, 0311, 0326, 0331), and pg_trigger
--          shows no BEFORE INSERT trigger on any money table today (their only
--          triggers are the BEFORE UPDATE updated_at stamps; 0342:26-27 states
--          the same). Rather than trust that reading, the leg asserts it, for
--          the two tables where it is load-bearing.
--   C. wallet_audit_logs, THE SAME `where family_id = FA` predicate 2 tampers
--      with, as a SELECT: the child must SEE at least one row, or 2's zero rows
--      are invisibility rather than a boundary. The read is guarded like the
--      writes: a revoked SELECT grant or a dropped table would otherwise abort
--      the block with a bare "permission denied" and lose the attribution the
--      block exists to keep.
--
-- THE MECHANISM BEHIND INVARIANT 2 IS NOT AN RLS PREDICATE, AND THE CONTROL
-- SAYS SO. `wallet_audit_logs` is append-only by the ABSENCE of any UPDATE or
-- DELETE policy: 0224 dropped 0088's `FOR ALL … is_family_member` policy and
-- created only SELECT and INSERT, and `0328_wallet_audit_logs_say_who_wrote_them.sql`
-- — the last migration to touch this table's policies; the others that name it
-- (0196, 0205, 0208, 0342) only INSERT into it, and 0324, 0327 and 0333 only
-- mention it in prose — re-created the INSERT policy pinning
-- `actor_user_id = auth.uid()` and asserts in its own verification block that no
-- UPDATE or DELETE policy naming `authenticated` exists. With no policy for the
-- command, no row qualifies and the statement reports zero. There is therefore
-- no "same statement the other way" to run: no client role may ever update this
-- table, by design. So the control keys on what the zero-row claim actually
-- rests on — the row being VISIBLE, and the grant being PRESENT, because a
-- revoked UPDATE grant would make 2's unguarded statement abort with a bare
-- "permission denied for table wallet_audit_logs" and throw the attribution
-- away. The command-changed leg for this mechanism is invariant 3 (the same
-- child, same table, same family, INSERT, which must land); it raises on
-- failure, so it cannot pass silently, but it runs after 2 and is not the leg
-- that was missing.
--
-- The whole control is wrapped in begin/rollback so its household never reaches
-- the probes that run after this one — the rest of this file deliberately
-- persists its seeds, and a stray second family for the kid is exactly the
-- quiet contamination that turns one unattributed check into one false failure
-- later.
begin;

-- Seeded as the DB owner. The kid CREATED this family, so handle_new_family
-- (0257, AFTER INSERT on families, SECURITY DEFINER) has already filed them as a
-- 'parent' with a generated id; the upsert therefore always takes its `do
-- update` branch, and what it does there is DEMOTE that row to 'adult' — the
-- role can_manage_family counts and is_family_admin does not (see the note
-- above). It re-asserts is_active too rather than assuming, because a seed
-- whose roles are wrong would fail the control for a reason that is not the
-- control's — and a control that fails for its own reasons is worse than none.
insert into auth.users (id, email) values (:'KID','kid-probe@example.com') on conflict do nothing;
insert into public.families (id, name, created_by)
  values (:'CTLFAM','Probe Kid''s Own House',:'KID') on conflict do nothing;
insert into public.family_members (family_id, user_id, role, display_name, is_active)
  values (:'CTLFAM', :'KID', 'adult', 'Probe Kid (an adult here)', true)
  on conflict (family_id, user_id) do update set role = 'adult', is_active = true;

-- psql does not interpolate :'VAR' inside a dollar-quoted body, so the anchors
-- are handed to the DO block as transaction-local settings (they die with the
-- ROLLBACK below). The alternative — re-typing the three UUIDs inside the block
-- — is two sources of truth: edit `\set CTLFAM` alone and the seed would build
-- one family while leg A wrote into another that does not exist, and the
-- control would report a grant or a trigger when the fault was its own.
select set_config('a08.fa',     :'FA',     true) as fa,
       set_config('a08.kid',    :'KID',    true) as kid,
       set_config('a08.ctlfam', :'CTLFAM', true) as ctlfam;

do $$
declare
  -- current_setting raises 42704 if a setting is missing — i.e. if this block is
  -- ever moved outside the transaction that set them — which is the right noise.
  fam      constant uuid := current_setting('a08.fa')::uuid;
  kid_u    constant uuid := current_setting('a08.kid')::uuid;
  ctl_fam  constant uuid := current_setting('a08.ctlfam')::uuid;
  ledger   text[] := array['child_wallets','wallet_buckets','wallet_rules','family_wallets'];
  -- The two tables whose `(family_id)` insert has nothing left to fail on once
  -- the policy says yes; every other column defaults (0088:31-44, 100-112).
  lands    text[] := array['family_wallets','wallet_rules'];
  t        text;
  n        int;
  st       text;
  msg      text;
  failures text[] := '{}';
begin
  -- The seed and this block must agree about which family the control lives in,
  -- and the kid must be the adult the note above promises — checked as the
  -- owner, before the role switch, so a wrong seed is named as a wrong seed.
  if not exists (select 1 from public.family_members
                  where family_id = ctl_fam and user_id = kid_u
                    and role = 'adult' and is_active) then
    failures := array_append(failures, format(
      'CONTROL SEED WRONG: the child is not an active ADULT member of the control family %s — the seed above and this block disagree about the family, or the upsert no longer demotes the row 0257''s handle_new_family files; every leg below then measures the wrong member and none of them can be read',
      ctl_fam));
  end if;

  -- The same session the refusals below are measured in: the child.
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub', kid_u::text, true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  -- ── Leg A: the mint 1a is refused, in the family this child DOES manage ──
  begin
    insert into public.wallet_transactions
      (family_id, type, status, direction, amount_cents, currency, metadata)
    values (ctl_fam,'parent_top_up','completed','credit',
            999999,'usd','{"probe":"a-08 control"}'::jsonb);
    get diagnostics n = row_count;
    if n <> 1 then
      failures := array_append(failures,
        'CONTROL FAILED: this child''s COMPLETE valid $9,999.99 credit stored 0 rows in the family they DO manage, so 1a''s 42501 would prove nothing about the mint lock');
    end if;
  exception when others then
    failures := array_append(failures, format(
      'CONTROL FAILED: this child was REFUSED the same complete valid credit in the family they DO manage, as an ADULT (%s: %s) — so 1a''s 42501 is not can_manage_family''s WITH CHECK. It is a revoked table or column GRANT, a guard trigger, an auth.uid() that no longer resolves, or a predicate that has drifted to the parent-only is_family_admin (an adult would land under can_manage_family and be refused under is_family_admin); the mint lock is currently UNPROVEN',
      sqlstate, sqlerrm));
  end;

  -- ── Leg B: 1b's own statement, same order, in the manager family ─────────
  foreach t in array ledger loop
    st := null; msg := null;
    begin
      execute format(
        'insert into public.%I (family_id) values (%L)', t, ctl_fam);
    exception when others then st := sqlstate; msg := sqlerrm;
    end;
    if t = any (lands) then
      -- Every other column defaults: the row MUST land. `st is null` is the
      -- only pass — a 23505 or a new CHECK here is a write that did not land,
      -- whatever it says about the policy, and the leg does not guess.
      if st is not null then
        failures := array_append(failures, format(
          'CONTROL FAILED: this child''s INSERT into %s did NOT LAND in the family they DO manage (%s: %s) — every other column of %s defaults, so the grant, a guard trigger, the policy or a new constraint stopped it, and 1b''s refusal on %s (which accepts ANY error) is unattributed',
          t, st, msg, t, t));
      end if;
    else
      -- child_wallets / wallet_buckets: NOT NULL columns the statement does not
      -- supply, so the row cannot land. It must die in constraint evaluation
      -- (class 23), which ExecInsert reaches only AFTER the RLS WITH CHECK
      -- options — or land, should a default ever be added. Written as `st is
      -- null or …` because `null like …` is null, not false, and a reader
      -- should not have to know that to see which way this branch falls.
      if not (st is null or st like '23%') then
        failures := array_append(failures, format(
          'CONTROL FAILED: this child''s INSERT into %s raised %s (%s) in the family they DO manage, so it never reached the row''s own constraints — 1b accepts ANY error, so its refusal on %s is a grant, a guard trigger or a renamed object, not the manager gate',
          t, st, msg, t));
      end if;
      -- The one shape the rule above cannot see: a BEFORE INSERT trigger that
      -- raises class 23 itself (0306's shape guard does, on invest_orders).
      -- tgtype bits: 1 ROW, 2 BEFORE, 4 INSERT. Not a finding about the guard
      -- — a change of mechanism the leg has to be re-pointed for.
      select count(*) into n
      from pg_trigger tg
      where tg.tgrelid = to_regclass('public.' || t)
        and not tg.tgisinternal
        and (tg.tgtype & 2) = 2 and (tg.tgtype & 4) = 4;
      if n <> 0 then
        failures := array_append(failures, format(
          'MECHANISM CHANGED (not a control failure): %s now carries %s BEFORE INSERT trigger(s); leg B cannot tell a class-23 raise from that trigger apart from the row''s own NOT NULL, so 1b''s refusal on %s is unattributed until this leg is re-pointed at the trigger',
          t, n, t));
      end if;
    end if;
  end loop;

  -- ── Leg C: 2's predicate, as a read ─────────────────────────────────────
  -- Guarded like the writes: a bare failure here would abort the block with
  -- the very "permission denied" this block exists to name.
  begin
    select count(*) into n from public.wallet_audit_logs where family_id = fam;
  exception when others then
    n := null;  -- so the zero-row branch below does not report the same fault twice
    failures := array_append(failures, format(
      'CONTROL FAILED: this child could not even READ wallet_audit_logs for the anchor family (%s: %s) — a revoked SELECT grant or a missing table, so invariant 2''s zero-row UPDATE and DELETE are measuring nothing',
      sqlstate, sqlerrm));
  end;
  if n = 0 then
    failures := array_append(failures,
      'CONTROL FAILED: this child can see NO wallet_audit_logs row for the anchor family, so invariant 2''s zero-row UPDATE and DELETE prove nothing — a row a session cannot see reports zero rows just as readily as an absent write policy does');
  end if;

  perform set_config('role','postgres', true);

  -- The other half of leg C. If this grant goes, 2's unguarded UPDATE aborts
  -- the block with a bare "permission denied" and the diagnosis is lost, so say
  -- it here while the reason is still in hand. This is the one leg in the block
  -- that is NOT a control failure: the control held, and the trail would still
  -- be append-only — by the grant layer instead of 0224's absent policy, which
  -- is stricter, not looser. It is labelled as what it is, a change of
  -- mechanism: invariant 2 has to be re-pointed at the grant and re-worded
  -- rather than left claiming something it is no longer measuring, and the
  -- build is red until that is done.
  if not has_table_privilege('authenticated','public.wallet_audit_logs','UPDATE')
     or not has_table_privilege('authenticated','public.wallet_audit_logs','DELETE') then
    failures := array_append(failures,
      'MECHANISM CHANGED (not a control failure): authenticated no longer holds UPDATE/DELETE on wallet_audit_logs, so invariant 2''s zero rows would be a GRANT refusal, not 0224''s absent write policy — the append-only property very likely still holds, by a stricter mechanism than the one invariant 2 names; re-point invariant 2 at the grant layer');
  end if;

  -- Not reported as holding, not reported as broken: reported as UNPROVEN, and
  -- the build is red either way. Each item says which kind it is — a control
  -- that did not hold, a seed that was wrong, or a mechanism that moved.
  if array_length(failures, 1) is not null then
    raise exception 'A-08 UNPROVEN (the refusals below rest on a negative control that could not be read): %',
      array_to_string(failures, ' | ');
  end if;

  raise notice 'A-08 OK (negative control): the same child, as an ADULT (a can_manage_family manager, not an is_family_admin parent), CAN mint a complete valid $9,999.99 credit in the family they DO manage, LANDS the (family_id) insert on family_wallets and wallet_rules and reaches row constraints on child_wallets and wallet_buckets there, and CAN see the anchor family''s audit rows — so every refusal below is attributable to can_manage_family() specifically, not to a grant, a column revoke, a guard trigger, invisibility or the parent-only helper';
end $$;

rollback;

-- ── Invariant 1a: a child cannot MINT — a COMPLETE, valid $9,999.99 credit into
--     wallet_transactions must be RLS-rejected (only RLS can block a valid row,
--     so this is the rigorous money-mint proof, not a NOT-NULL artifact). ──────
do $$
declare blocked boolean := false; sqlst text;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005b01', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  begin
    insert into public.wallet_transactions
      (family_id, type, status, direction, amount_cents, currency, metadata)
    values ('00000000-0000-4000-8000-0000000000f1','parent_top_up','completed','credit',
            999999,'usd','{}'::jsonb);
  exception when others then
    blocked := true; sqlst := sqlstate;  -- expect 42501 insufficient_privilege (RLS)
  end;
  if not blocked then
    raise exception 'A-08 FAIL: child MINTED a completed $9,999.99 credit into wallet_transactions';
  end if;
  -- The comment above this block claims only RLS can block a COMPLETE, VALID
  -- row, which is what makes this the rigorous mint proof rather than a
  -- NOT-NULL artifact. That claim has to be enforced, not just asserted: the
  -- sqlstate was already captured and then never checked, so renaming
  -- amount_cents made the insert raise 42703, be caught, and print
  -- "child mint of a complete valid credit REJECTED (sqlstate 42703)" — the
  -- probe reporting a pass while announcing the evidence it had stopped
  -- testing anything. Verified against this file before the check was added.
  if sqlst is distinct from '42501' then
    raise exception 'A-08 FAIL: the child mint was refused with sqlstate % , not 42501 (RLS). The statement did not reach the policy, so this proves nothing about the mint lock', sqlst;
  end if;
  raise notice 'A-08 OK: child mint of a complete valid credit REJECTED (sqlstate %)', sqlst;
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 1b: the sibling money-ledger tables also reject a child INSERT ──
do $$
declare
  ledger text[] := array['child_wallets','wallet_buckets','wallet_rules','family_wallets'];
  t text; blocked boolean;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005b01', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  foreach t in array ledger loop
    -- A NOT NULL violation is accepted below as proof the write did not land,
    -- which is sound — but 42P01 (table renamed or dropped) would be accepted
    -- on the same terms, and then a money table nobody is checking any more
    -- reads as locked. Fail loudly instead.
    if to_regclass('public.' || t) is null then
      raise exception 'A-08 FAIL: money table public.% does not exist — this probe has been silently skipping it', t;
    end if;
    blocked := false;
    begin
      execute format(
        'insert into public.%I (family_id) values (%L)', t, '00000000-0000-4000-8000-0000000000f1');
    exception when others then blocked := true;  -- RLS WITH CHECK or NOT NULL both prove the write did not land
    end;
    if not blocked then
      raise exception 'A-08 FAIL: child INSERT into % was NOT blocked (money-mint open)', t;
    end if;
  end loop;
  raise notice 'A-08 OK: child INSERT rejected on all % sibling wallet tables', array_length(ledger,1);
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 2: a child cannot TAMPER (UPDATE/DELETE) the money audit trail ──
do $$
declare affected int;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005b01', true);
  perform set_config('request.jwt.claim.role','authenticated', true);

  update public.wallet_audit_logs set detail='TAMPERED'
    where family_id='00000000-0000-4000-8000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'A-08 FAIL: child UPDATEd % money-audit rows', affected; end if;

  delete from public.wallet_audit_logs
    where family_id='00000000-0000-4000-8000-0000000000f1';
  get diagnostics affected = row_count;
  if affected <> 0 then raise exception 'A-08 FAIL: child DELETEd % money-audit rows', affected; end if;

  raise notice 'A-08 OK: child UPDATE/DELETE of wallet_audit_logs affected 0 rows (append-only)';
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 3: a child CAN still append (INSERT) an audit row ──────────────
do $$
declare ok boolean := false;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005b01', true);
  perform set_config('request.jwt.claim.role','authenticated', true);
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
      values ('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-000000005b01',
              'ai_coach_call','ai_wallet_coach','child append');
    ok := true;
  exception when others then ok := false; end;
  if not ok then raise exception 'A-08 FAIL: child could not APPEND an audit row (append-only broke a legit write)'; end if;
  raise notice 'A-08 OK: child append (INSERT) into wallet_audit_logs allowed';
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 4 (positive control): a manager CAN write the ledger ───────────
-- The lockdown gates on can_manage_family(), so the anchor PARENT must succeed.
do $$
declare ok boolean := false;
begin
  perform set_config('role','authenticated', true);
  perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000000001', true);  -- anchor parent
  perform set_config('request.jwt.claim.role','authenticated', true);
  begin
    insert into public.wallet_audit_logs (family_id, actor_user_id, action, entity_type, detail)
      values ('00000000-0000-4000-8000-0000000000f1','00000000-0000-4000-8000-000000000001',
              'wallet_activated','family_wallets','manager control');
    ok := true;
  exception when others then ok := false; end;
  if not ok then raise exception 'A-08 FAIL: manager audit append was blocked (lockdown too strict)'; end if;
  raise notice 'A-08 OK: manager write allowed (positive control)';
  perform set_config('role','postgres', true);
end $$;

-- ── Invariant 5: the mint-lock survives a PERMISSIVE POLICY THAT DRIFTED IN ──
--
-- Everything above proves the migrations are right. This proves the lock holds
-- when the database is NOT what the migrations say — which is the situation a
-- production metadata audit reported: `wallet_transactions` carrying a
-- permissive INSERT policy alongside the manager-only one, of the shape that
-- lets any family member (a child included) submit a completed credit and
-- create spendable funds.
--
-- Permissive policies OR together, so on their own that finding is exactly as
-- bad as it sounds. What closes it is 0254's RESTRICTIVE guards: a restrictive
-- policy ANDs with the union of the permissive ones, so no permissive policy —
-- whatever it is called, whoever it is granted to — can grant past it.
--
-- That is a claim about Postgres semantics, and a claim about money deserves a
-- test rather than a reading. So this injects the drift and asserts the child
-- still cannot mint. Two shapes, the second deliberately the worst case that
-- could exist:
--   a) `to authenticated with check (is_family_member(family_id))` — the shape
--      the audit describes.
--   b) `to public with check (true)` — no role limit, no condition at all.
-- The guards in 0254 are `to authenticated`, so (b) also checks that a policy
-- reaching roles the guard does not name still cannot be used by a member.
do $$
declare blocked boolean; st text; landed int; shape text;
begin
  foreach shape in array array[
    'to authenticated with check (public.is_family_member(family_id))',
    'to public with check (true)'
  ] loop
    execute 'drop policy if exists wallet_transactions_drift_probe on public.wallet_transactions';
    execute format(
      'create policy wallet_transactions_drift_probe on public.wallet_transactions for insert %s', shape);

    blocked := false; st := null;
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claim.sub','00000000-0000-4000-8000-000000005b01', true);  -- the child
    perform set_config('request.jwt.claim.role','authenticated', true);
    begin
      insert into public.wallet_transactions
        (family_id, type, status, direction, amount_cents, currency, metadata)
      values ('00000000-0000-4000-8000-0000000000f1','parent_top_up','completed','credit',
              424242,'usd','{"probe":"drift"}'::jsonb);
    exception when others then blocked := true; st := SQLSTATE;
    end;
    perform set_config('role','postgres', true);

    select count(*) into landed from public.wallet_transactions where amount_cents = 424242;
    -- Clean up before asserting, so a failure does not leave the drift policy
    -- or a minted row behind for the next probe in the run.
    delete from public.wallet_transactions where amount_cents = 424242;
    execute 'drop policy if exists wallet_transactions_drift_probe on public.wallet_transactions';

    if not blocked or landed <> 0 then
      raise exception 'A-08 FAIL: a child MINTED money past the restrictive guard with a permissive policy % (blocked=%, rows=%)',
        shape, blocked, landed;
    end if;
    raise notice 'A-08 OK: child mint still blocked (%) with permissive policy %', st, shape;
  end loop;
end $$;

-- ── Invariant 6: `anon` cannot reach the money ledger at all ────────────────
-- The guards above are `to authenticated`, so a permissive policy `to public`
-- would not be ANDed with them for an anonymous request. The grant layer is
-- what closes that: anon holds no INSERT privilege, so the question never
-- reaches RLS. Asserted rather than assumed, because it is the one path the
-- restrictive guards do not cover.
do $$
declare has_priv boolean;
begin
  select has_table_privilege('anon','public.wallet_transactions','INSERT') into has_priv;
  if has_priv then
    raise exception 'A-08 FAIL: anon holds INSERT on wallet_transactions — the restrictive guards are `to authenticated` and would not apply';
  end if;
  raise notice 'A-08 OK: anon holds no INSERT privilege on wallet_transactions';
end $$;

-- ── Invariant 7: no stray permissive WRITE policy is left to report ─────────
--
-- Invariant 5 proves a stray policy cannot mint. This one proves there is no
-- stray policy, which is a different and — by this point — equally expensive
-- problem. The production metadata audit reads pg_policy and reports what it
-- finds; while a permissive INSERT policy sits on wallet_transactions it will
-- keep reporting one, every reviewer has to re-derive invariant 5 from
-- scratch, and the release stops. That happened three times before 0275.
--
-- 0217, 0254 and 0267 each dropped policies by hardcoded NAME, so a policy
-- nobody had named survived all three. 0275 sweeps by shape. This asserts the
-- result, so the sweep cannot quietly regress the next time someone adds a
-- policy to a money table.
do $$
declare
  offender record;
  n int := 0;
  -- Spelled out rather than pattern-matched on the name. The same two groups as
  -- 0275, in the same order: a `like 'wallet%'` shortcut would silently put a
  -- future table in the wrong group and check it against the wrong policy names.
  wallet_tables  text[] := array['family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules'];
  finance_tables text[] := array['financial_accounts','transactions','budgets','bills','savings_goals'];
begin
  for offender in
    select c.relname as tbl, p.polname as pol,
           case p.polcmd when 'a' then 'INSERT' when 'w' then 'UPDATE'
                         when 'd' then 'DELETE' when '*' then 'ALL' end as cmd
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public'
      and c.relname = any (wallet_tables || finance_tables)
      and p.polpermissive
      and p.polcmd in ('a','w','d','*')
      and p.polname not in (
        case when c.relname = any (wallet_tables) then c.relname || '_mng_insert' else c.relname || '_insert' end,
        case when c.relname = any (wallet_tables) then c.relname || '_mng_update' else c.relname || '_update' end,
        case when c.relname = any (wallet_tables) then c.relname || '_mng_delete' else c.relname || '_delete' end)
  loop
    n := n + 1;
    raise warning 'A-08 stray permissive % policy: %.%', offender.cmd, offender.tbl, offender.pol;
  end loop;

  if n <> 0 then
    raise exception 'A-08 FAIL: % stray permissive write policy(ies) on the money tables — 0275 has not been applied, or something re-added one', n;
  end if;
  raise notice 'A-08 OK: no stray permissive write policy on any money table';
end $$;

-- ── Invariant 8: the sweep actually sweeps ──────────────────────────────────
--
-- Invariant 7 asserts the end state, but in a freshly replayed database there
-- was never any drift to remove — so on its own it proves the migration set is
-- self-consistent, not that 0275 does its job. Production is the case that
-- matters, and CI cannot reproduce production's drift.
--
-- So: inject the drift, then re-run THE REAL MIGRATION FILE (via \ir, not a
-- copy pasted in here — a copy would drift from the original and start proving
-- the wrong thing) and assert the stray is gone and the intended policies
-- survived. 0275 is idempotent by construction, which is what makes this safe
-- to do against an already-migrated database.
--
-- Two shapes again, matching invariant 5: the one the production audit
-- describes, and the worst case that could exist.
do $$
begin
  drop policy if exists wallet_transactions_sweep_probe_a on public.wallet_transactions;
  drop policy if exists wallet_transactions_sweep_probe_b on public.wallet_transactions;
  create policy wallet_transactions_sweep_probe_a on public.wallet_transactions
    for insert to authenticated with check (public.is_family_member(family_id));
  create policy wallet_transactions_sweep_probe_b on public.wallet_transactions
    for all to public using (true) with check (true);

  if (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relname = 'wallet_transactions'
        and p.polname in ('wallet_transactions_sweep_probe_a','wallet_transactions_sweep_probe_b')) <> 2 then
    raise exception 'A-08 FAIL: could not inject the drift the sweep is meant to remove';
  end if;
  raise notice 'A-08: injected 2 stray permissive write policies on wallet_transactions';
end $$;

\ir ../../supabase/migrations/0275_money_permissive_write_sweep.sql

do $$
declare strays int; intended int;
begin
  select count(*) into strays
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'wallet_transactions'
    and p.polname in ('wallet_transactions_sweep_probe_a','wallet_transactions_sweep_probe_b');

  -- Belt and braces: if the sweep did not remove them, this probe must not
  -- leave a `to public using (true)` policy behind on a money table.
  drop policy if exists wallet_transactions_sweep_probe_a on public.wallet_transactions;
  drop policy if exists wallet_transactions_sweep_probe_b on public.wallet_transactions;

  if strays <> 0 then
    raise exception 'A-08 FAIL: 0275 left % injected stray policy(ies) on wallet_transactions', strays;
  end if;

  -- The sweep must not have taken the intended policies or the guards with it.
  select count(*) into intended
  from pg_policy p join pg_class c on c.oid = p.polrelid
  where c.relname = 'wallet_transactions'
    and p.polname in ('wallet_transactions_select',
                      'wallet_transactions_mng_insert','wallet_transactions_mng_update','wallet_transactions_mng_delete',
                      'wallet_transactions_manager_insert_guard','wallet_transactions_manager_update_guard',
                      'wallet_transactions_manager_delete_guard');
  if intended <> 7 then
    raise exception 'A-08 FAIL: after the sweep only %/7 intended wallet_transactions policies remain', intended;
  end if;

  raise notice 'A-08 OK: 0275 removed both injected strays and kept all 7 intended policies';
end $$;

-- ── Invariant 9: the guards are real, not merely counted ────────────────────
--
-- This asserts, in CI, the same three conditions docs/audit/money-policy-diagnostic.sql
-- reports to an operator. It exists because that diagnostic is named
-- *-diagnostic.sql rather than *-check.sql, so run-probes.sh does not glob it —
-- and its first version shipped with a bug that would have reported a FALSE
-- ALL-CLEAR, with nothing in CI able to catch it. Encoding the logic here means
-- the shape the operator query relies on is exercised against a real Postgres on
-- every PR.
--
-- Three conditions, because counting restrictive policies proves none of them:
--   * RLS ENABLED. Three immaculate restrictive policies on a table with row
--     security switched off are inert, and the table is wide open.
--   * The guard REQUIRES MANAGER ROLE. A restrictive policy with a permissive
--     rule takes nothing away.
--   * All THREE COMMANDS covered. Three insert guards and no delete guard is
--     not a backstop; distinct polcmd, not a count of policies.
--
-- Tables absent from this database are skipped rather than failed: 0275 itself
-- skips a finance table that does not exist or carries no family_id.
do $$
declare
  t         text;
  rls       boolean;
  commands  int;
  offenders text[] := '{}';
begin
  foreach t in array array[
    'family_wallets','child_wallets','wallet_buckets','wallet_transactions','wallet_rules',
    'financial_accounts','transactions','budgets','bills','savings_goals']
  loop
    if to_regclass('public.' || t) is null then continue; end if;

    select c.relrowsecurity into rls from pg_class c where c.oid = to_regclass('public.' || t);
    if not coalesce(rls, false) then
      offenders := offenders || (t || ' (RLS DISABLED - its policies are inert)');
      continue;
    end if;

    select count(distinct p.polcmd) into commands
    from pg_policy p
    where p.polrelid = to_regclass('public.' || t)
      and not p.polpermissive
      and p.polcmd in ('a','w','d')
      and coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
          coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%can_manage_family%';

    if commands <> 3 then
      offenders := offenders || (t || ' (' || commands || '/3 manager-gated restrictive write guards)');
    end if;
  end loop;

  if array_length(offenders, 1) is not null then
    raise exception 'A-08 FAIL: money tables without a real write backstop: %', array_to_string(offenders, ', ');
  end if;
  raise notice 'A-08 OK: every money table has RLS on and three manager-gated restrictive write guards';
end $$;

select 'A-08 wallet write-RLS probe (0217 mint-lock + 0224 audit append-only + 0254 drift resilience + 0275 stray sweep): ALL INVARIANTS PASSED' as result;

-- Behavioural proof for 0295, run as a real `authenticated` session under RLS.
--
-- reward_redemptions shipped (0028) with one `FOR ALL … is_family_member`
-- policy and one trigger, `trg_set_updated_at`, which stamps `updated_at` and
-- refuses nothing — so nothing on the table asked WHO was setting `status`.
-- (0295's own header says "no trigger"; it means no guard.) BOTH of its write
-- paths are direct browser writes that choose `status` and `decided_by`
-- client-side. So a child could insert a redemption already marked 'approved',
-- or approve one sitting in the queue — self-granting a reward no parent
-- agreed to.
--
-- This is the third of three decision surfaces in the chores/rewards economy.
-- 0222 closed the submission forge, 0223 the assignment-status forge, and this
-- one is their sibling. Like them it mints no money: the wallet is separately
-- manager-only under 0217. It is an accountability forgery.
--
-- What a member may still do is asserted alongside what they may not, because a
-- guard that also blocks asking for a reward would be a different bug.
-- Wrapped in a transaction that is always rolled back.
--
-- This probe COMMITTED everything it seeded, and its own assertions count rows
-- — a second run against the same database fails on
-- `family_members_family_id_user_id_key`, because run one's member rows are
-- still there under a different generated primary key.
-- It was masked for as long as it existed: this file and
-- ai-surface-role-privacy-check.sql shared the family id
-- `dddddddd-…`, so whichever ran second had its whole seed skipped by
-- `on conflict do nothing` and never reached its own defect. Giving each probe
-- its own ids (tests/boundary-probes-are-rerunnable.test.ts pins that) is what
-- surfaced it.
--
-- CI never saw any of this, because the Database job bootstraps a fresh
-- container every time and the suite had only ever been run ONCE per database.
--
-- WHAT GUARDS `public.reward_redemptions` — read from the catalog, not from
-- grep, and RE-ASSERTED at run time by check 7 at the foot of this file
-- ---------------------------------------------------------------------------
-- Grep is not the inventory. Dozens of migrations build DDL with
-- `execute format(... public.%I ...)` loops driven by catalog queries that
-- never spell a table's name — 0118_rls_drift_repair's first loop visits EVERY
-- base table, this one included — so a name-grep can miss a policy or trigger
-- that is really there. The list below was read from pg_trigger, pg_policy and
-- pg_constraint of a replayed database, and check 7 asserts it on whatever
-- database this file runs against rather than trusting this paragraph:
--
--   * ONE policy: 0028's `Members can manage reward_redemptions`, PERMISSIVE,
--     FOR ALL, TO authenticated, USING and WITH CHECK
--     `is_family_member(family_id)`. No RESTRICTIVE policy is ANDed onto it.
--   * THREE triggers, each BEFORE … FOR EACH ROW:
--       trg_reward_redemption_cost_guard      INSERT OR UPDATE   0308
--       trg_reward_redemption_decision_guard  INSERT OR UPDATE   0295
--       trg_set_updated_at                    UPDATE             0028
--   * no CHECK constraint (the primary key and four foreign keys only), and
--     every table privilege for `authenticated`, no column-level ACL.
--
-- So RLS answers YES to a child of the household for every statement below,
-- and THE MECHANISM THAT REFUSES CHECKS 1, 3 AND 4 IS A TRIGGER:
-- `trg_reward_redemption_decision_guard`, created by
-- 0295_reward_redemption_decision_guard.sql, which raises
-- `using errcode = '42501'` — `insufficient_privilege`, the very SQLSTATE a
-- missing GRANT gives — when `new.status` enters ('approved','rejected',
-- 'fulfilled') and the writer is not the service role, is not sessionless, and
-- does not `can_manage_family(new.family_id)`. 0308's cost guard is the only
-- other trigger that can refuse anything; it raises 23514, which no check here
-- catches, and it early-returns when `reward_id` is NULL — as it is on every
-- write in this file, the control's included.
--
-- 0295 is the ONLY migration that names the guard: `grep -rl
-- reward_redemption_decision_guard supabase/migrations` returns 0295 and
-- nothing else, so nothing later drops, replaces or re-points it. The table's
-- own name appears in five migrations: 0028 (the table and its policy), 0295,
-- 0308 (the cost guard above), and 0304 and 0326, which cite 0295 in comments
-- and touch nothing here — 0304's shared `decision_status_guard` is wired to
-- economy_redemptions and invest_orders only. `can_manage_family` is defined
-- once, in 0003, over `role in ('parent','adult') and is_active`.
--
-- NEGATIVE CONTROL, and it runs FIRST, before the refusals it gives meaning to
-- ---------------------------------------------------------------------------
-- The one thing the mechanism keys on is `can_manage_family(new.family_id)`,
-- so the control asks it the other way: the same child, in the same session,
-- running checks 1, 2, 3 and 4's OWN statements — the same column lists, the
-- same status values, each UPDATE starting from 'requested' as its check does
-- — in a SECOND family where that child IS a manager. Every leg MUST LAND.
--
-- What that adds, stated no wider than it is. Much of what could fake a
-- refusal in checks 1, 3 and 4 already turns this probe red WITHOUT the
-- control, because checks 2, 5 and 6 run with no exception handler: a revoked
-- table GRANT kills check 2; an UPDATE privilege that no longer covers
-- `status` or `decided_by` kills check 5 or 6; a dead `auth.uid()` lets 0028's
-- policy refuse check 2's plain ask; a blanket guard on decided statuses
-- refuses the parent in check 6. What NOTHING ELSE in this file can see:
--
--   * an INSERT-side refusal of a decided row that is not the manager gate —
--     INSERT granted only on a column list without `decided_by`, or an
--     INSERT-only restrictive policy or trigger on decided rows. Check 2
--     inserts without `decided_by` and with a plain status, and check 6
--     inserts nothing. With 0295's INSERT branch gone, such a refusal keeps
--     check 1 green on somebody else's 42501 — while a child could still mint
--     an 'approved' row simply by leaving `decided_by` out. Leg 0a writes
--     exactly check 1's row, and must succeed.
--   * a refusal keyed on who the CHILD is rather than on whether they manage
--     THIS family. Check 6 changes the user, so it cannot tell that apart from
--     the manager gate; the control holds the user constant and changes only
--     the family.
--   * placement: running first, a failure reads UNPROVEN with its reason in
--     hand, instead of a raw error — or a "parent could not approve" — after
--     three refusals were already read as a boundary that held.
--
-- The UPDATE legs also count rows, and not because checks 3 and 4 do: they
-- assert that an exception was RAISED, so an update silently filtered to zero
-- rows cannot fake them green — it makes them report a breach. The control's
-- count is what tells that story apart: a BEFORE trigger returning NULL, or a
-- USING clause hiding the row, would otherwise surface as "a child approved…"
-- about a write that never happened.
--
-- What the control CANNOT see, and what check 7 is for: a refusal from a
-- DIFFERENT mechanism keyed on the SAME predicate — say a later restrictive
-- policy `with check (status not in (…) or can_manage_family(family_id))`.
-- The control lands, checks 1, 3 and 4 are refused with 42501 and check 6
-- passes, even with 0295's predicate emptied out: green, with the credit to
-- 0295 wrong, though the boundary itself would hold. No behavioural control
-- splits two mechanisms that answer the same question the same way, so check
-- 7 pins the inventory above and 0295's predicate in the catalog. It runs
-- LAST, so a guard that has really been loosened is reported by the refusal it
-- lets through, not by a catalog mismatch.
--
-- Two details are load-bearing rather than decoration:
--   * the control runs BEFORE the three refusals, because a control that runs
--     after them cannot stop them being read as a boundary that held;
--   * it names the SAME COLUMNS as the writes under test — `status` AND
--     `decided_by`, on an INSERT and on an UPDATE. A column-level
--     `revoke update (decided_by)` sails straight past a control that only
--     sets `status`, and then kills check 3 with a 42501 this probe would read
--     as the guard holding.
-- It also leaves `reward_id` NULL, exactly as the writes under test do, so
-- 0308's cost guard early-returns for the control and for the checks alike and
-- cannot be the thing that makes either of them speak.
begin;
grant usage on schema public to authenticated;
-- No blanket `grant ... on all tables in schema public` here. The bootstrap's
-- `alter default privileges` already gives `authenticated` full DML on every
-- table a migration creates, so the restatement was redundant — and once
-- migrations began revoking DML deliberately (0300 takes the paywall columns
-- away from the client), it stopped being redundant and started undoing them
-- for every probe that runs after this one against the shared database.

do $$
declare
  fam        uuid := 'ddddbbbb-dddd-4ddd-8ddd-dddddddddddd';
  parent_uid uuid := 'd0000000-0000-4000-8000-0000000000b1';
  child_uid  uuid := 'd0000000-0000-4000-8000-0000000000b2';
  -- The negative control's household. Its own anchor, in this probe's style and
  -- used by no other probe and no migration (grepped across docs/audit and
  -- supabase/migrations). This file rolls back, so the id cannot outlive a run;
  -- it is unique anyway, because run-probes.sh globs every *-check.sql against
  -- one database and a shared id silently rewrites somebody else's assertion.
  ctl_fam    uuid := 'ddddcccc-dddd-4ddd-8ddd-dddddddddddd';
  parent_mid uuid;
  child_mid  uuid;
  ctl_mid    uuid;
  red        uuid;
  ctl_q3     uuid;
  ctl_q4     uuid;
  blocked    boolean;
  ctl_ok     boolean := true;
  ctl_why    text;
  n          int;
  src        text;
  stale      text[] := '{}';
begin
  insert into public.families (id, name) values (fam, 'Rewards') on conflict do nothing;
  insert into auth.users (id, email) values (parent_uid, 'rp@example.test'), (child_uid, 'rc@example.test')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, parent_uid, 'Parent', 'parent', true) returning id into parent_mid;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (fam, child_uid, 'Child', 'child', true) returning id into child_mid;

  -- ── The negative control's own household ─────────────────────────────────
  -- A SECOND family in which this SAME child is a manager, so
  -- can_manage_family answers YES for the very user it answers NO for in `fam`.
  -- `created_by` is left unset deliberately: handle_new_family (0257) only files
  -- a 'parent' membership when it is present, so the role this control depends
  -- on is the one written here and not one inherited from a trigger. The roles
  -- are then ASKED of can_manage_family below rather than trusted, because a
  -- seed whose roles are wrong would fail the control for a reason that is not
  -- the control's. 'parent' is a member_role that can_manage_family accepts
  -- (0003: role in ('parent','adult') and is_active).
  insert into public.families (id, name) values (ctl_fam, 'Rewards (the kid''s own house)')
    on conflict do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active)
  values (ctl_fam, child_uid, 'Child (a manager here)', 'parent', true) returning id into ctl_mid;

  -- ── As the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  -- ── NEGATIVE CONTROL: same child, same trigger, the other answer ─────────
  -- Runs FIRST, before the three refusals below. These are checks 1, 2, 3 and
  -- 4's own statements, on the same columns with the same values, in the
  -- family this child DOES manage, so `can_manage_family(new.family_id)` — the
  -- one thing 0295's trigger keys on — is the only thing that differs. Every
  -- leg must land. If one does not, this session never had the access the
  -- refusals are supposed to be measuring, and the probe says the boundary is
  -- UNPROVEN rather than reporting a guard it cannot see. See the header for
  -- what each leg would catch that nothing else here does.
  --
  -- The seed, asked rather than assumed: the child must be a plain member of
  -- `fam` and a manager of `ctl_fam`, or the two families do not differ in the
  -- one respect the control is about.
  if not public.is_family_member(fam) or public.can_manage_family(fam) then
    raise exception 'reward redemption decision boundary UNPROVEN: the child is not a plain (non-managing) member of the family under test, so nothing below is a child boundary';
  end if;
  if not public.can_manage_family(ctl_fam) then
    raise exception 'reward redemption decision boundary UNPROVEN: the child is not a manager of the control family, so the control cannot ask can_manage_family the other way';
  end if;

  -- 0a. Check 1's INSERT: mint an already-approved redemption, naming both
  --     `status` and `decided_by`.
  begin
    insert into public.reward_redemptions (family_id, member_id, reward_title, cost_points, status, decided_by)
    values (ctl_fam, ctl_mid, 'Extra screen time', 100, 'approved', ctl_mid);
    get diagnostics n = row_count;
    if n <> 1 then
      ctl_ok := false;
      ctl_why := format('leg 0a, check 1''s INSERT of an already-approved redemption, stored %s rows in the family this child DOES manage, so check 1''s refusal would prove nothing about the manager gate', n);
    end if;
  exception when others then
    ctl_ok := false;
    ctl_why := format('leg 0a: this child was REFUSED check 1''s already-approved redemption in the family they DO manage (%s: %s) — so check 1''s refusal would prove only that something said no, not that 0295''s manager gate said it', sqlstate, sqlerrm);
  end;

  -- 0b. Check 2's INSERT, twice: the two 'requested' rows that legs 0c and 0d
  --     decide, one each, so each UPDATE leg starts from the very state its
  --     check starts from.
  if ctl_ok then
    begin
      insert into public.reward_redemptions (family_id, member_id, reward_title, cost_points, status)
      values (ctl_fam, ctl_mid, 'Extra screen time', 100, 'requested') returning id into ctl_q3;
      insert into public.reward_redemptions (family_id, member_id, reward_title, cost_points, status)
      values (ctl_fam, ctl_mid, 'Extra screen time', 100, 'requested') returning id into ctl_q4;
      if ctl_q3 is null or ctl_q4 is null then
        ctl_ok := false;
        ctl_why := 'leg 0b: this child could not queue a request in the family they DO manage, so checks 3 and 4 have no control';
      end if;
    exception when others then
      ctl_ok := false;
      ctl_why := format('leg 0b: this child could not queue a request in the family they DO manage (%s: %s), so checks 3 and 4 have no control', sqlstate, sqlerrm);
    end;
  end if;

  -- 0c. Check 3's UPDATE: requested -> approved, naming `status` AND
  --     `decided_by`. `decided_by` is there because a column-level revoke on
  --     it is invisible to a status-only control.
  if ctl_ok then
    begin
      update public.reward_redemptions set status = 'approved', decided_by = ctl_mid where id = ctl_q3;
      get diagnostics n = row_count;
      if n <> 1 then
        ctl_ok := false;
        ctl_why := format('leg 0c, check 3''s UPDATE (requested -> approved, status AND decided_by), changed %s rows in the family this child DOES manage — a BEFORE trigger returned NULL or the row is hidden from this session — so check 3 would report a breach, or a refusal, about a write that never happened', n);
      end if;
    exception when others then
      ctl_ok := false;
      ctl_why := format('leg 0c: check 3''s UPDATE (requested -> approved, status AND decided_by) in the family this child DOES manage raised %s: %s', sqlstate, sqlerrm);
    end;
  end if;

  -- 0d. Check 4's UPDATE: requested -> fulfilled, `status` alone.
  if ctl_ok then
    begin
      update public.reward_redemptions set status = 'fulfilled' where id = ctl_q4;
      get diagnostics n = row_count;
      if n <> 1 then
        ctl_ok := false;
        ctl_why := format('leg 0d, check 4''s UPDATE (requested -> fulfilled, status alone), changed %s rows in the family this child DOES manage — a BEFORE trigger returned NULL or the row is hidden from this session — so check 4 would report a breach, or a refusal, about a write that never happened', n);
      end if;
    exception when others then
      ctl_ok := false;
      ctl_why := format('leg 0d: check 4''s UPDATE (requested -> fulfilled, status alone) in the family this child DOES manage raised %s: %s', sqlstate, sqlerrm);
    end;
  end if;

  if not ctl_ok then
    raise exception 'reward redemption decision boundary UNPROVEN (the negative control this probe rests on did not hold): %', ctl_why;
  end if;

  -- The control's rows do not outlive the control. This is hygiene, not
  -- correctness: nothing below counts them (every assertion filters on `red`)
  -- and the whole file rolls back. So it is done as the session user and it
  -- may NOT fail the probe — the control has already passed by this line, and
  -- a refused DELETE here is reported as a WARNING and the checks still run.
  reset role;
  begin
    delete from public.reward_redemptions where family_id = ctl_fam;
  exception when others then
    raise warning 'reward-redemption-decision: could not clear the control''s rows (%: %); harmless, the file rolls back', sqlstate, sqlerrm;
  end;
  set local role authenticated;

  -- 1. Cannot mint an already-approved redemption.
  blocked := false;
  begin
    insert into public.reward_redemptions (family_id, member_id, reward_title, cost_points, status, decided_by)
    values (fam, child_mid, 'Extra screen time', 100, 'approved', child_mid);
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child inserted an APPROVED reward redemption';
  end if;

  -- 2. May still ASK. A guard that blocked this would break the product.
  insert into public.reward_redemptions (family_id, member_id, reward_title, cost_points, status)
  values (fam, child_mid, 'Extra screen time', 100, 'requested') returning id into red;

  -- 3. Cannot approve the request they just made.
  blocked := false;
  begin
    update public.reward_redemptions set status = 'approved', decided_by = child_mid where id = red;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child approved their own queued reward redemption';
  end if;

  -- 4. Cannot jump straight to fulfilled either.
  blocked := false;
  begin
    update public.reward_redemptions set status = 'fulfilled' where id = red;
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then
    raise exception 'a child marked their own reward redemption fulfilled';
  end if;

  -- 5. May withdraw their own ask. Cancelling needs no parent.
  update public.reward_redemptions set status = 'cancelled' where id = red;
  select count(*) into n from public.reward_redemptions where id = red and status = 'cancelled';
  if n <> 1 then
    raise exception 'a child could not cancel their own reward request';
  end if;

  -- ── As the parent ────────────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;

  -- 6. A manager decides, which is the whole point of the queue.
  update public.reward_redemptions set status = 'approved', decided_by = parent_mid where id = red;
  update public.reward_redemptions set status = 'fulfilled' where id = red;
  select count(*) into n from public.reward_redemptions where id = red and status = 'fulfilled';
  if n <> 1 then
    raise exception 'a parent could not approve and fulfil a reward redemption';
  end if;

  reset role;

  -- 7. The ATTRIBUTION, asserted rather than stated. Checks 1, 3 and 4 held and
  --    the control landed; this is what entitles the header to say it was
  --    0295's trigger that refused them. It is the header's inventory, read
  --    back from the catalog of the database under test: any policy or trigger
  --    on this table that is not in it — the restrictive `can_manage_family`
  --    policy the control cannot tell apart from 0295 is the case in point — or
  --    a 0295 whose predicate no longer asks `can_manage_family(new.family_id)`,
  --    turns this probe red and asks for the header to be re-derived before
  --    anyone credits 0295 again.
  --
  -- 7a. 0295's trigger, in its shape: enabled, BEFORE, ROW, INSERT and UPDATE
  --     of any column, no WHEN clause, calling 0295's function.
  select count(*) into n
    from pg_trigger t
   where t.tgrelid = 'public.reward_redemptions'::regclass
     and t.tgname = 'trg_reward_redemption_decision_guard'
     and not t.tgisinternal
     and t.tgenabled in ('O', 'A')
     and t.tgfoid = 'public.reward_redemption_decision_guard()'::regprocedure
     and t.tgtype & 1 = 1    -- FOR EACH ROW
     and t.tgtype & 2 = 2    -- BEFORE
     and t.tgtype & 4 = 4    -- INSERT
     and t.tgtype & 16 = 16  -- UPDATE
     and t.tgattr::text = '' -- not `update of <columns>`
     and t.tgqual is null;   -- no WHEN clause
  if n <> 1 then
    stale := stale || 'trg_reward_redemption_decision_guard is missing, disabled, or no longer a BEFORE INSERT OR UPDATE row trigger on every column calling public.reward_redemption_decision_guard()'::text;
  end if;

  -- 7b. 0295's predicate. Read from the function body with its `--` comments
  --     stripped, so a comment that mentions can_manage_family cannot stand in
  --     for a call to it.
  select regexp_replace(p.prosrc, '--[^\n]*', '', 'g') into src
    from pg_proc p
   where p.oid = 'public.reward_redemption_decision_guard()'::regprocedure;
  if src is null
     or src !~ 'public\.can_manage_family\(\s*new\.family_id\s*\)'
     or src !~ $re$new\.status\s+in\s*\(\s*'approved'\s*,\s*'rejected'\s*,\s*'fulfilled'\s*\)$re$
     or src !~ $re$errcode\s*=\s*'42501'$re$ then
    stale := stale || 'public.reward_redemption_decision_guard() no longer raises 42501 on (''approved'',''rejected'',''fulfilled'') unless public.can_manage_family(new.family_id)'::text;
  end if;

  -- 7c. Every trigger on the table, and what it calls. Exactly the three in
  --     the header.
  select count(*) into n
    from pg_trigger t
   where t.tgrelid = 'public.reward_redemptions'::regclass
     and not t.tgisinternal
     and (t.tgname, t.tgfoid) not in (
       ('trg_reward_redemption_cost_guard',     'public.reward_redemption_cost_guard()'::regprocedure),
       ('trg_reward_redemption_decision_guard', 'public.reward_redemption_decision_guard()'::regprocedure),
       ('trg_set_updated_at',                   'public.set_updated_at()'::regprocedure));
  if n <> 0 or (select count(*) from pg_trigger t
                 where t.tgrelid = 'public.reward_redemptions'::regclass and not t.tgisinternal) <> 3 then
    stale := stale || format('public.reward_redemptions carries a trigger the header does not name (%s)',
      (select string_agg(t.tgname || ' -> ' || t.tgfoid::regprocedure::text, ', ' order by t.tgname)
         from pg_trigger t
        where t.tgrelid = 'public.reward_redemptions'::regclass and not t.tgisinternal));
  end if;

  -- 7d. Every policy on the table. Exactly 0028's one, permissive, FOR ALL,
  --     both clauses `is_family_member(family_id)` — so RLS answers YES to a
  --     member, and nothing restrictive can be what refused checks 1, 3 and 4.
  if (select count(*) from pg_policy p where p.polrelid = 'public.reward_redemptions'::regclass) <> 1
     or not exists (
       select 1 from pg_policy p
        where p.polrelid = 'public.reward_redemptions'::regclass
          and p.polname = 'Members can manage reward_redemptions'
          and p.polpermissive
          and p.polcmd = '*'
          and pg_get_expr(p.polqual, p.polrelid) = 'is_family_member(family_id)'
          and pg_get_expr(p.polwithcheck, p.polrelid) = 'is_family_member(family_id)') then
    stale := stale || format('public.reward_redemptions'' policies are not 0028''s one permissive FOR ALL is_family_member policy (%s)',
      (select string_agg(format('%s %s %s using %s check %s', p.polname,
                                case when p.polpermissive then 'permissive' else 'RESTRICTIVE' end, p.polcmd,
                                pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)),
                         '; ' order by p.polname)
         from pg_policy p where p.polrelid = 'public.reward_redemptions'::regclass));
  end if;

  if cardinality(stale) > 0 then
    raise exception 'reward redemption decision boundary held, but its ATTRIBUTION to 0295 is stale — re-derive the header before crediting 0295: %',
      array_to_string(stale, ' | ');
  end if;

  raise notice 'OK  the same child CAN mint, approve and fulfil decided redemptions in the family they manage (control), and in the family they do not, reward redemption decisions are a manager''s alone — refused by 0295''s trigger, the only guard the catalog shows; asking and cancelling are not';
end $$;

rollback;

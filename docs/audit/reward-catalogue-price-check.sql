-- The price on the shelf, and the price on the ticket.
--
-- `rewards` is written STRAIGHT FROM THE BROWSER — components/modules/
-- rewards-module.tsx calls `createClient().from('rewards').insert/update/
-- delete` from `save` and `remove` with the viewer's own JWT. What stops a
-- child in the app is `canManage = isManager(role)` early-returning from
-- `openNew`, `openEdit`, `save` and `remove`. A hidden button is not a
-- boundary, and when this probe was first written the table's four policies
-- were `is_family_member(family_id)` and nothing else. 0308 is the answer to
-- that finding, and the refusals below are 0308's.
--
-- Two numbers followed from it:
--
--   rewards.cost_points      — `requestRedemptionAction` copies it into the
--                              redemption server-side, so re-pricing the shelf
--                              re-prices the ticket the parent approves. A
--                              child lowered "New bike, 5000" to 5, requested
--                              it, and the approval queue showed a 5-point ask.
--   reward_redemptions.cost_points
--                            — one policy, `Members can manage … FOR ALL …
--                              is_family_member` (still the only one), and
--                              0295's trigger guards the DECISION, not the
--                              amount. A direct insert could name its own price
--                              without touching the shelf at all, until 0308's
--                              `reward_redemption_cost_guard` trigger (23514).
--
-- lib/rewards/points.ts deducts cost_points at 'approved' and 'fulfilled', so
-- both are the spendable balance — the same ledger 0222, 0223, 0295 and 0305
-- exist to keep honest.
--
-- Judged on ROW COUNTS: an UPDATE refused by nothing simply lands, and an
-- exception-only assertion would report a boundary that is not there.
--
-- WHAT GUARDS `public.rewards` TODAY — read from the catalog, not from grep
-- ---------------------------------------------------------------------------
-- `grep -l 'on public.rewards'` across supabase/migrations finds 0002 and 0308
-- and nothing else, and that is NOT the inventory: every other piece of DDL on
-- this table was written by an `execute format(... public.%I ...)` loop that
-- never spells the name. On a database with every migration replayed,
-- pg_policy, pg_trigger and pg_constraint for public.rewards hold exactly:
--
--   * SEVEN policies. Four PERMISSIVE, to PUBLIC — rewards_select, _insert,
--     _update, _delete, each `is_family_member(family_id)` — made by
--     0004_rls.sql's loop over its family-table array. Three RESTRICTIVE, to
--     authenticated — rewards_manager_insert_guard (WITH CHECK),
--     _update_guard (USING + WITH CHECK), _delete_guard (USING), each
--     `can_manage_family(family_id)` — made by 0308, the only migration that
--     names them.
--   * ONE trigger, `trg_set_updated_at`, BEFORE UPDATE, attached by
--     0003_functions_triggers.sql's loop over every table with an `updated_at`
--     column and re-attached by 0034's identical loop. It sets `updated_at =
--     now()` and returns NEW; it never refuses anything.
--   * no CHECK constraint — the primary key and the foreign keys on
--     family_id, created_by and redeemed_by, nothing else — and every table
--     privilege for `authenticated`, from the Supabase default privileges
--     pg-bootstrap.sh reproduces. No migration revokes any of them here.
--
-- Of the migrations after 0308 that build DDL with `execute format`, none
-- loops over the catalog generically and none lists `rewards` (0310, which
-- enforces the other UI-only manager gates, included). Re-check with
--   select polname, polpermissive, pg_get_expr(polqual, polrelid),
--          pg_get_expr(polwithcheck, polrelid)
--     from pg_policy where polrelid = 'public.rewards'::regclass;
--   select tgname from pg_trigger
--    where tgrelid = 'public.rewards'::regclass and not tgisinternal;
-- before trusting this list over the database.
--
-- So the MECHANISM IS RLS — restrictive policies, 0254's device, ANDed over the
-- permissive four — and the predicate is one question: does this session hold
-- role 'parent' or 'adult', active, in THIS family (public.can_manage_family,
-- 0003, never redefined since).
--
-- NEGATIVE CONTROL, and it runs FIRST, before assertions 2, 3 and 4
-- ---------------------------------------------------------------------------
-- One question is all the boundary is, so the control asks it with the answer
-- flipped and nothing else changed: the same child, the same three verbs, in a
-- SECOND household, `ctl_fam`, built to match `fam` in everything but that
-- child's role —
--
--   * created by the same parent (families.created_by = parent_uid), who is an
--     active 'parent' there as well. An owner-shaped rule ("only the family's
--     creator may …") therefore refuses the control exactly as it would refuse
--     2, 3 and 4, instead of passing a control household the child created;
--   * the child an active 'parent' there rather than a 'child' — the one
--     difference, and the one thing `can_manage_family` reads;
--   * a shelf seeded privileged the way `fam`'s is — "New bike" at 5000 and
--     "Ice cream" at 100, both `created_by = parent_uid` — so the control's
--     UPDATE and DELETE act on rows the PARENT wrote, as 2 (on `bike`) and 4
--     (on `spare`) do. A rule keyed on `created_by = auth.uid()` — the device
--     0328, 0333, 0335, 0338 and 0339 install on sibling tables, every one after
--     0308 — would refuse 2 and 4 for authorship; against a child-written
--     control row it would have let the control land and handed the manager
--     gate the credit. Against the parent's row it refuses the control too.
--
-- The three legs are 2, 3 and 4's statements with `fam` changed to `ctl_fam`
-- and nothing else: INSERT the same four columns 3 names, with 3's own
-- `created_by = child_uid` and no RETURNING, since 3 has none; UPDATE
-- `cost_points` to 5 on the parent's "New bike" — `cost_points`, the column 2
-- writes, because a column-level `revoke update (cost_points) on
-- public.rewards from authenticated` sails past a control that only renames a
-- title; DELETE the parent's "Ice cream". All three must land.
--
-- Then, back in `fam`, the child must SEE `bike` and `spare`. 2 and 4 assert
-- ZERO ROWS, and a row this session cannot see reports zero just as readily as
-- a restrictive USING does. `rewards_select` is `is_family_member`, so the
-- child sees both today — but a control household cannot speak for what is
-- visible in `fam`, so this reads it where 2 and 4 will act.
--
-- What that leaves 2, 3 and 4 able to mean. A missing or revoked table GRANT
-- (42501), a column-level denial (42501), a dead `auth.uid()`, a guard TRIGGER
-- for some unrelated rule — how this repository refuses writes in 0223, 0305,
-- 0326 and 0331, and how 0308 itself refuses one table over on
-- `reward_redemptions` — an authorship rule, an owner rule, a narrowed SELECT:
-- every one of them refuses a control leg or the visibility read as well, and
-- the probe says UNPROVEN instead of crediting the manager gate. Only a refusal
-- that turns on the child's ROLE IN `fam` — can_manage_family's question — can
-- pass the control and still refuse 2, 3 and 4.
--
-- Assertion 7 does not cover any of this. It proves the guard lets SOMEBODY
-- through — a PARENT — not that the CHILD's session could have written a reward
-- anywhere at all, which is the only thing that makes 2, 3 and 4 read as a
-- boundary. Every row the child is tested against here is inserted before the
-- session switches, which is precisely how the document-vault probe passed for
-- a release while the teen could not INSERT a document at all.
--
-- The ticket half already has its control, in the right place: assertion 1 is
-- this same child running assertion 5's exact INSERT with the one thing 0308's
-- `reward_redemption_cost_guard` trigger keys on changed — `cost_points` equal
-- to the shelf price rather than 1 — and it runs before 5.
--
-- A failed control makes 2, 3 and 4 unreadable, so the probe reports the
-- boundary as UNPROVEN rather than as holding or as broken. The build is red
-- either way.
--
-- What persists. run-probes.sh runs this file with `psql -v ON_ERROR_STOP=1 -f`
-- and no explicit transaction, so the DO block below is ONE autocommitted
-- statement: a red run — a BREACH, a failed control, UNPROVEN — raises out of
-- it and rolls back every row it wrote, seed included. A green run commits,
-- and what it leaves is both households (families rows, memberships, and the
-- subscription and AI-settings rows handle_new_family seeds) and `fam`'s shelf.
-- Every probe runs against the ONE database, so the anchors here were checked
-- absent from docs/audit and supabase/migrations before use.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  fam uuid := '00000000-0000-4000-8000-00000000fd01';
  parent_uid uuid := '00000000-0000-4000-8000-00000000fda1';
  child_uid  uuid := '00000000-0000-4000-8000-00000000fda2';
  child_mid uuid;
  bike uuid;
  spare uuid;
  n int;
  failures int := 0;
  -- The control household: a second family, the same parent, the same child —
  -- a manager here. See the header for why each of those is what it is.
  ctl_fam uuid := '00000000-0000-4000-8000-00000000fd03';
  -- Its shelf, seeded like `fam`'s. Both take the id Postgres gives them,
  -- exactly as `bike` and `spare` do.
  ctl_bike uuid;
  ctl_spare uuid;
  ctl_failures text[] := '{}';
  control_ok boolean := true;
begin
  delete from public.reward_redemptions where family_id = fam;
  delete from public.rewards where family_id = fam;
  -- The control shelf too, so it holds exactly the two rows seeded below. Not
  -- because anything is stranded — a red run rolls back whole and a green run's
  -- sweep empties this shelf — but so the control never depends on history.
  delete from public.reward_redemptions where family_id = ctl_fam;
  delete from public.rewards where family_id = ctl_fam;

  insert into auth.users (id, email) values
    (parent_uid, 'shelf-parent@example.com'), (child_uid, 'shelf-child@example.com')
  on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values (fam, 'Reward Shelf', parent_uid)
  on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (fam, parent_uid, 'Parent', 'parent', true),
    (fam, child_uid,  'Child',  'child',  true)
  on conflict do nothing;
  select id into child_mid from public.family_members where family_id = fam and user_id = child_uid;

  -- ── the control household ────────────────────────────────────────────────
  -- Created by the PARENT, like `fam`. `do update` rather than `do nothing`: an
  -- earlier version of this probe committed this household with the child as
  -- its creator, and a database that ran it must not keep that difference.
  -- No second child and no new auth user: `rewards` is family-scoped and its
  -- only member-shaped column, `redeemed_by`, is nullable and unused here.
  insert into public.families (id, name, created_by) values (ctl_fam, 'Reward Shelf (control)', parent_uid)
  on conflict (id) do update set name = excluded.name, created_by = excluded.created_by;
  -- handle_new_family files the creator as a 'parent' on a first insert only;
  -- on a re-run `on conflict` means it never fires, so both roles are upserted
  -- rather than assumed, and a seed whose roles are wrong cannot fail the
  -- control for a reason that is not the control's.
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (ctl_fam, parent_uid, 'Parent', 'parent', true),
    (ctl_fam, child_uid,  'Child (a manager here)', 'parent', true)
  on conflict (family_id, user_id) do update set role = excluded.role, is_active = true;

  -- The seed is asserted, not assumed: the two households must match in who
  -- created them and in the parent being an active parent of each, so the
  -- child's role is the only thing that differs.
  if (select created_by from public.families where id = fam) is distinct from parent_uid
     or (select created_by from public.families where id = ctl_fam) is distinct from parent_uid then
    raise exception 'CONTROL FAILED: % and % were not both created by the parent, so the control household differs from the family under test in more than the child''s role', fam, ctl_fam;
  end if;
  if not exists (select 1 from public.family_members
                  where family_id = fam and user_id = parent_uid and role = 'parent' and is_active)
     or not exists (select 1 from public.family_members
                  where family_id = ctl_fam and user_id = parent_uid and role = 'parent' and is_active) then
    raise exception 'CONTROL FAILED: the parent is not an active parent of both % and %, so the shelf rows would not have the same provenance in each', fam, ctl_fam;
  end if;

  insert into public.rewards (family_id, title, cost_points, created_by)
    values (fam, 'New bike', 5000, parent_uid) returning id into bike;
  -- A second shelf item, so the delete assertion cannot destroy the row the
  -- consistency assertion below needs.
  insert into public.rewards (family_id, title, cost_points, created_by)
    values (fam, 'Ice cream', 100, parent_uid) returning id into spare;
  -- The control shelf: the same two rows, by the same hand, in `ctl_fam`.
  insert into public.rewards (family_id, title, cost_points, created_by)
    values (ctl_fam, 'New bike', 5000, parent_uid) returning id into ctl_bike;
  insert into public.rewards (family_id, title, cost_points, created_by)
    values (ctl_fam, 'Ice cream', 100, parent_uid) returning id into ctl_spare;

  -- ── as the child ─────────────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', child_uid::text, true);
  set local role authenticated;

  if not public.is_family_member(fam) then
    raise exception 'CONTROL FAILED: not acting as a member of the family under test';
  end if;
  if public.can_manage_family(fam) then
    raise exception 'CONTROL FAILED: acting as a manager, so nothing below is a child boundary';
  end if;

  -- ── 0. NEGATIVE CONTROL: the same child, the same policies, the other answer
  --
  -- 2, 3 and 4 run in `ctl_fam`, where this child IS a manager, against a shelf
  -- the parent stocked. All three must land, and the child must see the two
  -- rows 2 and 4 aim at in `fam`. It must run BEFORE the refusals it gives
  -- meaning to, which is why it is 0.
  if not public.is_family_member(ctl_fam) then
    raise exception 'CONTROL FAILED: the seed did not make this child a member of the control household %, so the control could not speak for the policy', ctl_fam;
  end if;
  if not public.can_manage_family(ctl_fam) then
    raise exception 'CONTROL FAILED: the seed did not make this child a MANAGER of the control household %, so a refused control below would be the seed''s fault and not the policy''s', ctl_fam;
  end if;

  -- 0a. Assertion 3's INSERT: the same four columns, the same `created_by`.
  begin
    insert into public.rewards (family_id, title, cost_points, created_by)
      values (ctl_fam, 'A day off', 0, child_uid);
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      ctl_failures := array_append(ctl_failures, format('this child''s INSERT into rewards in the family they DO manage stored %s rows, so assertion 3''s insufficient_privilege would prove nothing about the manager gate', n));
    end if;
  exception when others then
    control_ok := false;
    ctl_failures := array_append(ctl_failures, format('this child was refused an INSERT into rewards in the family they DO manage (%s: %s) — so assertion 3 below proves only that something said no, not that the manager gate said it', sqlstate, sqlerrm));
  end;

  -- 0b. Assertion 2's UPDATE: `cost_points`, 5000 to 5, on a row the PARENT
  --     wrote. Independent of 0a, so a red control names every leg that failed.
  begin
    update public.rewards set cost_points = 5 where id = ctl_bike;
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      ctl_failures := array_append(ctl_failures, format('this child''s UPDATE of cost_points on a parent''s reward in the family they DO manage changed %s rows, so assertion 2''s zero rows would prove nothing: a row this session cannot write reports zero either way', n));
    end if;
  exception when others then
    control_ok := false;
    ctl_failures := array_append(ctl_failures, format('this child''s UPDATE of cost_points on a parent''s reward in the family they DO manage raised %s: %s', sqlstate, sqlerrm));
  end;

  -- 0c. Assertion 4's DELETE, of a row the PARENT wrote.
  begin
    delete from public.rewards where id = ctl_spare;
    get diagnostics n = row_count;
    if n <> 1 then
      control_ok := false;
      ctl_failures := array_append(ctl_failures, format('this child''s DELETE of a parent''s reward in the family they DO manage removed %s rows, so assertion 4''s zero rows would prove nothing', n));
    end if;
  exception when others then
    control_ok := false;
    ctl_failures := array_append(ctl_failures, format('this child''s DELETE of a parent''s reward in the family they DO manage raised %s: %s', sqlstate, sqlerrm));
  end;

  -- 0d. The rows 2 and 4 act on are rows this session can SEE, in `fam`.
  begin
    select count(*) into n from public.rewards where id in (bike, spare);
    if n <> 2 then
      control_ok := false;
      ctl_failures := array_append(ctl_failures, format('this child can see %s of the 2 rewards assertions 2 and 4 act on, so their zero rows would be invisibility, not the manager gate', n));
    end if;
  exception when others then
    control_ok := false;
    ctl_failures := array_append(ctl_failures, format('this child could not read the rewards assertions 2 and 4 act on (%s: %s)', sqlstate, sqlerrm));
  end;

  -- What the control wrote does not outlive it. On a green run that is the
  -- child's "A day off" and the parent's re-priced "New bike" — 0c already took
  -- "Ice cream" — so this sweep has real work to do. A red run needs none: the
  -- raise below rolls the whole DO statement back (see "What persists").
  reset role;
  delete from public.rewards where family_id = ctl_fam;
  set local role authenticated;

  -- A failed control makes 2, 3 and 4 unreadable. Say WHY here, while the reason
  -- is still in hand: the boundary is not reported as holding and not reported
  -- as broken, but as unproven, and the build is red either way.
  if not control_ok then
    raise exception 'reward catalogue boundary UNPROVEN (the control these assertions rest on did not hold): %', array_to_string(ctl_failures, ' | ');
  end if;

  -- 1. A child may still ASK for a reward at the shelf price — the positive
  --    control. requestRedemptionAction inserts exactly this row as the child,
  --    so a guard that blocked it would have closed the feature, not the hole.
  begin
    insert into public.reward_redemptions
      (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, bike, child_mid, 'New bike', 5000, 'requested');
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a child could not request a reward (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a child could not request a reward (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. But may not re-price the shelf under it.
  begin
    update public.rewards set cost_points = 5 where id = bike;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child re-priced a family reward from 5000 to 5 (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. Nor stock the shelf with one of their own, free.
  begin
    insert into public.rewards (family_id, title, cost_points, created_by)
      values (fam, 'A day off', 0, child_uid);
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child added a reward costing nothing (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 4. Nor clear the shelf.
  begin
    delete from public.rewards where id = spare;
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child deleted a family reward (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 5. Nor write a ticket at a price the shelf never carried. The consistency
  --    half, and 0308's: `reward_redemption_cost_guard`, BEFORE INSERT OR
  --    UPDATE on reward_redemptions, raises 23514 — the `check_violation`
  --    caught below — when a ticket's cost_points is not its reward's. 0295's
  --    trigger guards only the DECISION on this table, which is why 0308 had to
  --    add one for the amount, as 0306 did for invest_orders after 0304.
  begin
    insert into public.reward_redemptions
      (family_id, reward_id, member_id, reward_title, cost_points, status)
    values (fam, bike, child_mid, 'New bike', 1, 'requested');
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a child requested a 5000-point reward for % point (rows: %)', 1, n;
      failures := failures + 1;
    end if;
  exception when check_violation then null; when insufficient_privilege then null;
  end;

  -- 6. And the shelf price a parent would be shown is still the one they set.
  select cost_points into n from public.rewards where id = bike;
  if n is distinct from 5000 then
    raise warning 'BREACH: the reward the approval queue prices is now % points', n;
    failures := failures + 1;
  end if;

  reset role;

  -- 7. A manager still runs the catalogue, or the guard has closed the product.
  perform set_config('request.jwt.claim.sub', parent_uid::text, true);
  set local role authenticated;
  begin
    insert into public.rewards (family_id, title, cost_points, created_by)
      values (fam, 'Movie night', 250, parent_uid);
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not add a reward (rows: %)', n;
      failures := failures + 1;
    end if;
    update public.rewards set cost_points = 4500 where id = bike;
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: a manager could not re-price a reward (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: a manager could not run the catalogue (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;
  reset role;

  if failures > 0 then
    raise exception 'reward-catalogue-price: % assertion(s) failed', failures;
  end if;
  raise notice 'reward-catalogue-price: OK — a child may ask at the shelf price, and may not set it';
end
$probe$;

-- A SECURITY DEFINER routine must not trust the ids it is handed.
--
-- `public.grocery_from_meal_plan` (0005) is SECURITY DEFINER and granted to
-- `authenticated`. It checked `is_family_member(p_family_id)` and then trusted
-- the rest:
--
--   * it joined `meals` with no family scope, so a `meal_plans` row planted
--     under your family pointing at another family's meal copied THAT meal's
--     ingredient names onto your own list — where you can read them;
--   * it used `p_list_id` as given, so rows could be written onto another
--     family's list.
--
-- 0311 established that the planted reference is possible and said of the
-- class: "Reads still hold — A cannot SELECT B's chore, so this is not a read
-- leak." This probe is the counterexample, which is why it asserts A's
-- inability to SELECT B's meals FIRST: without that control, "A ended up with
-- B's ingredients" could just mean A could read them all along.
--
-- Judged on ROW COUNTS and on the strings that came back, not on exceptions:
-- a routine that refuses nothing simply succeeds.
--
-- NEGATIVE CONTROL, and it runs FIRST, before checks 2 and 5
-- ---------------------------------------------------------------------------
-- Checks 3 and 4 are read as row counts and strings, so they carry their own
-- attribution and 1 is their positive control. Checks 2 and 5 are not: each is
-- an INSERT that catches `insufficient_privilege` and credits a guard, and a
-- swallowed 42501 says nothing about WHICH thing said no.
--
-- MECHANISM: a TRIGGER, not RLS. The guard both of them name is
-- `public.reference_shares_family`, the BEFORE INSERT OR UPDATE OF <col>,
-- family_id trigger that raises errcode 42501 when the referenced row's
-- family_id differs from the new row's own. 0313 is the LAST migration to wire
-- it onto these two references, and the chain was checked the long way round
-- because the trigger NAMES are assembled at apply time ('trg_' || child || '_'
-- || col || '_family') and so appear literally in no migration at all, which
-- would make `grep -l trg_meal_plans_meal_id_family` a reassuring zero for the
-- wrong reason:
--   * `grep -rl reference_shares_family supabase/migrations` returns 0311 and
--     0313 and nothing else — only these two can create such a trigger;
--   * 0311 wires allowance_rules.child_wallet_id and
--     chore_assignments.{chore_id,member_id}, not these two, so 0313 is the
--     first AND the last to wire meal_plans.meal_id and grocery_items.list_id;
--   * no migration drops a `*_family` trigger on either table — the only
--     `drop trigger` statements naming them are 0311's and 0313's own
--     drop-then-create, and nothing after 0313 touches either table's triggers.
-- So the rule under test today is 0313's, as the trigger 0313 created, and not
-- a policy. This matters because replaying 0311 in one's head would credit a
-- guard that was never wired to this table.
--
-- RLS CANNOT be what refuses 2 or 5, and that is exactly why they need a
-- control rather than being self-evident. Both tables' write policies are
-- `is_family_member(family_id)` alone: 0004 created them for meal_plans and
-- grocery_items both, 0025 re-asserted grocery_items unchanged, and 0107
-- re-asserted both unchanged. 0107 is the LAST to touch either — 0118's drift
-- repair heals only a table with NO select policy (both have one), and 0275's
-- permissive-write sweep names the wallet and finance tables. Every row 2 and 5
-- attempt carries family_id = famA, and A IS a member of famA, so the policy
-- says yes to the breach attempt exactly as it says yes to the control. Only
-- the trigger is left to say no — or something that is not this boundary at all.
--
-- The one thing the trigger keys on is whether the REFERENCED row's family_id
-- matches the row's own. So the control is the same actor, the same two
-- statements, the same column lists, with that single answer the other way:
-- A's own meal under A's own plan, and A's own item on A's own list. Both must
-- land, and if either does not, this probe reports the boundary as UNPROVEN
-- rather than as holding.
--
-- WHAT IT WOULD CATCH. Without it, 2 and 5 keep passing — with 0313's family
-- scope loosened back out of `reference_shares_family` entirely — whenever
-- anything else on the path raises 42501:
--
--   * the bootstrap's `alter default privileges … grant all on tables to
--     authenticated` being revoked or narrowed on meal_plans or grocery_items;
--   * a column-level `revoke insert (meal_id) on public.meal_plans from
--     authenticated`, or `(list_id) on public.grocery_items`. This is why the
--     control names the SAME columns the writes under test name, and not a
--     convenient subset: Postgres checks column privileges against the column
--     LIST, not against the values, so a control that omitted meal_id or
--     list_id would sail straight past the revoke that kills 2 and 5;
--   * any unrelated guard trigger added to either table. This repository
--     refuses writes that way in 0223, 0305, 0326 and 0331, so it is not a
--     hypothetical, and such a trigger raises the same 42501 from a rule that
--     has nothing to do with family scope.
--
-- A dead `auth.uid()` is the one 42501 already attributed, by the
-- is_family_member checks below — it makes `is_family_member(famA)` false, and
-- that check raises before any of this. Noted so it is not covered twice.
--
-- The control's two rows do not outlive the control: they are deleted as the
-- trusted server immediately afterwards, so the 'pasta' count in 1, the
-- PRIVATE-% sweep in 3 and the listB count in 4 each still measure only what
-- they were written to measure. 6 remains as the closing control it always
-- was — that A's own list still works AFTER all the refusals — which is a
-- different question from whether this session could write at all BEFORE them.
\set ON_ERROR_STOP on
set client_min_messages = warning;

do $probe$
declare
  famA uuid := '00000000-0000-4000-8000-0000000c3a01';
  famB uuid := '00000000-0000-4000-8000-0000000c3b01';
  uA   uuid := '00000000-0000-4000-8000-0000000c3a0a';
  uB   uuid := '00000000-0000-4000-8000-0000000c3b0b';
  mealA uuid; mealB uuid; listA uuid; listB uuid;
  got uuid; n int; leaked text;
  failures int := 0;
  -- The negative control's own rows. No new anchor UUIDs are invented for it:
  -- it reuses famA, mealA and listA — the rows checks 2 and 5 already build on
  -- — and takes its two ids back from RETURNING, so there is nothing here that
  -- could collide with another probe's anchors on the one shared database
  -- run-probes.sh drives.
  ctlPlan uuid; ctlItem uuid;
  control_ok boolean := true;
  control_notes text[] := '{}';
begin
  delete from public.grocery_items where family_id in (famA, famB);
  delete from public.grocery_lists where family_id in (famA, famB);
  delete from public.meal_plans   where family_id in (famA, famB);
  delete from public.meals        where family_id in (famA, famB);

  insert into auth.users (id, email) values
    (uA, 'mealplan-a@example.com'), (uB, 'mealplan-b@example.com') on conflict (id) do nothing;
  insert into public.families (id, name, created_by) values
    (famA, 'Meal family A', uA), (famB, 'Meal family B', uB) on conflict (id) do nothing;
  insert into public.family_members (family_id, user_id, display_name, role, is_active) values
    (famA, uA, 'Parent A', 'parent', true),
    (famB, uB, 'Parent B', 'parent', true) on conflict do nothing;

  insert into public.meals (family_id, name, meal_type, ingredients) values
    (famA, 'A dinner', 'dinner', '[{"name":"pasta","qty":"1"}]'::jsonb) returning id into mealA;
  -- Ingredient names carry religious practice, allergies and medical supplies.
  -- These two stand in for that, and are distinctive enough to find by name.
  insert into public.meals (family_id, name, meal_type, ingredients) values
    (famB, 'B dinner', 'dinner',
     '[{"name":"PRIVATE-kosher-brisket","qty":"1"},{"name":"PRIVATE-insulin-syringes","qty":"2"}]'::jsonb)
    returning id into mealB;

  insert into public.meal_plans (family_id, meal_id, plan_date, meal_type)
    values (famA, mealA, current_date, 'dinner');

  insert into public.grocery_lists (family_id, name, created_by)
    values (famA, 'A list', uA) returning id into listA;
  insert into public.grocery_lists (family_id, name, created_by)
    values (famB, 'B private list', uB) returning id into listB;

  -- ── as family A's parent ─────────────────────────────────────────────────
  perform set_config('request.jwt.claim.sub', uA::text, true);
  set local role authenticated;

  if not public.is_family_member(famA) then
    raise exception 'CONTROL FAILED: not acting as a member of family A';
  end if;
  if public.is_family_member(famB) then
    raise exception 'CONTROL FAILED: acting as a member of family B, so nothing below is a boundary';
  end if;
  select count(*) into n from public.meals where id = mealB;
  if n <> 0 then
    raise exception 'CONTROL FAILED: A can already SELECT B''s meal, so a leak below would prove nothing';
  end if;

  -- ── 0. NEGATIVE CONTROL: same actor, same predicate, the other answer ─────
  --    The header sets out the mechanism (0313's `reference_shares_family`
  --    trigger) and what this catches. In short: checks 2 and 5 swallow a
  --    42501, and a 42501 is also what a revoked table GRANT, a column-level
  --    revoke on meal_id or list_id, and any unrelated guard trigger raise. So
  --    run the mirror of each first, as THIS session, with only the referenced
  --    row's family changed — A's own meal, A's own list — and require it to
  --    land. Naming the same columns is the load-bearing part.
  begin
    insert into public.meal_plans (family_id, meal_id, plan_date, meal_type)
      values (famA, mealA, current_date + 5, 'dinner')
      returning id into ctlPlan;
    get diagnostics n = row_count;
    -- `id` is a NOT NULL primary key, so a null one means no row was stored no
    -- matter what row_count reports. Both, because the control is the thing the
    -- rest of the probe is believed on.
    if n <> 1 or ctlPlan is null then
      control_ok := false;
      control_notes := array_append(control_notes,
        'this session stored 0 rows filing A''s OWN meal under A''s OWN plan, so 2''s refusal of B''s meal would prove nothing about reference_shares_family');
    end if;
  exception when others then
    control_ok := false;
    control_notes := array_append(control_notes, format(
      'this session was refused A''s OWN meal under A''s OWN plan (%s: %s) — 2''s refusal below is therefore not attributable to the family-scope guard, only to something saying no',
      sqlstate, sqlerrm));
  end;

  if control_ok then
    begin
      insert into public.grocery_items (family_id, list_id, name)
        values (famA, listA, 'control-own-list-own-family')
        returning id into ctlItem;
      get diagnostics n = row_count;
      if n <> 1 or ctlItem is null then
        control_ok := false;
        control_notes := array_append(control_notes,
          'this session stored 0 rows filing an item on A''s OWN list, so 5''s refusal of B''s list would prove nothing about reference_shares_family');
      end if;
    exception when others then
      control_ok := false;
      control_notes := array_append(control_notes, format(
        'this session was refused an item on A''s OWN list (%s: %s) — 5''s refusal below is therefore not attributable to the family-scope guard',
        sqlstate, sqlerrm));
    end;
  end if;

  -- The control's rows do not outlive the control. Removed as the trusted
  -- server so the cleanup cannot itself be refused and muddy the diagnosis;
  -- unconditional, because a stray plan inside the RPC's date range and a
  -- stray item on listA are exactly the quiet contamination that turns one
  -- unattributed check into one false failure further down.
  reset role;
  delete from public.grocery_items where id = ctlItem;
  delete from public.meal_plans    where id = ctlPlan;
  perform set_config('request.jwt.claim.sub', uA::text, true);
  set local role authenticated;

  -- A failed control makes 2 and 5 unreadable, and both of them swallow
  -- `insufficient_privilege` — so a broken session would sail through as a
  -- green probe. Say why the probe cannot speak, here, while the reason is
  -- still in hand. The boundary is reported neither as holding nor as broken:
  -- it is reported as unproven, and the build is red either way.
  if not control_ok then
    reset role;
    perform set_config('request.jwt.claim.sub', '', true);
    raise exception '0313 UNPROVEN (the negative control this probe rests on did not hold): %',
      array_to_string(control_notes, ' | ');
  end if;

  -- 1. The positive control. A's own meal plan still becomes A's own list,
  --    onto A's own list id. A guard that simply broke the RPC would fail here
  --    and every refusal below would mean nothing.
  begin
    select public.grocery_from_meal_plan(famA, current_date, current_date, listA) into got;
    if got is distinct from listA then
      raise warning 'CONTROL FAILED: the RPC did not use the caller''s own list (got %, wanted %)', got, listA;
      failures := failures + 1;
    end if;
    select count(*) into n from public.grocery_items where list_id = listA and name = 'pasta';
    if n <> 1 then
      raise warning 'CONTROL FAILED: A''s own ingredient did not reach A''s own list (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: the RPC refused the caller''s own family''s work (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  -- 2. A meal_plan under A may not point at B's meal. This is the door: 0313
  --    wires meal_plans.meal_id into 0311's reference guard.
  --    Attributable only because 0's first leg landed: the same INSERT, the
  --    same four columns, the same session, with mealA in place of mealB.
  begin
    insert into public.meal_plans (family_id, meal_id, plan_date, meal_type)
      values (famA, mealB, current_date + 1, 'dinner');
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a meal plan under A points at B''s meal (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 3. And even if such a row existed, the RPC must not read through it. The
  --    plant is made as the trusted server (which the guard exempts, the way a
  --    backfill is exempt), so this measures the FUNCTION rather than the
  --    trigger — the two halves of 0313 are asserted separately on purpose.
  reset role;
  perform set_config('request.jwt.claim.sub', '', true);
  insert into public.meal_plans (family_id, meal_id, plan_date, meal_type)
    values (famA, mealB, current_date + 2, 'dinner');

  perform set_config('request.jwt.claim.sub', uA::text, true);
  set local role authenticated;
  begin
    select public.grocery_from_meal_plan(famA, current_date, current_date + 7, listA) into got;
  exception when others then null;
  end;
  select string_agg(name, ', ') into leaked
    from public.grocery_items where family_id = famA and name like 'PRIVATE-%';
  if leaked is not null then
    raise warning 'BREACH: A read B''s meal ingredients off their own grocery list: %', leaked;
    failures := failures + 1;
  end if;

  -- 4. Nor may the caller write onto another family's list.
  begin
    select public.grocery_from_meal_plan(famA, current_date, current_date, listB) into got;
  exception when others then null;
  end;
  select count(*) into n from public.grocery_items where list_id = listB;
  if n > 0 then
    raise warning 'BREACH: % row(s) written onto family B''s private list', n;
    failures := failures + 1;
  end if;

  -- 5. A grocery item may not be filed onto another family's list directly
  --    either — the same reference, guarded at the table.
  --    Attributable only because 0's second leg landed: the same INSERT, the
  --    same three columns, the same session, with listA in place of listB.
  begin
    insert into public.grocery_items (family_id, list_id, name)
      values (famA, listB, 'planted');
    get diagnostics n = row_count;
    if n > 0 then
      raise warning 'BREACH: a grocery item under A sits on B''s list (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when insufficient_privilege then null;
  end;

  -- 6. Closing control: A's own list still works after all of the above, so
  --    none of these guards closed the feature.
  begin
    insert into public.grocery_items (family_id, list_id, name) values (famA, listA, 'milk');
    get diagnostics n = row_count;
    if n <> 1 then
      raise warning 'CONTROL FAILED: A could not add to their own list (rows: %)', n;
      failures := failures + 1;
    end if;
  exception when others then
    raise warning 'CONTROL FAILED: A could not add to their own list (% %)', sqlstate, sqlerrm;
    failures := failures + 1;
  end;

  reset role;
  perform set_config('request.jwt.claim.sub', '', true);

  if failures > 0 then
    raise exception '0313 FAILED: % assertion(s)', failures;
  end if;
  raise notice '0313 OK: this session CAN file A''s own meal under A''s own plan and an item on A''s own list (negative control, 2 legs), and the meal-plan grocery RPC stays inside one family (6 assertions)';
end
$probe$;

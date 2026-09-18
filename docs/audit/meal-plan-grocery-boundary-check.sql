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
  raise notice '0313 OK: the meal-plan grocery RPC stays inside one family (6 assertions)';
end
$probe$;

-- Bubaly :: 0313 - the meal-plan grocery RPC crossed a family boundary
--
-- `public.grocery_from_meal_plan(p_family_id, p_from, p_to, p_list_id)` from
-- 0005 is SECURITY DEFINER and `granted execute to authenticated`. It checks
-- `is_family_member(p_family_id)` on the way in — and then trusts everything
-- else it was handed.
--
-- Two things were not checked.
--
-- ── 1. the join ─────────────────────────────────────────────────────────────
--
--     from public.meal_plans mp
--     join public.meals m on m.id = mp.meal_id
--     where mp.family_id = p_family_id
--
-- The WHERE scopes the PLAN. Nothing scopes the MEAL. And 0311 established that
-- a member may write a row carrying their own family_id beside a reference into
-- somebody else's family, because every INSERT policy checks only the row's own
-- family_id and the foreign key names `parent(id)` alone.
--
-- So: plant a `meal_plans` row under your family pointing at another family's
-- meal, call the RPC, and it copies that meal's ingredient names onto your own
-- grocery list — where you can read them. Measured on a replayed database, as a
-- parent of A who is not a member of B and provably cannot SELECT B's meals:
--
--   control: A member of B?                                  f
--   control: rows A can SELECT from B's meals:               0
--   meal_plan under A pointing at B's meal:                  1 row
--   items A can now READ on their own list:  2 -> SECRET-kosher-brisket,
--                                                 SECRET-insulin-syringes
--
-- Ingredient lists are not trivia. They carry religious practice, allergies and
-- medical supplies.
--
-- 0311's header says of this class: "Reads still hold — A cannot SELECT B's
-- chore, so this is not a read leak. What it reaches is the code that ACTS on
-- the reference." This function is that code, and acting on it made it a read
-- leak after all. A SECURITY DEFINER routine is exactly where a plantable
-- reference stops being harmless, because it is the one place RLS is not
-- looking.
--
-- ── 2. the list ─────────────────────────────────────────────────────────────
--
-- `p_list_id` is used as given. Pass another family's list id and the rows land
-- on it. Measured: 2 rows, carrying family A's family_id, sitting on B's list.
-- B cannot see them (grocery_items RLS is family-scoped, so this is corruption
-- rather than an injection B would read), but they are on a list that is not
-- the caller's to write to.
--
-- ── the fix, at both levels ────────────────────────────────────────────────
--
-- The function stops trusting its arguments, AND the door that made the leak
-- reachable is closed at the table. Either alone would do it here; both is what
-- keeps the next SECURITY DEFINER reader of `meal_plans` honest.
--
-- 0311 said of its wiring that "the next reference costs one line". These are
-- the next two, added to the same validated loop with the same helper.

-- ── the function ────────────────────────────────────────────────────────────

create or replace function public.grocery_from_meal_plan(
  p_family_id uuid,
  p_from date,
  p_to date,
  p_list_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_list_id uuid := p_list_id;
  v_ing jsonb;
begin
  if not public.is_family_member(p_family_id) then
    raise exception 'Not a member of this family';
  end if;

  -- A list the caller named must be the caller's family's list. Checked before
  -- anything is written, so a bad id costs nothing.
  if v_list_id is not null
     and not exists (select 1 from public.grocery_lists
                      where id = v_list_id and family_id = p_family_id) then
    raise exception 'That list belongs to another family' using errcode = '42501';
  end if;

  if v_list_id is null then
    insert into public.grocery_lists (family_id, name, created_by)
    values (p_family_id, 'From meal plan ' || p_from || '–' || p_to, auth.uid())
    returning id into v_list_id;
  end if;

  for v_ing in
    select jsonb_array_elements(m.ingredients) as ing
    from public.meal_plans mp
    join public.meals m
      on m.id = mp.meal_id
     -- The line that was missing. Without it the WHERE below scopes the plan
     -- and nothing scopes the meal.
     and m.family_id = p_family_id
    where mp.family_id = p_family_id
      and mp.plan_date between p_from and p_to
      and m.ingredients is not null
  loop
    insert into public.grocery_items (family_id, list_id, name, quantity, created_by)
    values (p_family_id, v_list_id,
            coalesce(v_ing->>'name','item'), v_ing->>'qty', auth.uid());
  end loop;

  return v_list_id;
end;
$$;

comment on function public.grocery_from_meal_plan(uuid, date, date, uuid) is
  'Copies a date range of meal-plan ingredients onto a grocery list. SECURITY DEFINER, so it validates every id it is handed: the caller must be a member of p_family_id, p_list_id must belong to that family, and the meals it reads are scoped to that family (0313).';

-- ── the door ────────────────────────────────────────────────────────────────
--
-- Same helper, same validated loop as 0311. A table this database has not
-- reached yet is skipped; a mis-wiring raises here, at replay, rather than
-- silently installing a trigger that would fail 42703 on every authenticated
-- write in production.
do $$
declare
  w record;
begin
  for w in
    select *
    from (values
      ('meal_plans',    'meal_id', 'meals'),
      ('grocery_items', 'list_id', 'grocery_lists')
    ) as v(child, col, parent)
  loop
    if to_regclass('public.' || w.child) is null or to_regclass('public.' || w.parent) is null then
      continue;
    end if;

    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.child and column_name = 'family_id') then
      raise exception 'reference_shares_family: %.family_id does not exist', w.child;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.child and column_name = w.col) then
      raise exception 'reference_shares_family: %.% does not exist', w.child, w.col;
    end if;
    if not exists (select 1 from information_schema.columns
                    where table_schema = 'public' and table_name = w.parent and column_name = 'family_id') then
      raise exception
        'reference_shares_family: parent %.family_id does not exist, so the guard on %.% would raise 42703 on every authenticated write',
        w.parent, w.child, w.col;
    end if;

    execute format('drop trigger if exists %I on public.%I',
                   'trg_' || w.child || '_' || w.col || '_family', w.child);
    execute format(
      'create trigger %I before insert or update of %I, family_id on public.%I '
      || 'for each row execute function public.reference_shares_family(%L, %L)',
      'trg_' || w.child || '_' || w.col || '_family', w.col, w.child, w.col, w.parent);
  end loop;
end
$$;

-- ============================================================================
-- seed_chores_one_family.sql — 500+ chore_assignments for ONE family.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Re-asserts the family-scoped RLS policies on chores / chore_assignments /
--      rewards / reward_redemptions so authenticated members can read the seeded
--      rows (same drift fix as migrations 0105/0106). Safe + idempotent.
--   2. Ensures a small catalog of ~30 chore definitions (public.chores) exists,
--      each tagged in `instructions` = '[seed:chores]', with emoji icons,
--      recurrence (daily/weekly/monthly), points, priority and descriptions —
--      exactly what the Chores page renders.
--   3. Ensures a handful of rewards exist (the Chore Store + Rewards Progress).
--   4. Seeds 500 chore_assignments spread across every family member with a
--      realistic mix of statuses (todo / in_progress / submitted / approved /
--      done / rejected), due dates (overdue / today / this-week / upcoming /
--      none), recurrence cadence, points_awarded and approval timestamps —
--      enough to populate Daily/Weekly tables, Completed grid, Approvals queue,
--      Top Earners, Chore Streaks and Family Chore Points.
--
-- TARGET FAMILY: resolved reproducibly at runtime (v_email's family → first family
--   with a child → any). Was a hardcoded prod UUID that FK-failed off-prod. Change v_email if needed.
--
-- IDEMPOTENT: seeded chores are tagged in `instructions` = '[seed:chores]' and
--   their chores + assignments are deleted before re-insert (this family only);
--   rewards are created only if missing (matched by title).
--
-- SAFETY: never auto-runs against production. Paste into the Supabase SQL editor
--   and Run, or apply locally via `npm run db:seed:chores`.
--
-- HOW TO RUN: paste into the Supabase SQL editor and Run, then hard-refresh
--   /dashboard/chores.
-- ============================================================================

-- 1) RLS repair (so the page can READ the seeded rows) ------------------------
do $$
declare t text;
begin
  foreach t in array array['chores','chore_assignments','rewards','reward_redemptions'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %1$s_select on public.%1$I', t, t);
    execute format('create policy %1$s_select on public.%1$I for select using (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_insert on public.%1$I', t, t);
    execute format('create policy %1$s_insert on public.%1$I for insert with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_update on public.%1$I', t, t);
    execute format('create policy %1$s_update on public.%1$I for update using (public.is_family_member(family_id)) with check (public.is_family_member(family_id))', t, t);
    execute format('drop policy if exists %1$s_delete on public.%1$I', t, t);
    execute format('create policy %1$s_delete on public.%1$I for delete using (public.is_family_member(family_id))', t, t);
  end loop;
end $$;

-- 2) + 3) + 4) Chore catalog, rewards, and 500 assignments --------------------
do $$
declare
  v_fam    uuid;   -- resolved reproducibly below (was a hardcoded prod UUID)
  v_email  text := 'newworldventurellc@gmail.com';
  v_uid    uuid;
  v_self   uuid;
  v_members uuid[];
  v_nmem   int;
  v_chores uuid[] := '{}';
  v_recur  text[] := '{}';   -- parallel to v_chores: recurrence of each chore
  v_pts    int[]  := '{}';   -- parallel to v_chores: points of each chore
  v_id     uuid;
  i        int;
  ci       int;              -- chore index for this assignment
  v_rec    text;
  v_points int;
  v_status text;
  v_member uuid;
  v_due    date;
  v_sub    timestamptz;
  v_app    timestamptz;
  v_appby  uuid;
  v_award  int;
  seeded   int := 0;

  -- Chore catalog: icon | title | description | points | recurrence | priority
  c_icon  text[] := ARRAY['🛏️','🍽️','🗑️','📖','🐾','🪥','🧹','🍴','🧺','🪴','🚿','🪶','🍳','🚗','🌱','🛒','📚','🧸','♻️','🧽','🛁','🧦','🪟','🛋️','📬','🗄️','🌡️','🔌','🥣','🧴'];
  c_title text[] := ARRAY[
    'Make Bed','Clean Dishes','Take Out Trash','Homework Time','Feed the Dog','Brush Teeth',
    'Vacuum Living Room','Set the Table','Laundry','Water Plants','Clean Bathroom','Dust Shelves',
    'Help Cook Dinner','Wash the Car','Mow the Lawn','Grocery Shopping','Read 20 Minutes','Tidy Toys',
    'Sort Recycling','Wipe Counters','Clean the Tub','Match the Socks','Clean Windows','Fluff Cushions',
    'Get the Mail','Organize Drawer','Change Air Filter','Charge Devices','Refill Cereal','Refill Soap'];
  c_desc  text[] := ARRAY[
    'Make your bed and tidy up','Load or unload the dishwasher','Take the trash to the curb','Complete 30 min of homework','Give Buddy his food and water','Brush for two minutes',
    'Vacuum floors and rug','Set the table for dinner','Wash, dry, and fold clothes','Water all indoor plants','Scrub sink and mirror','Dust the living-room shelves',
    'Help prep and cook dinner','Wash and dry the car','Mow the front and back lawn','Pick up the weekly groceries','Read a book for 20 minutes','Put all toys back in the bin',
    'Sort recycling into bins','Wipe down the kitchen counters','Scrub the bathtub','Fold and match the laundry socks','Clean the inside windows','Fluff and arrange the couch cushions',
    'Bring in the mail','Organize the junk drawer','Replace the HVAC air filter','Plug in all family devices','Refill the cereal containers','Refill the hand soap dispensers'];
  c_rec   text[] := ARRAY[
    'daily','daily','daily','daily','daily','daily',
    'weekly','weekly','weekly','weekly','weekly','weekly',
    'daily','weekly','weekly','weekly','daily','daily',
    'weekly','daily','weekly','weekly','monthly','weekly',
    'daily','monthly','monthly','daily','weekly','weekly'];
  c_pts   int[] := ARRAY[
    10,15,10,20,10,5,
    25,15,30,10,20,15,
    20,40,50,35,15,10,
    15,10,25,15,20,10,
    5,20,30,5,10,10];
  c_prio  text[] := ARRAY[
    'medium','high','medium','high','medium','low',
    'medium','medium','high','low','medium','low',
    'medium','low','medium','high','medium','low',
    'low','medium','medium','low','low','low',
    'low','low','medium','low','low','low'];

  -- Reward catalog for the Chore Store + Rewards Progress.
  r_title text[] := ARRAY['Ice Cream Trip','Extra Screen Time','Pizza Night','Movie Night','Choose Dinner','New Toy','Stay Up Late','Day Out'];
  r_desc  text[] := ARRAY['A scoop (or two) of your favorite','30 extra minutes of screen time','Family pizza night, your pick','Movie night with popcorn','Pick what the family eats','Pick out a new toy','Stay up 30 minutes past bedtime','A special day out of your choice'];
  r_cost  int[]  := ARRAY[50,75,150,200,120,500,100,400];
begin
  select id into v_uid  from auth.users where lower(email) = lower(v_email) limit 1;
  -- Resolve the target family reproducibly (was a hardcoded prod UUID): the seed
  -- account's family, else the first family with a non-manager member, else any.
  select f.id into v_fam from public.families f where f.created_by = v_uid order by f.created_at limit 1;
  if v_fam is null then
    select fm.family_id into v_fam from public.family_members fm
      where fm.is_active and fm.role not in ('parent','adult')
      group by fm.family_id order by min(fm.created_at) limit 1;
  end if;
  if v_fam is null then select id into v_fam from public.families order by created_at limit 1; end if;
  if v_fam is null then raise notice 'chores seed: no family found — skipping.'; return; end if;
  select id into v_self from public.family_members where family_id = v_fam and user_id = v_uid and is_active limit 1;
  select array_agg(id) into v_members from public.family_members where family_id = v_fam and is_active;
  if v_members is null then
    raise exception 'No active members for family %', v_fam;
  end if;
  v_nmem := array_length(v_members, 1);

  -- Clean previously seeded chores (+ their assignments) for THIS family only.
  delete from public.chore_assignments where family_id = v_fam
    and chore_id in (select id from public.chores where family_id = v_fam and instructions = '[seed:chores]');
  delete from public.chores where family_id = v_fam and instructions = '[seed:chores]';

  -- Ensure the reward catalog exists (create only if missing, matched by title).
  for i in 1..array_length(r_title,1) loop
    if not exists (select 1 from public.rewards where family_id = v_fam and title = r_title[i]) then
      -- created_by references auth.users(id) → use the signed-in user (nullable).
      insert into public.rewards (family_id, title, description, cost_points, created_by)
      values (v_fam, r_title[i], r_desc[i], r_cost[i], v_uid);
    end if;
  end loop;

  -- Insert the chore catalog; collect ids + recurrence + points in parallel arrays.
  for i in 1..array_length(c_title,1) loop
    insert into public.chores
      (family_id, title, description, points, priority, recurrence, icon, requires_approval, instructions, created_by)
    values
      (v_fam, c_title[i], c_desc[i], c_pts[i], c_prio[i]::public.priority, c_rec[i]::public.recurrence_freq,
       c_icon[i], true, '[seed:chores]', v_uid)  -- created_by → auth.users(id)
    returning id into v_id;
    v_chores := array_append(v_chores, v_id);
    v_recur  := array_append(v_recur, c_rec[i]);
    v_pts    := array_append(v_pts, c_pts[i]);
  end loop;

  -- Seed 500 assignments across all members with a realistic status spread.
  for i in 1..500 loop
    ci       := 1 + (i % array_length(v_chores,1));
    v_id     := v_chores[ci];
    v_rec    := v_recur[ci];
    v_points := v_pts[ci];
    v_member := v_members[1 + (i % v_nmem)];

    -- Status distribution (~35% completed, 10% submitted, 15% in-progress,
    -- 5% rejected, 35% todo) — covers every tab + widget.
    case
      when (i % 20) < 6 then v_status := 'approved';   -- 30%
      when (i % 20) = 6 then v_status := 'done';       -- 5%
      when (i % 20) in (7,8) then v_status := 'submitted';   -- 10%
      when (i % 20) in (9,10,11) then v_status := 'in_progress'; -- 15%
      when (i % 20) = 12 then v_status := 'rejected';  -- 5%
      else v_status := 'todo';                         -- 35%
    end case;

    -- Due-date spread.
    case (i % 10)
      when 0,1 then v_due := current_date - (1 + (i % 9));    -- overdue
      when 2,3 then v_due := current_date;                    -- today
      when 4,5 then v_due := current_date + (1 + (i % 6));    -- this week
      when 6   then v_due := null;                            -- no due date
      else        v_due := current_date + (7 + (i % 40));     -- upcoming
    end case;

    v_sub   := null; v_app := null; v_appby := null; v_award := null;

    if v_status in ('approved','done') then
      -- Approved recently, clustered over the last ~14 days so streaks + the
      -- weekly leaderboard have consecutive-day coverage per member.
      v_app   := (current_date - ((i / v_nmem) % 14) * interval '1 day') + interval '17 hours';
      v_sub   := v_app - interval '2 hours';
      v_appby := coalesce(v_self, v_members[1]);
      v_award := v_points;
      v_due   := (v_app)::date;
    elsif v_status = 'submitted' then
      v_sub := now() - ((i % 6) * interval '1 hour');
      v_due := current_date;
    elsif v_status = 'rejected' then
      v_sub := now() - ((1 + (i % 3)) * interval '1 day');
    end if;

    insert into public.chore_assignments
      (family_id, chore_id, member_id, status, due_at, submitted_at, approved_at, approved_by, points_awarded)
    values
      (v_fam, v_id, v_member, v_status::public.task_status,
       case when v_due is null then null else (v_due::timestamptz + interval '18 hours') end,
       v_sub, v_app, v_appby, v_award);
    seeded := seeded + 1;
  end loop;

  raise notice 'Seeded % chore_assignments across % chores / % members for family %.',
    seeded, array_length(v_chores,1), v_nmem, v_fam;
end $$;

-- 5) Verify the spread --------------------------------------------------------
select
  count(*)                                              as total,
  count(*) filter (where status = 'todo')               as todo,
  count(*) filter (where status = 'in_progress')        as in_progress,
  count(*) filter (where status = 'submitted')          as submitted,
  count(*) filter (where status in ('approved','done')) as completed,
  count(*) filter (where status = 'rejected')           as rejected,
  count(*) filter (where due_at::date < current_date and status not in ('approved','done')) as overdue,
  coalesce(sum(points_awarded), 0)                      as points_awarded
from public.chore_assignments
where chore_id in (select id from public.chores where instructions = '[seed:chores]');

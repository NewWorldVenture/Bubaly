-- ============================================================================
-- seed_family_one_family.sql — 500 family_members for ONE family, so the new
-- Family hub page (/dashboard/family) can be tested at scale.
-- ----------------------------------------------------------------------------
-- WHAT IT DOES
--   1. Folds in migration 0110 (adds families.cover_url/address/family_code and
--      family_members.email/phone/avatar_url) so this seed runs standalone.
--   2. Re-asserts family-scoped RLS on families + family_members (drift guard).
--   3. Sets the TARGET family's profile (name/address/timezone/cover/code) so
--      the Family Info card + cover render.
--   4. Seeds 500 family_members covering every role (parent/adult/teen/child/
--      caregiver/guest), a wide range of birthdays (infants → seniors, plus some
--      NULL), active AND archived (is_active) rows, emails/phones (some NULL),
--      and varied avatar colors — driving the member grid, member count,
--      "Upcoming Birthdays", and the role badges (Admin / Adult / Kid Account).
--
-- TABLES TOUCHED: public.families (profile fields), public.family_members (500).
--
-- TARGET FAMILY: resolved reproducibly at runtime.
--   newworldventurellc@gmail.com). Change v_fam below if needed.
--
-- IDEMPOTENT: seeded members carry an email like 'seed+<n>@bubaly.test'. The
--   block deletes those (for THIS family) before re-inserting — re-running
--   yields the same 500 rows. (Real members are never touched.)
--
-- SAFETY: scoped to one family; never auto-runs. This intentionally makes the
--   test family LARGE (500 members) to exercise the grid + "View all" + count.
--   Do NOT run against a family you don't want populated.
--
-- HOW TO RUN: paste into the Supabase SQL editor and Run, then hard-refresh
--   /dashboard/family. Verify with the SELECT at the bottom.
-- ============================================================================

-- 0) Self-contained schema safeguard (folds in migration 0110) ----------------
alter table public.families        add column if not exists cover_url   text;
alter table public.families        add column if not exists address     text;
alter table public.families        add column if not exists family_code text;
alter table public.family_members  add column if not exists email       text;
alter table public.family_members  add column if not exists phone       text;
alter table public.family_members  add column if not exists avatar_url  text;

-- 1) RLS safeguard ------------------------------------------------------------
alter table public.families enable row level security;
drop policy if exists families_select on public.families;
create policy families_select on public.families for select using (public.is_family_member(id));
alter table public.family_members enable row level security;
drop policy if exists fm_select on public.family_members;
create policy fm_select on public.family_members for select using (public.is_family_member(family_id));

-- 2) + 3) + 4) Family profile + 500 members -----------------------------------
do $$
declare
  v_fam uuid := coalesce((select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1),(select fm.family_id from public.family_members fm where fm.is_active and fm.role not in ('parent','adult') group by fm.family_id order by min(fm.created_at) limit 1),(select id from public.families order by created_at limit 1));  -- reproducible (was a hardcoded prod UUID)
  i int;  seeded int := 0;
  v_role public.member_role;  v_name text;  v_bday date;  v_active boolean;
  v_email text;  v_phone text;  v_color text;

  firsts text[] := ARRAY['Emma','Liam','Olivia','Noah','Ava','Ethan','Sophia','Mason','Isabella','Lucas','Mia','Jackson','Amelia','Aiden','Harper','Elijah','Evelyn','James','Abigail','Benjamin','Ella','Henry','Scarlett','Alexander','Grace','Michael','Chloe','Daniel','Lily','Jacob','Nora','Logan','Zoe','Sarah','Jordan','Maya','David','Aria','Carter','Riley'];
  lasts  text[] := ARRAY['Parker','Kramer','Johnson','Rivera','Nguyen','Patel','Garcia','Smith','Lee','Brown','Martinez','Davis','Lopez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','White'];
  colors text[] := ARRAY['#6366f1','#ec4899','#f59e0b','#10b981','#3b82f6','#8b5cf6','#ef4444','#14b8a6','#f97316','#0ea5e9'];
  roles  public.member_role[] := ARRAY['parent','adult','teen','child','caregiver','guest']::public.member_role[];
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;

  -- Family profile (only fills blanks / sets a demo cover so the page renders).
  update public.families
     set address    = coalesce(address, '123 Family Way, Austin, TX 78701'),
         timezone   = case when timezone is null or timezone = 'UTC' then 'America/Chicago' else timezone end,
         cover_url  = coalesce(cover_url, 'https://picsum.photos/seed/bubaly-family-cover/1200/500'),
         family_code = coalesce(family_code,
           upper(coalesce(nullif(regexp_replace(left(name,3),'[^A-Za-z]','','g'),''),'FAM')) || '-' || upper(substr(md5(id::text),1,4)))
   where id = v_fam;

  -- Idempotent cleanup of previously seeded members (this family only).
  delete from public.family_members where family_id = v_fam and email like 'seed+%@bubaly.test';

  for i in 1..500 loop
    v_role := roles[1 + (i % 6)];

    -- Birthday by role (with a slice of NULLs to cover the optional field).
    if i % 13 = 0 then
      v_bday := null;
    else
      v_bday := (current_date - (
        case v_role
          when 'child'     then (365 * (1  + (i % 12)))            -- 1–12 yrs
          when 'teen'      then (365 * (13 + (i % 5)))             -- 13–17
          when 'parent'    then (365 * (30 + (i % 25)))            -- 30–54
          when 'adult'     then (365 * (22 + (i % 40)))            -- 22–61
          when 'caregiver' then (365 * (28 + (i % 38)))            -- 28–65
          else                  (365 * (18 + (i % 55)))           -- guest 18–72
        end + (i % 365)))::date;
    end if;

    v_name   := firsts[1 + (i % array_length(firsts,1))] || ' ' || lasts[1 + ((i / 7) % array_length(lasts,1))];
    v_active := (i % 10 <> 0);                       -- ~10% archived
    v_email  := 'seed+' || i || '@bubaly.test';      -- sentinel (idempotency)
    v_phone  := case when i % 7 = 0 then null         -- ~14% NULL phone
                     else '(512) 555-' || lpad(((i * 37) % 10000)::text, 4, '0') end;
    v_color  := colors[1 + (i % array_length(colors,1))];

    insert into public.family_members
      (family_id, user_id, role, display_name, color, birthday, email, phone, avatar_url, is_active)
    values
      (v_fam, null, v_role, v_name, v_color, v_bday, v_email, v_phone, null, v_active);
    seeded := seeded + 1;
  end loop;

  raise notice 'Seeded % family_members for family %.', seeded, v_fam;
end $$;

-- 5) Verify -------------------------------------------------------------------
select
  count(*)                                     as total,
  count(*) filter (where is_active)            as active,
  count(*) filter (where not is_active)        as archived,
  count(*) filter (where role = 'parent')      as parents,
  count(*) filter (where role = 'child')       as kids,
  count(*) filter (where birthday is null)     as no_birthday,
  count(*) filter (where phone is null)        as no_phone
from public.family_members
where family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1) and email like 'seed+%@bubaly.test';

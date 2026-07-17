-- ============================================================================
-- seed_roles_one_family.sql — 500 family_members to fully test #8 role-tailored
-- surfaces. Role-tailored Home (greeting + "Focus now" strip) is driven entirely
-- by family_members.role, so this seeds members across ALL SIX roles
-- (parent/adult/caregiver/teen/child/guest) with realistic ages + colors.
--
-- TARGET: The Kramer Family (92298eb2-…). IDEMPOTENT: seeded rows are tagged by
-- a 'seed-role8-…@example.invalid' email and deleted before re-insert (this
-- family only). These are roster members (user_id NULL — not sign-in users).
--
-- HOW TO RUN: paste into the Supabase SQL editor and Run. Section 2 (below the
-- block) actually PREVIEWS #8 by flipping your own member's role — that's the
-- visual test, since the tailoring reflects the *signed-in* user's role.
-- ============================================================================

do $$
declare
  v_fam uuid := coalesce((select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1),(select fm.family_id from public.family_members fm where fm.is_active and fm.role not in ('parent','adult') group by fm.family_id order by min(fm.created_at) limit 1),(select id from public.families order by created_at limit 1));  -- reproducible (was a hardcoded prod UUID)
  roles   public.member_role[] := array['parent','adult','caregiver','teen','child','guest']::public.member_role[];
  firsts  text[] := array['Ava','Liam','Mia','Noah','Emma','Ethan','Olivia','Lucas','Sophia','Mason','Isla','Leo','Nora','Kai','Ruby','Max','Ivy','Owen','Zoe','Finn'];
  lasts   text[] := array['Kramer','Rivera','Chen','Patel','Okafor','Nguyen','Silva','Brooks','Haddad','Novak'];
  colors  text[] := array['#7c5cff','#22c55e','#3b82f6','#f59e0b','#ec4899','#06b6d4','#a855f7','#ef4444','#14b8a6','#f97316'];
  v_role  public.member_role;  v_age int;  v_i int;  seeded int := 0;
begin
  if not exists (select 1 from public.families where id = v_fam) then
    raise exception 'Family % not found', v_fam;
  end if;

  -- Clean prior seed rows (this family only).
  delete from public.family_members
    where family_id = v_fam and email like 'seed-role8-%@example.invalid';

  for v_i in 1..500 loop
    v_role := roles[1 + (v_i % 6)];
    v_age := case v_role
      when 'child'  then 4  + (v_i % 9)    -- 4–12
      when 'teen'   then 13 + (v_i % 5)    -- 13–17
      when 'guest'  then 18 + (v_i % 53)   -- 18–70
      else               28 + (v_i % 28)   -- 28–55 (parent/adult/caregiver)
    end;

    insert into public.family_members
      (family_id, user_id, role, display_name, color, birthday, email, is_active)
    values (
      v_fam, null, v_role,
      firsts[1 + (v_i % array_length(firsts,1))] || ' ' || lasts[1 + (v_i % array_length(lasts,1))],
      colors[1 + (v_i % array_length(colors,1))],
      (current_date - (v_age * interval '1 year'))::date,
      'seed-role8-' || v_i || '@example.invalid',
      true
    );
    seeded := seeded + 1;
  end loop;

  raise notice 'Seeded % family_members across 6 roles for family %.', seeded, v_fam;
end $$;

-- Verify the distribution (≈83 per role, 500 total).
select role, count(*) as members
from public.family_members
where family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1)
  and email like 'seed-role8-%@example.invalid'
group by role order by members desc;

-- ── PREVIEW #8 (the real visual test) ───────────────────────────────────────
-- The Home greeting + Focus strip tailor to the SIGNED-IN user's role, so flip
-- your own member's role, reload /home, and watch it change:
--   parent → "Good evening, …" (formal) · teen → "Evening, …" (casual)
--   child  → "Hey …! 🌙" (playful) + a shorter Focus set.
-- Change 'child' to any of parent/adult/caregiver/teen/child/guest, then revert.
--
-- update public.family_members set role = 'child'
--   where family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1)
--     and user_id = (select id from auth.users where lower(email) = 'newworldventurellc@gmail.com');

-- ── CLEANUP (remove the 500 roster rows when done) ──────────────────────────
-- delete from public.family_members
--   where family_id = (select f.id from public.families f join auth.users u on u.id=f.created_by where lower(u.email)=lower('newworldventurellc@gmail.com') order by f.created_at limit 1)
--     and email like 'seed-role8-%@example.invalid';

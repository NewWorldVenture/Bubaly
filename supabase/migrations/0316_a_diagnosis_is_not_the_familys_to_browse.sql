-- A diagnosis is not the family's to browse.
--
-- `medical_profiles` (0009) holds one row per member: blood type, allergies,
-- conditions, current medications, primary physician, preferred pharmacy and
-- its phone number, the three emergency-contact columns, immunisation notes and
-- free-text dental/general notes.
--
-- 0009 created the policies in a loop over three tables, under this header:
--
--     -- RLS — everyone in the family can READ; only parents/adults can WRITE.
--     -- This is what enforces "children view their own info read-only" at the
--     -- database boundary (can_manage_family => role in parent/adult).
--
-- Those two sentences describe different rules. "Children view their own info"
-- is the boundary the product states; "everyone in the family can READ" is the
-- policy that was actually created, and it is the one that reached the
-- database: `Members can read medical_profiles` is `is_family_member(family_id)`,
-- so every member of the household — teen, child, caregiver, guest — selects
-- every row. The comment reads as though the write half carried the read half
-- too, and it never did.
--
-- Three more places in the product state the manager gate, all of them sitting
-- in front of this same table:
--
--   app/(app)/dashboard/family-health/page.tsx:32     reads only `if (manager)`
--   app/(app)/dashboard/family-emergency/page.tsx:31  reads only `if (manager)`
--   app/api/ai/pantry-chef/route.ts:129               "medical_profiles is
--     manager-gated to clients" — the stated reason that route reaches for the
--     service client instead of the caller's
--
-- A server component that declines to read is not a boundary. A child is a real
-- Supabase auth user, so a child's session reaches PostgREST with the anon key
-- and this policy is the only thing between them and the row. They do not even
-- need to leave the app: components/modules/medical-records-module.tsx:78
-- selects `*` for the whole family and renders a card per member, gating only
-- the edit pencil on `isManager(role)`.
--
-- After this migration the policy says what 0009's second sentence said. A
-- manager reads the family's profiles; everybody else reads their own.
--
-- Left family-wide on purpose, and not an oversight: `health_providers` and
-- `insurance_policies`, the other two tables in 0009's loop. Those hold the
-- household's clinicians and its insurance cards — shared administrative
-- artifacts rather than one person's medical history. `medications` and
-- `symptom_logs` carry the same per-member shape as this table and the same
-- family-wide SELECT; they have server-side readers (lib/server/notifications.ts,
-- lib/autopilot/scan.ts) and their own module surfaces, so they are a separate
-- change with its own probe rather than a rider on this one.

-- ── The one column that cannot narrow ────────────────────────────────────────
-- `allergies` is not private in the same way. It is a safety input, and two
-- services read it for the WHOLE family on behalf of whoever is planning:
--
--   lib/services/groceries/index.ts  — substitutions on a generated list
--   lib/services/meals/index.ts      — foodProfile(), the meal planner
--
-- Both reach the table through `scope.db`, and `scopeFromUserContext` fills
-- that with the CALLER's client, not a service client. Both are therefore
-- subject to this policy.
--
-- The groceries read is explicitly fail-closed, and says why:
--
--     FAIL CLOSED. A read that errors here is not "no allergies"; putting
--     peanut butter on the list because `medical_profiles` was unreachable is
--     exactly the failure this rule exists to prevent.
--
-- It checks `profilesRes.error`. But RLS does not error — it returns fewer
-- rows. Narrowing the policy without moving these two readers would hand a
-- child `{ data: [], error: null }`: the guard passes, and the planner
-- concludes the household has no allergies. That is the peanut butter, reached
-- by the one route the comment did not cover.
--
-- lib/ai/context/policy.ts:53 already records the shape this needs —
--
--     { table: 'medical_profiles', reason: 'conditions, physicians, emergency
--       contacts', except: 'allergies column via services/meals foodProfile' }
--
-- — so `allergies` gets a door of its own: a function that returns
-- (member_id, allergies) and nothing else, to any member of that family.

create or replace function public.family_allergies(p_family_id uuid)
returns table (member_id uuid, allergies text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  -- A definer function runs with the owner's rights, so membership is checked
  -- HERE or it is not checked at all.
  --
  -- It RAISES rather than returning zero rows, and that is the point. Both
  -- callers treat a short read as "no allergies", so the not-a-member case has
  -- to arrive as an error for their fail-closed guards to fire at all. That
  -- makes this strictly safer than the direct select it replaces, which
  -- answered a non-member with `{ data: [], error: null }`.
  --
  -- THE SERVICE ROLE IS EXEMPT, and it is not a loophole. The AI executor runs
  -- every tool with the SERVICE client — lib/ai/runs/executor.ts builds its
  -- `ServiceScope` from `createServiceClient()` — so on that path `auth.uid()`
  -- is null and there is no membership to find. The service role bypasses RLS
  -- on `medical_profiles` itself and on every other table these services read;
  -- refusing it HERE would be the anomaly rather than the safeguard. Learned
  -- the hard way: without this branch, `groceries.addFromMealPlan` inside the
  -- concierge loop answered "You don't have permission to do that", and the
  -- probe that was supposed to cover this function only ever exercised
  -- `authenticated` sessions.
  --
  -- Seven migrations in this repo detect the service role with
  -- `current_user = 'service_role' or coalesce(auth.role(),'') = 'service_role'`.
  -- The first half of that pair is NOT copied here: those are trigger
  -- functions, where `current_user` is the caller, and this is SECURITY
  -- DEFINER, where `current_user` is the OWNER and the test can never be true.
  -- An idiom lifted from a neighbouring migration is not automatically right.
  -- `current_setting('role')` is what SET ROLE leaves behind and survives
  -- SECURITY DEFINER, so it stands in for that half.
  if coalesce(auth.role(), '') <> 'service_role'
     and coalesce(current_setting('role', true), '') <> 'service_role'
     and not public.is_family_member(p_family_id) then
    raise exception 'not a member of this family' using errcode = '42501';
  end if;

  return query
    select mp.member_id, mp.allergies
    from public.medical_profiles mp
    where mp.family_id = p_family_id;
end;
$$;

-- Supabase's default privileges grant EXECUTE on every new function straight to
-- anon and authenticated, so the grant below is a narrowing, not an addition.
-- `anon` has no `auth.uid()` and would only ever hit the raise above, but a
-- function over medical data should not be callable without a session at all.
revoke all on function public.family_allergies(uuid) from public;
revoke all on function public.family_allergies(uuid) from anon;
grant execute on function public.family_allergies(uuid) to authenticated, service_role;

-- ── The read policy ──────────────────────────────────────────────────────────
drop policy if exists "Members can read medical_profiles" on public.medical_profiles;
drop policy if exists "Members read their own medical_profiles" on public.medical_profiles;

create policy "Members read their own medical_profiles"
  on public.medical_profiles
  for select to authenticated
  using (
    public.is_family_member(family_id)
    and (
      public.can_manage_family(family_id)
      or public.is_self_member(member_id)
    )
  );

-- `is_family_member(family_id)` stays as the outer term even though
-- `can_manage_family` implies it. `is_self_member` checks only that the member
-- row is mine; it says nothing about the profile row's `family_id`, which is a
-- separate column. Keeping both means a row that paired my member_id with
-- another household's family_id would still be refused.

-- ── Sweep by shape ───────────────────────────────────────────────────────────
-- Permissive policies are OR'd. A single leftover SELECT policy on this table
-- restores the family-wide read and nothing would say so, which is how the
-- rule above could be true and the boundary still open. Assert there is exactly
-- one, by shape rather than by remembering the names 0009 used.
do $$
declare
  stray text;
begin
  select string_agg(polname, ', ' order by polname)
    into stray
  from pg_policy
  where polrelid = 'public.medical_profiles'::regclass
    and polcmd = 'r'
    and polname <> 'Members read their own medical_profiles';

  if stray is not null then
    raise exception
      'medical_profiles still carries a second SELECT policy, which ORs the narrowing away: %',
      stray;
  end if;
end $$;
